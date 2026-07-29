#!/usr/bin/env node
/**
 * brain-health.js — SessionStart + UserPromptSubmit liveness probe.
 *
 * Validates the brain MCP path can serve calls. Runs in two phases:
 *   1. Static checks (fs lookups, ~1ms): entry, deps, scripts, data dir writable.
 *   2. Active probe (~30ms): backend.init + backend.count — exercises the SAME
 *      in-process modules the brain MCP server uses, so a failure here means
 *      the MCP server would also fail to serve (and conversely, success here
 *      is a strong signal the MCP is healthy too).
 *
 * Behavior:
 *   - Healthy → exit 0 silently (`{}`), no context noise.
 *   - Defect  → emits `additionalContext` advisory listing exact failures +
 *     remediation. The agent is instructed to fix or surface to the user.
 *
 * Throttling: on UserPromptSubmit we run at most once per `cooldownMs`
 * (default 60s) per data dir, since the same probe just ran on SessionStart
 * and most prompts won't change health state.
 *
 * Per user request: "o hook de start session e prompt user deveria ser assim,
 * o hook valida se esta on, se esta exit 0, se nao instruir a subir".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./lib/atomic-write.js');

const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');
const { getSqliteBackend } = require('./lib/sqlite-compat.js');

const COOLDOWN_MS = 60_000;

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function checkExists(p, kind) {
  try {
    return fs.existsSync(p) ? null : `${kind} missing: ${p}`;
  } catch (err) {
    const reason = `${kind} stat failed: ${err.message}`;
    return reason;
  }
}

function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.brain-health-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return null;
  } catch (err) {
    const reason = `data dir not writable: ${dir} (${err.message})`;
    return reason;
  }
}

/**
 * As dependências do brain-server estão RESOLVÍVEIS?
 *
 * Antes isto era um `existsSync('servers/brain-server/node_modules')`, o que
 * confunde LOCAL com RESOLVÍVEL. O brain-server declara uma dep só
 * (`@modelcontextprotocol/sdk`) e a resolução de bare-specifier do Node — em CJS
 * e em ESM — sobe a árvore de diretórios: com a dep declarada na RAIZ do plugin,
 * `servers/brain-server/index.js` a encontra em `<root>/node_modules` sem precisar
 * de um `node_modules` próprio. Checar a pasta acusaria DOWN um MCP saudável.
 *
 * Duas sondas, nesta ordem, porque nenhuma sozinha é honesta:
 *   1. `require.resolve` (precisa: é o algoritmo do próprio Node), mas ela FALHA
 *      em pacote ESM-only cujo `exports` não expõe a condição `require` — e o
 *      brain-server é ESM, então o import funcionaria. Sozinha, mentiria.
 *   2. Varredura de `node_modules` subindo a árvore — robusta a CJS/ESM, é a mesma
 *      busca de pacote que o resolvedor ESM faz.
 * Só reporta ausência quando AS DUAS falham. Ausência genuína continua falhando
 * alto, dizendo QUAL dep faltou.
 *
 * @param {string} root plugin root
 * @returns {{ok: boolean, detail: string}}
 */
function depResolvable(dep, fromDir) {
  try {
    require.resolve(`${dep}/package.json`, { paths: [fromDir] });
    return true;
  } catch (err) { void err; /* pode ser `exports` sem ./package.json */ }
  try {
    require.resolve(dep, { paths: [fromDir] });
    return true;
  } catch (err) { void err; /* pode ser ESM-only (sem condição require) */ }
  // Fallback: a mesma varredura de pacote do resolvedor ESM (sobe a árvore).
  let dir = fromDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', dep, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function brainServerDepsOk(root) {
  const bsDir = path.join(root, 'servers', 'brain-server');
  const pkgPath = path.join(bsDir, 'package.json');
  let deps;
  try {
    deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).dependencies || {});
  } catch (err) {
    return { ok: false, detail: `brain-server package.json ilegível: ${err.message}` };
  }
  const missing = deps.filter((dep) => !depResolvable(dep, bsDir));
  return missing.length
    ? { ok: false, detail: `brain-server deps não resolvem: ${missing.join(', ')} (rode npm install na raiz do plugin)` }
    : { ok: true, detail: `brain-server deps resolvidas (${deps.length})` };
}

