#!/usr/bin/env node
'use strict';
/**
 * policy-enforce-shadow.js — PreToolUse shadow-MEASUREMENT hook (Phase 3 micro-A).
 *
 * For an `Edit`, this checks whether the edited file's project-relative path matches
 * any SHADOW-ASSERTION glob policy (enforcement:'shadow', assert.kind
 * 'forbid-added-literal') for the current project. For each match it computes whether
 * the edit would ADD an occurrence of the policy's literal — `outcome:'trigger'` when
 * the literal's non-overlapping count is STRICTLY HIGHER in `new_string` than in
 * `old_string`, else `'pass'` — and records ONE `policy.shadow.evaluated` metric.
 *
 * It MEASURES ONLY. It is:
 *   - SILENT: ALWAYS emits `{}` — never a permissionDecision, never additionalContext.
 *     It never blocks and produces no agent-visible output (measuring incidence, not
 *     enforcing). "trigger" here is a CANDIDATE-guard hit, NOT a violation.
 *   - The allowlist is EXACTLY {'Edit','Write','MultiEdit'}; NotebookEdit stays out (its
 *     cell diff has no old/new string). The old/new text of each: Edit its
 *     old_string/new_string; MultiEdit its edits joined by a newline; Write the file on
 *     disk (empty when new) against `content`.
 *   - PRIVACY-BOUNDED: the metric payload is ONLY {schema, activationId, outcome} —
 *     never the file path, the literal, a snippet, or the tool name.
 *   - CONSISTENT: it stamps the metric with `metricsProjectKey(cwd)` — the SAME
 *     canonical key `policy_shadow_report` reads — so the write and the read always
 *     agree on the metrics db (see metrics-project.js).
 *
 * Fail-open: any error → `{}`. Disabled (policyInject.enabled=false), non-Edit tool,
 * no path, outside-project path, or no matching shadow policy → `{}` (no metric).
 *
 * PROSPECTIVE TRIGGER-EVIDENCE CAPTURE (Fase 3 micro-B1, OPT-IN, DEFAULT OFF): when
 * (and only when) `captureTriggerEvidence.enabled` is true, a matching `outcome:'trigger'`
 * ALSO appends a bounded, REDACTED, TTL-limited record of the ADDED text to the
 * per-project trigger-evidence queue (lib/trigger-evidence-store.js), so the judge can
 * adjudicate the ACTUAL trigger proposals (not just current code). Capture is
 * best-effort and wrapped so it can NEVER break the silent hook — the hook still
 * ALWAYS emits `{}`. Off by default: nothing is stored unless the user opts in.
 */
const { emitEmpty, runSideEffectCli } = require('./lib/hook-io.js');
const { dataDir } = require('../engine/lib/data-dir.js');
const { resolveLocalScopeId } = require('../engine/lib/project-id.js');
const policyStore = require('../engine/lib/policy-store.js');
const { getPolicyInject, getCaptureTriggerEvidence } = require('./lib/hooks-config.js');
const metrics = require('../engine/lib/metrics.js');
const { metricsProjectKey } = require('../engine/lib/metrics-project.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redact } = require('../engine/lib/redact.js');
const triggerEvidenceStore = require('./lib/trigger-evidence-store.js');

// Belt-and-suspenders beyond the hooks.json matcher. EXACT string set (not a substring
// regex) so no other tool can slip in.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Above this size (chars) we don't scan old/new strings — a pathological input would
// stall the PreToolUse path. Such an edit is recorded as 'unevaluable' (honest: we
// declined to measure it), never silently dropped nor mislabeled 'pass'.
const LITMAX_INPUT = 1_000_000;

/**
 * Count NON-OVERLAPPING occurrences of `needle` in `hay`. This is the deterministic
 * kernel of the outcome decision — `outcome` compares this count in new vs old, so a
 * literal that is PRESERVED across an edit (same count) is a 'pass', and one that is
 * ADDED (higher count) is a 'trigger'. `caseSensitive:false` lowercases both sides.
 * An empty needle counts 0 (a valid shadow literal is never empty, but stay safe).
 * @param {string} hay
 * @param {string} needle
 * @param {boolean} caseSensitive
 * @returns {number}
 */
function countOccurrences(hay, needle, caseSensitive) {
  const h = typeof hay === 'string' ? hay : '';
  const n = typeof needle === 'string' ? needle : '';
  if (!n) return 0;
  const hs = caseSensitive ? h : h.toLowerCase();
  const ns = caseSensitive ? n : n.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = hs.indexOf(ns, from);
    if (idx === -1) break;
    count++;
    from = idx + ns.length; // non-overlapping: advance past this match
  }
  return count;
}

/**
 * The text a write replaces and the text it leaves, per tool.
 * `oldStr` is null for a Write over a file too large to read: the caller records 'unevaluable'.
 * @param {object} ev  PreToolUse payload
 * @returns {{oldStr: string|null, newStr: string}}
 */
