/**
 * lib/kb-worker-client.js — main-thread proxy for kb-worker.js.
 *
 * Created ONCE per daemon process (see http-daemon.js), never per session/call.
 * Exposes storeClient/metricsClient/indexClient/graphClient objects that mirror
 * brain-store.js's, metrics-store.js's, brain-index.js's and brain-graph.js's
 * public method names, so mcp-server.js's getKB() swaps in this client with no
 * other call-site changes. Each method is a message
 * round-trip to kb-worker.js, correlated by an incrementing id — the ordering
 * guarantee mcp-server.js's withLock relies on (getKB(project)→ops atomic) is
 * preserved because messages are sent in call order and the worker processes
 * its mailbox one message at a time.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_METHODS = [
  'init', 'save', 'get', 'getRaw', 'merge', 'prune', 'search', 'searchByKeywords',
  'searchIsolated', 'delete', 'list', 'count', 'close', 'listWithVectors',
  'setRecurrence', 'applyConsolidation', 'getVector', 'deleteVector',
  'getStorageType', 'getStatus', 'cosineSimilarity', 'recordCitation', 'citationMultiplier',
];

const METRICS_METHODS = [
  'init', 'isReady', 'close', 'recordMetric', 'getEventLog', 'getEventLogIsolated',
  'getEvaluationCounts', 'getEvaluationCountsIsolated', 'getMetricsSummary',
  'cleanupMetrics', 'listProjects',
];

const INDEX_METHODS = ['init', 'index', 'deindex', 'lookup', 'search', 'clear', 'getStatus'];

const GRAPH_METHODS = [
  'init', 'registerNode', 'unregisterNode', 'addEdge', 'removeEdge',
  'getRelated', 'getCites', 'getCitedBy', 'clear', 'getStatus',
];

export function createKbWorkerClient({ pluginRoot, callTimeoutMs = 30000 }) {
  const worker = new Worker(path.join(__dirname, 'kb-worker.js'), { workerData: { pluginRoot } });
  const pending = new Map();
  let nextId = 1;
  let dead = null; // Error once the worker has exited — new calls fail loud instead of hanging.

  // settle() é o único ponto que remove de `pending` — por isso é também o
  // único ponto que precisa reavaliar ref/unref quando a fila esvazia.
  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (pending.size === 0) worker.unref();
    fn(p);
  }

  worker.on('message', (msg) => {
    settle(msg.id, (p) => { if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error)); });
  });
  worker.on('error', (err) => {
    dead = err;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
    worker.unref();
  });
  worker.on('exit', (code) => {
    if (!dead) dead = new Error(`kb-worker exited unexpectedly (code ${code})`);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(dead); }
    pending.clear();
    worker.unref(); // simétrico ao handler 'error' acima — inofensivo (o handle já morreu), só remove a ambiguidade de leitura
  });
  // Sem handle referenciado, o worker por si só nunca segura o processo vivo —
  // correto para o daemon (http-daemon.js's httpServer já faz esse papel) mas é
  // uma armadilha para qualquer script standalone (ex.: teste isolado) que só
  // dê `await client.storeClient.init(...)`: sem NENHUM outro handle ativo, o
  // processo Node pode terminar (exit 0, sem erro) ANTES da resposta chegar,
  // silenciosamente. call() abaixo faz `worker.ref()` enquanto há chamadas
  // pendentes e settle() acima faz `worker.unref()` quando a fila esvazia —
  // então o processo fica vivo exatamente durante o round-trip de uma chamada
  // em voo, sem precisar de infraestrutura de teste especial nem mudar o
  // comportamento em produção (que sempre tem outro handle ref'd).
  worker.unref();

  // Without this, a framing bug (worker replies with a wrong/missing id, or never
  // replies) leaves the promise in `pending` forever — the caller (withLock) hangs
  // that one HTTP session indefinitely instead of failing loud. Timer is unref'd so
  // it never keeps the process alive on its own, same rationale as worker.unref().
  function call(mod, method, args) {
    if (dead) return Promise.reject(dead);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, () => reject(new Error(`kb-worker call timed out after ${callTimeoutMs}ms (${mod}.${method})`)));
      }, callTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      worker.ref(); // ver comentário em worker.unref() acima: mantém o processo vivo com chamada em voo
      worker.postMessage({ id, mod, method, args });
    });
  }

  function makeClient(mod, methods) {
    const client = {};
    for (const method of methods) client[method] = (...args) => call(mod, method, args);
    return client;
  }

  async function shutdown() {
    dead = dead || new Error('kb-worker shutting down');
    for (const [, p] of pending) p.reject(dead);
    pending.clear();
    await worker.terminate();
  }

  return {
    storeClient: makeClient('store', STORE_METHODS),
    metricsClient: makeClient('metrics', METRICS_METHODS),
    indexClient: makeClient('index', INDEX_METHODS),
    graphClient: makeClient('graph', GRAPH_METHODS),
    shutdown,
  };
}