function staticChecks(root, data) {
  const defects = [];
  const checks = [
    [path.join(root, 'servers', 'brain-server', 'index.js'), 'brain-server entry'],
    [path.join(root, 'node_modules'), 'plugin deps (run npm install in plugin root)'],
    [path.join(root, 'scripts', 'brain-store.js'), 'brain-store script'],
  ];
  for (const [p, kind] of checks) {
    const err = checkExists(p, kind);
    if (err) defects.push(err);
  }
  const bsDeps = brainServerDepsOk(root);
  if (!bsDeps.ok) defects.push(bsDeps.detail);
  const writeErr = checkWritable(data);
  if (writeErr) defects.push(writeErr);
  return defects;
}

async function liveProbe(root, projectKey) {
  // Active probe: exercise the same module path the MCP server uses.
  // Skip if static checks already failed (would crash on require).
  try {
    const backend = require(path.join(root, 'scripts', 'brain-backend.js'));
    await backend.init({ project: projectKey, skipEmbedder: true });
    await backend.count();
    if (backend.close) await backend.close();
    return null;
  } catch (err) {
    const reason = `live probe failed: ${err.message}`;
    return reason;
  }
}

function shouldRunOnPrompt(data) {
  // Throttle: only re-probe on UserPromptSubmit if last run is older than cooldown.
  // SessionStart always runs.
  const stamp = path.join(data, '.brain-health-last');
  try {
    if (fs.existsSync(stamp)) {
      const last = parseInt(fs.readFileSync(stamp, 'utf-8'), 10);
      if (Number.isFinite(last) && (Date.now() - last) < COOLDOWN_MS) return false;
    }
  } catch { /* fallthrough → run */ }
  return true;
}

function recordRun(data) {
  try {
    fs.mkdirSync(data, { recursive: true });
    writeFileAtomic(path.join(data, '.brain-health-last'), String(Date.now()));
  } catch { /* nothing actionable */ }
}

function emitAdvisory(eventName, defects) {
  const lines = defects.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        '[BRAIN-HEALTH] Brain MCP path is DOWN — defects detected:\n' +
        lines +
        '\n\nAction: re-run `.vscode/scripts/install-local.mjs` — the new build takes effect ' +
        'on the next turn (no Claude Code restart needed). If the live probe failed, the agent ' +
        'must fix the listed cause before relying on `brain_search` / `brain_store` / ' +
        '`capture_lesson` — those calls will fail until resolved.',
    },
  });
}

function countPendingDrafts(data) {
  const dir = path.join(data, 'skills-pending');
  try {
    if (!fs.existsSync(dir)) return { count: 0, dir };
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let n = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) n++;
    }
    return { count: n, dir };
  } catch { /* unreadable dir: report zero */ return { count: 0, dir }; }
}

function emitPendingDraftsNotice(eventName, count, dir) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        `[BRAIN-HEALTH] ${count} pending skill draft${count === 1 ? '' : 's'} at ${dir} — ` +
        'review via dashboard #skills tab or `node scripts/brain-promote.js list`.',
    },
  });
}

/**
 * Cheap filesystem check (no model load): is the transformers model cached?
 * A missing model means the Brain is keyword-only and the pattern→skill loop
 * cannot advance recurrence (dedup needs vectors).
 */
function embedderModelMissing() {
  try {
    const embedder = require('./brain-embedder.js');
    const model = embedder.getModel(); // loads config → sets provider/model
    if (embedder.getProvider() !== 'transformers') return false; // external provider, no local model
    return !fs.existsSync(path.join(embedder.getModelCacheDir(), model));
  } catch (err) {
    console.error(`[BRAIN-HEALTH] embedder check skipped: ${err.message}`);
    return false;
  }
}

function emitEmbedderNotice(eventName) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        '[BRAIN-HEALTH] Embedding model not downloaded — the Brain is in keyword-only mode ' +
        '(no semantic search, and the pattern→skill loop cannot advance recurrence). ' +
        'Run `npm run setup:brain` to fetch it (or it downloads on first capture).',
    },
  });
}