function diffOf(ev) {
  const ti = ev.tool_input || {};
  const str = (v) => (typeof v === 'string' ? v : '');
  if (ev.tool_name === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    return { oldStr: edits.map((e) => str(e && e.old_string)).join('\n'), newStr: edits.map((e) => str(e && e.new_string)).join('\n') };
  }
  if (ev.tool_name === 'Write') {
    const abs = path.resolve(ev.cwd || '', ti.file_path);
    let oldStr = '';
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) oldStr = st.size > LITMAX_INPUT ? null : fs.readFileSync(abs, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return { oldStr, newStr: str(ti.content) };
  }
  return { oldStr: str(ti.old_string), newStr: str(ti.new_string) };
}

/**
 * Pure evaluation: records zero or more shadow-evaluation metrics as a side effect
 * and returns `{}` without writing — run() emits it; the Phase G daemon tool
 * returns it. Throws on unexpected errors (the CLI wrapper fails open with `{}`).
 * @param {object} event  parsed PreToolUse payload
 */
async function evaluate(event) {
  const ev = event || {};

  const cfg = getPolicyInject();
  if (cfg.enabled === false) return {};

  const tool = ev.tool_name || '';
  if (!EDIT_TOOLS.has(tool)) return {};

  const ti = ev.tool_input || {};
  const filePath = ti.file_path || '';
  if (!filePath) return {};

  // Fail-open LOCAL scope key (per-machine store, not the memory contract):
  // resolveLocalScopeId degrades to basename(cwd)/'default' and never throws.
  let projectId = 'default';
  try { projectId = resolveLocalScopeId({ cwd: ev.cwd }) || 'default'; }
  catch (err) { void err; /* keep the 'default' fallback */ }

  // Normalize to a project-relative path; null → outside project / other drive.
  const rel = policyStore.toRelPath(filePath, ev.cwd);
  if (rel == null) return {};

  const DATA_DIR = dataDir();
  const matches = policyStore.listShadowMatching(DATA_DIR, { projectId, filePath, cwd: ev.cwd });
  if (!matches.length) return {};

  const projKey = metricsProjectKey(ev.cwd);
  const { oldStr: oldRaw, newStr } = diffOf(ev);
  const oldStr = oldRaw === null ? '' : oldRaw;
  const tooBig = oldRaw === null || newStr.length > LITMAX_INPUT || oldStr.length > LITMAX_INPUT;

  // OPT-IN capture gate (DEFAULT OFF). Read once: when disabled, no evidence is ever
  // stored — the privacy default. Keyed by the SAME resolved projectId the judge's
  // `policy_adjudication_prepare` reads under, so the write and the read agree.
  const capture = getCaptureTriggerEvidence();

  for (const r of matches) {
    const assert = (r && r.assert) || {};
    const literal = assert.literal;
    const caseSensitive = assert.caseSensitive !== false; // stored boolean; default true
    const outcome = tooBig
      ? 'unevaluable'
      : (countOccurrences(newStr, literal, caseSensitive) > countOccurrences(oldStr, literal, caseSensitive)
        ? 'trigger'
        : 'pass');
    // Payload is INTENTIONALLY minimal: schema + the opaque activationId + outcome.
    // NO file, NO snippet, NO literal, NO tool — measurement must not exfiltrate.
    metrics.fire(
      'policy.shadow.evaluated',
      { schema: 1, activationId: r.activationId, outcome },
      { project: projKey, cwd: ev.cwd, sessionId: ev.session_id },
    );

    // micro-B1: on a REAL trigger AND only when the user opted in, capture the
    // triggering Edit proposal as bounded, REDACTED evidence for later adjudication.
    // Wrapped so a capture failure can NEVER break the silent measurement path.
    if (outcome === 'trigger' && capture.enabled === true) {
      try {
        const addedSnippet = redact(newStr).text.slice(0, capture.maxSnippetChars);
        triggerEvidenceStore.appendEvidence(
          DATA_DIR,
          projectId,
          {
            eventId: crypto.randomBytes(9).toString('hex'),
            activationId: r.activationId,
            sourceHash: r.sourceHash,
            file: rel,
            addedSnippet,
            ts: Date.now(),
          },
          { ttlDays: capture.ttlDays, maxPerProject: capture.maxPerProject },
        );
      } catch (err) {
        console.error('[POLICY-SHADOW] capture failed: ' + (err && err.message ? err.message : err));
      }
    }
  }

  // ALWAYS silent — shadow mode never blocks and never speaks to the agent.
  return {};
}

/** CLI/stdout entry: always `{}` (exactly one write). */
async function run(event) {
  await evaluate(event);
  return emitEmpty();
}

if (require.main === module) runSideEffectCli(evaluate, 'POLICY-SHADOW');

module.exports = { run, evaluate, countOccurrences, diffOf, EDIT_TOOLS };
