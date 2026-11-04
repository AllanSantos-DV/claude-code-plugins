'use strict';
/**
 * lib/scoped-rules-client.js — asks the single memory server (mcp-memory >= 3.0.0) for the owner's
 * rules of a scope: POST {daemon}/api/v1/scoped-rules/lookup (contract: native-java
 * docs/contracts/regras-por-escopo.md).
 *
 * REST and not the shared MCP connection: the Boss daemon serves sessions of many projects, and
 * the MCP tool takes the project from the connection's handshake, while the REST route takes the
 * calling session's `project_id` on each call.
 *
 * A refused connection is usually the server restarting: the address is re-read from its
 * announcement (~/.mcp-memory/run/daemon.json, a restart may move the port) and the call is
 * retried a bounded number of times with backoff. When every try is refused, later calls fail at
 * once for `downMs` instead of waiting again on every prompt.
 */
const path = require('path');
const os = require('os');
const { readDaemonUrl } = require('./mcp-bootstrap/registry.js');
const { RETRY_DELAYS_MS, isRefused, refusedCode, sleep } = require('./refused-retry.js');

const DOWN_MS = 30_000;

let downUntil = 0;

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{files?: string[], projectId?: string, idPrefix?: string, includeText?: boolean, limit?: number}} q
 * @param {{fetchImpl?: Function, runDir?: string, delays?: number[], timeoutMs?: number, downMs?: number, now?: () => number}} [o]
 * @returns {Promise<{count: number, rules: object[]}>}
 * @throws {Error} code MEMORY_SERVER_DOWN | LOOKUP_UNSUPPORTED | LOOKUP_REJECTED | LOOKUP_FAILED
 */
async function lookupScopedRules(q, o = {}) {
  const { fetchImpl = globalThis.fetch, delays = RETRY_DELAYS_MS, timeoutMs = 2000, downMs = DOWN_MS, now = Date.now } = o;
  const runDir = o.runDir || process.env.MCP_RUN_DIR || path.join(os.homedir(), '.mcp-memory', 'run');
  if (now() < downUntil) throw fail('MEMORY_SERVER_DOWN', `the memory server refused the connection moments ago (${path.join(runDir, 'daemon.json')}); trying again in ${Math.ceil((downUntil - now()) / 1000)} s`);
  const body = { include_text: q.includeText !== false, limit: q.limit || 200 };
  if (q.files && q.files.length) body.files = q.files;
  if (q.projectId) body.project_id = q.projectId;
  if (q.idPrefix) body.id_prefix = q.idPrefix;
  let last = 'no address announced';
  for (const ms of [0, ...delays]) {
    if (ms) await sleep(ms);
    const base = readDaemonUrl(runDir, { label: 'scoped-rules', requirePort: true });
    if (!base) continue;
    let res;
    try {
      res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/api/v1/scoped-rules/lookup`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (!isRefused(err)) throw fail('LOOKUP_FAILED', `scoped-rules lookup at ${base} failed: ${err.message}`);
      last = `${base}: ${refusedCode(err)}`;
      continue;
    }
    downUntil = 0;
    let json = null;
    try { json = await res.json(); } catch (err) { void err; /* non-JSON body, reported below */ }
    if (res.status === 200 && json && Array.isArray(json.rules)) return json;
    if (res.status === 404) throw fail('LOOKUP_UNSUPPORTED', `the memory server at ${base} has no scoped-rules lookup (needs mcp-memory 3.0.0 or newer)`);
    const why = json ? (json.message || json.error || json.code || JSON.stringify(json)) : `HTTP ${res.status}`;
    throw fail(res.status >= 400 && res.status < 500 ? 'LOOKUP_REJECTED' : 'LOOKUP_FAILED', `scoped-rules lookup at ${base} answered ${res.status}: ${String(why).slice(0, 200)}`);
  }
  downUntil = now() + downMs;
  throw fail('MEMORY_SERVER_DOWN', `the memory server refused every try (${delays.length + 1}, last ${last})`);
}

function _resetDown() { downUntil = 0; }

module.exports = { lookupScopedRules, RETRY_DELAYS_MS, _resetDown };
