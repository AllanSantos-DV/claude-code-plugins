#!/usr/bin/env node
'use strict';
/**
 * policy-inject.js — SessionStart + SubagentStart hook (deterministic, Phase 2
 * micro-2). Surfaces USER-ACTIVATED standing policies into the agent's context
 * every session start AND every subagent start, so a standing constraint (e.g.
 * "never let pre-existing code errors pass") stops being missed by semantic
 * recall.
 *
 * The SAME script serves BOTH events — it ECHOES `hook_event_name` back into
 * `hookSpecificOutput.hookEventName`:
 *   - SessionStart   → injected context survives compaction (fires on
 *                      startup/resume/clear/compact);
 *   - SubagentStart  → subagents have a SEPARATE context, so the policy must be
 *                      injected there too or the sub-agent would never see it.
 *
 * "Surfacing ≠ compliance": this hook guarantees the policy is PRESENT in
 * context; it does NOT block. Enforcement is a later micro.
 *
 * Fail-open: any error → emit empty `{}`. Disabled (policyInject.enabled=false)
 * → empty. No active policies (and registry not corrupt) → empty.
 */
const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');
const { resolveLocalScopeId } = require('./lib/project-id.js');
const policyStore = require('./lib/policy-store.js');
const { getPolicyInject } = require('./lib/hooks-config.js');

/**
 * Render the bounded injection block. Header is always present (mirrors the
 * spec's canonical string); each active policy is one bullet; a corrupt registry
 * appends a short warning so the agent knows a constraint may be missing.
 */
function renderBlock(active, corrupt) {
  const lines = ['[BRAIN policy] The user explicitly activated these standing constraint(s) — honor them for the whole session:'];
  for (const r of active) {
    const t = String(r && r.text || '').replace(/\s+/g, ' ').trim();
    if (t) lines.push(`- ${t}`);
  }
  if (corrupt) lines.push('(warning: a policy registry file was unreadable and skipped)');
  return lines.join('\n');
}

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* non-JSON stdin → defaults */ }

    const cfg = getPolicyInject();
    if (cfg.enabled === false) return emitEmpty();

    const eventName = event.hook_event_name || 'SessionStart';

    // Fail-open LOCAL scope key: policies are a per-machine store (not the memory
    // contract), so resolveLocalScopeId degrades to basename(cwd)/'default' and never
    // throws; guard anyway so nothing can break the hook.
    let projectId = 'default';
    try { projectId = resolveLocalScopeId({ cwd: event.cwd }) || 'default'; }
    catch (err) { void err; /* keep the 'default' fallback */ }

    const DATA_DIR = dataDir();
    // loadResult gives the `corrupt` flag (so we can WARN); the active set comes
    // from listAlways() — ALWAYS-mode records only. Glob-mode (per-file) policies are
    // deliberately EXCLUDED here so a conditional advisory can never be injected as an
    // unconditional constraint; those surface post-edit via policy-glob-inject.
    const { records, corrupt } = policyStore.loadResult(DATA_DIR);
    void records; // consulted only for `corrupt`; active set is listAlways()'s job.
    const active = policyStore.listAlways(DATA_DIR, { projectId });

    // Nothing to surface AND nothing to warn about → stay silent.
    if (active.length === 0 && !corrupt) return emitEmpty();

    let block = renderBlock(active, corrupt);
    // Hard guarantee: never inject more than the configured budget of characters,
    // even if the store's own caps were bypassed.
    if (typeof cfg.maxChars === 'number' && cfg.maxChars > 0 && block.length > cfg.maxChars) {
      block = block.slice(0, cfg.maxChars);
    }

    emitJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: block } });
  } catch (err) {
    console.error(`[POLICY-INJECT] ${err.message}`);
    emitEmpty();
  }
})();
