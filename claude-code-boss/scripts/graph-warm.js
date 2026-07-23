#!/usr/bin/env node
/**
 * graph-warm.js — SessionStart hook: proactively warm the Session Graph.
 *
 * Idea (owner): every project opened under the boss + mcp-memory should get its
 * Session Graph indexed automatically, so it's ready-and-fresh before the first
 * search — instead of the agent having to call graph_analyze by hand (and
 * instead of the graph-guard's first broad search paying the not_indexed path).
 *
 * The server owns the delta: `ingest` is INCREMENTAL (SHA-256 per-file manifest
 * → no-op ~5s if nothing changed on a 20k-file repo, rebuild only on change,
 * extractor-version fingerprint forces re-index on upgrade, partial-walk aborts
 * preserving the old graph). So the client just POKES ingest and lets the server
 * decide — no client-side staleness logic needed. This fires-and-forgets: it
 * returns as soon as the daemon accepts the ingest (202, ~80ms), never waiting
 * for the async index.
 *
 * A per-project cooldown (default 4h) avoids re-hashing the repo on every session
 * open. Silent + fail-open: any problem → no-op, never blocks SessionStart. This
 * is a BRIDGE — the memory server already ships a GraphIngestScheduler meant to
 * do this server-side (currently unwired); once that lands, this can retire.
 */
'use strict';

const path = require('path');
const { readStdin, emitEmpty } = require('./lib/hook-io.js');

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { /* defaults */ }

  const cfg = require('./lib/hooks-config.js').getGraphGuard();
  if (!cfg.enabled || !cfg.warm) return emitEmpty();

  // The graph lives on the mcp-memory daemon — nothing to warm on the local backend.
  const brainCfg = require('./lib/brain-config.js').load();
  if (((brainCfg.backend && brainCfg.backend.type) || 'local') !== 'mcp-memory') return emitEmpty();

  const cwd = (typeof event.cwd === 'string' && event.cwd) ? event.cwd : process.cwd();
  const projectRoot = path.resolve(cwd);
  const dataDir = require('./lib/data-dir.js').dataDir();
  const core = require('./lib/graph-guard-core.js');

  // Per-project cooldown: don't re-hash the repo on every open within the window.
  const stampFile = core.warmStampPath(dataDir, projectRoot);
  if (core.isWarmOnCooldown(stampFile, cfg.warmCooldownMs)) return emitEmpty();

  const dispatch = core.makeGraphIngestDispatch({ cwd, timeoutMs: cfg.probeTimeoutMs });
  const res = await dispatch();
  if (res && res.dispatched) {
    core.stampWarm(stampFile); // only stamp when the daemon actually accepted the ingest
  }
  return emitEmpty(); // never inject/block — pure background warm
}

if (require.main === module) {
  main().catch((err) => { console.error(`[graph-warm] ${err && err.message ? err.message : err}`); emitEmpty(); });
}

module.exports = { main };
