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

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write(decision('allow')); return; }
    const event = JSON.parse(raw);

    const toolName = event.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob') {
      process.stdout.write(decision('allow'));
      return;
    }

    const cfg = require('./lib/hooks-config.js').getGraphGuard();
    if (!cfg.enabled) { process.stdout.write(decision('allow')); return; }

    const core = require('./lib/graph-guard-core.js');
    const ti = event.tool_input || {};
    if (!core.isBroadNativeSearch(toolName, ti)) {
      process.stdout.write(decision('allow'));
      return;
    }

    // The graph rides the mcp-memory daemon — on the local backend there is no
    // graph to redirect to.
    const brainCfg = require('./lib/brain-config.js').load();
    if (((brainCfg.backend && brainCfg.backend.type) || 'local') !== 'mcp-memory') {
      process.stdout.write(decision('allow'));
      return;
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
      process.stdout.write(decision('deny', { additionalContext: res.reason, permissionDecisionReason: res.reason }));
      return;
    }
    process.stdout.write(decision('allow'));
  } catch (err) {
    console.error(`[GRAPH-GUARD] Error: ${err.message}`);
    hookLog('error', 'graph-guard', `Unhandled error: ${err.message}`);
    process.stdout.write(decision('allow'));
  }
})();