/**
 * After a healthy probe, report when the active SQLite backend is the JSON
 * fallback ('none') — neither node:sqlite (Node < 22.13) nor better-sqlite3 is
 * available. The Brain still works but loses durable structured storage, metrics
 * and dashboard counts. getSqliteBackend() is cached/free here (the live probe
 * already resolved it), and accurately predicts the MCP server because Claude
 * Code spawns both with the same system-PATH Node and the same plugin code.
 * Note: a *missing* Node can't be detected here — if `node` is not on PATH the
 * hook never spawns (anthropics/claude-code#66183); that path is covered by docs.
 */
function emitDegradedSqliteNotice(eventName) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        '[BRAIN-HEALTH] SQLite backend unavailable — the Brain is using the JSON fallback ' +
        '(no metrics, dashboard count = 0, slower search). You are on Node ' +
        `${process.versions.node}; the built-in node:sqlite needs Node >= 22.13. ` +
        'Upgrade Node (on the system PATH) and restart Claude Code to restore it.',
    },
  });
}

/** Emit a SessionStart notice when memory recall has been recently degraded. */
function emitRecallDegradedNotice(eventName, status) {
  const reason = status.lastDegraded && status.lastDegraded.reason;
  const pct = Math.round(status.degradedRate * 100);
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        `[BRAIN-HEALTH] Memory recall is DEGRADED — ${status.windowDegraded} of the last ` +
        `${status.windowTotal} recalls came back empty (${pct}%)` +
        (reason ? ` (last reason: ${reason})` : '') + '. ' +
        'compose_recall is the required path on the mcp-memory backend: check the daemon is running and is version >= 2.18.',
    },
  });
}

/**
 * Recall-health snapshot when it warrants a notice.
 *
 * O veredito sai da JANELA recente, não dos totais vitalícios: >= 3 falhas DENTRO
 * da janela, taxa >= 20% e a última dentro da hora. Antes o gate era
 * `degraded >= 3` VITALÍCIO — permanentemente verdadeiro depois de algumas semanas
 * de uso, o que transformava qualquer soluço isolado num alarme exibindo números
 * históricos como se fossem recentes. Arquivo ausente (fresh/testes) → null.
 */
function recallDegradedStatus() {
  try {
    const status = require('./lib/recall-health.js').getStatus();
    const recent = status.lastDegraded && (Date.now() - status.lastDegraded.ts) < 60 * 60 * 1000;
    const bad = status.windowDegraded >= 3 && status.degradedRate >= 0.2;
    return (bad && recent) ? status : null;
  } catch (err) { void err; return null; }
}

async function main() {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    const eventName = event.hook_event_name || 'SessionStart';
    const project = event.cwd ? path.basename(event.cwd) : 'default';

    const root = pluginRoot();
    const data = dataDir();

    if (eventName === 'UserPromptSubmit' && !shouldRunOnPrompt(data)) {
      emitEmpty();
      return;
    }

    const defects = staticChecks(root, data);

    if (defects.length === 0) {
      const liveErr = await liveProbe(root, project);
      if (liveErr) defects.push(liveErr);
    }

    recordRun(data);

    if (defects.length > 0) { emitAdvisory(eventName, defects); return; }

    if (eventName === 'SessionStart') {
      const rstat = recallDegradedStatus();
      if (rstat) { emitRecallDegradedNotice(eventName, rstat); return; }
      if (getSqliteBackend() === 'none') { emitDegradedSqliteNotice(eventName); return; }
      if (embedderModelMissing()) { emitEmbedderNotice(eventName); return; }
      const { count, dir } = countPendingDrafts(data);
      if (count > 0) { emitPendingDraftsNotice(eventName, count, dir); return; }
    }

    emitEmpty();
  } catch (err) {
    console.error(`[BRAIN-HEALTH] probe crashed: ${err.message}`);
    emitEmpty();
  }
}

if (require.main === module) main();

module.exports = { countPendingDrafts, shouldRunOnPrompt, brainServerDepsOk };
