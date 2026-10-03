#!/usr/bin/env node
/**
 * graph-guard.js — PreToolUse hook for the native Grep|Glob tools.
 *
 * On the mcp-memory backend with a READY Session Graph, a BROAD recursive
 * search (no path/glob/type scoping) is denied ONCE with the two-step redirect:
 * graph_search/graph_symbols first (structural, embedding-free, ~300ms measured
 * on a 135k-node graph) to get the narrow paths, then re-run the text search
 * SCOPED. Retrying the identical call passes (per-session sig stamp) — never a
 * deadlock, and free-text searches lose at most one round-trip.
 *
 * NEVER waits for indexing (minutes on large repos, measured): not_indexed →
 * the search passes with a one-shot advisory suggesting graph_analyze.
 * Everything is fail-open — any error allows the search.
 *
 * The Bash surface (grep -r/rg/find at the repo root) is covered by the same
 * ladder inside curation-guard.js (which already runs on every Bash call —
 * zero extra process spawns).
 */
'use strict';

const path = require('path');
const { hookLog } = require('./hook-logger.js');
const { readStdin } = require('./lib/hook-io.js');

// Same decision shape as curation-guard (per Claude Code hooks docs).
function decision(permissionDecision, { additionalContext, permissionDecisionReason } = {}) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  return JSON.stringify({ hookSpecificOutput });
}

// Not a broad search / nothing to redirect → ABSTAIN ("{}"), never `allow`: a PreToolUse
// `allow` bypasses Claude Code's permission system (pre-release audit).
const PASS = '{}';

/**
 * Pure entry point: the decision JSON string for `event` (the CLI writes it to
 * stdout; the Phase G daemon tool returns it). Fail-open — never throws.
 * @param {object} event
 * @returns {Promise<string>}
 */
async function run(event) {
  try {
    if (!event) return PASS;

    const toolName = event.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob') {
      return PASS;
    }

    const cfg = require('./lib/hooks-config.js').getGraphGuard();
    if (!cfg.enabled) { return PASS; }

    const core = require('./lib/graph-guard-core.js');
    const ti = event.tool_input || {};
    if (!core.isBroadNativeSearch(toolName, ti)) {
      return PASS;
    }

    // The graph rides the mcp-memory daemon — on the local backend there is no
    // graph to redirect to.
    const brainCfg = require('./lib/brain-config.js').load();
    if (((brainCfg.backend && brainCfg.backend.type) || 'local') !== 'mcp-memory') {
      return PASS;
    }

    const cwd = event.cwd || process.cwd();
    const sid = event.session_id || 'default';
    const dataDir = require('./lib/data-dir.js').dataDir();
    const kind = toolName === 'Grep' ? 'native-grep' : 'native-glob';
    const pattern = String(ti.pattern || '');

    const res = await core.decideBroadSearch({
      kind,
      raw: `${toolName} ${pattern}`,
      pattern,
      projectRoot: path.resolve(cwd),
      sid,
      dataDir,
      cfg,
      probe: core.makeGraphStateProbe({ cwd, timeoutMs: cfg.probeTimeoutMs }),
    });

    if (res.action === 'deny') {
      try {
        require('./lib/metrics.js').fire('graph-guard.fired', { kind }, { sessionId: sid, cwd });
      } catch (e) { void e; /* metrics are best-effort */ }
      return decision('deny', { additionalContext: res.reason, permissionDecisionReason: res.reason });
    }
    return PASS;
  } catch (err) {
    console.error(`[GRAPH-GUARD] Error: ${err.message}`);
    hookLog('error', 'graph-guard', `Unhandled error: ${err.message}`);
    return PASS;
  }
}

if (require.main === module) {
  (async () => {
    let out;
    try {
      const raw = await readStdin();
      out = await run(raw ? JSON.parse(raw) : null);
    } catch (err) {
      console.error(`[GRAPH-GUARD] Error: ${err.message}`);
      hookLog('error', 'graph-guard', `Unhandled error: ${err.message}`);
      out = PASS;
    }
    process.stdout.write(out);
  })();
}

module.exports = { run, decision };
