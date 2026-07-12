'use strict';
/**
 * stop-telemetry.js — pure helpers for honest, OTel-flavored Stop-hook telemetry.
 *
 * The profile (dev/standard/free) gates which Stop detectors fire. The gap this
 * closes: a gated detector used to `return {}` silently, so you could never tell
 * "disabled by profile" from "ran and stayed quiet", nor measure the bypass.
 *
 * Honesty rule (from external review): a SKIPPED detector is NOT a "suppressed
 * block". We only know it would have blocked if we actually ran it. So:
 *   - `gated`         = disabled by profile (cheap, always known).
 *   - `shadow_block`  = we ran it in a sampled shadow pass and it WOULD have
 *                       blocked (labeled estimate, never enforced).
 * We never claim "tokens saved" — only `chars` of Stop-message text avoided,
 * which the UI presents as an estimate.
 */
const crypto = require('node:crypto');

const SCHEMA_VERSION = 'v1';
const DEFAULT_SHADOW_RATE = 0.03;

// Detectors whose firing is gated by the hooks profile (name → hooks-config getter).
// Anything NOT listed always runs — unless the whole profile is `free`, which is a
// full passthrough (everything off).
const PROFILE_GATE = {
  'pattern-detect':           'getPatternDetect',
  'decision-scan-response':   'getDecisionScan',
  'self-review':              'getSelfReview',
  'verify-nudge':             'getVerifyNudge',
  'refine-research':          'getRefineResearch',
  'research-followup-detect': 'getResearchFollowup',
  'failure-retro':            'getFailureRetro',
  'session-summary':          'getSessionSummary',
  'auto-continue-stop':       'getAutoContinue',
  'curation-stop':            'getCurationStop',
};

/**
 * Resolve whether a detector runs under `profile`, and why (OTel reason code).
 * @returns {{ flagged:boolean, enabled:boolean, reason:string }}
 */
function gateState(name, profile, hooksConfig) {
  const flagged = Object.prototype.hasOwnProperty.call(PROFILE_GATE, name);
  if (profile === 'free') {
    return { flagged, enabled: false, reason: flagged ? 'profile_match' : 'free_passthrough' };
  }
  if (!flagged) return { flagged: false, enabled: true, reason: 'default' };
  let enabled = true;
  try {
    const getter = hooksConfig[PROFILE_GATE[name]];
    enabled = typeof getter === 'function' ? getter().enabled !== false : true;
  } catch (err) { void err; enabled = true; }
  return { flagged: true, enabled, reason: 'profile_match' };
}

/**
 * Deterministic sampling: hash(runId:name) < rate. Stable per (Stop, detector) so
 * a given Stop either shadows a detector or doesn't — reproducible in tests.
 */
function shouldShadow(runId, name, rate) {
  const r = Number(rate);
  if (!(r > 0)) return false;
  if (r >= 1) return true;
  const h = crypto.createHash('sha1').update(`${runId}:${name}`).digest();
  const frac = h.readUInt32BE(0) / 0xffffffff;
  return frac < r;
}

/** Length of the Stop-message text (privacy: a count, never the text itself). */
function estChars(reason) {
  return typeof reason === 'string' ? reason.length : 0;
}

function newRunId() {
  try { return crypto.randomUUID(); }
  catch (err) { void err; return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/**
 * Fold per-detector outcomes into ONE low-volume Stop summary row. Cross-
 * referenceable by profile/run_id; per-detector states are compact so a single
 * JSON payload covers the whole Stop (no row-per-detector blowup).
 * @param {Array<{name,gated,blocked,would_block,chars,ms}>} detectors
 */
function summarize(profile, runId, detectors) {
  let blocked = 0, gated = 0, shadow = 0, avoidedChars = 0, enforcedChars = 0;
  const compact = [];
  for (const d of detectors) {
    let state;
    if (!d.gated) {
      state = d.blocked ? 'block' : 'ran';
      if (d.blocked) { blocked += 1; enforcedChars += d.chars || 0; }
    } else {
      gated += 1;
      if (d.would_block === null || d.would_block === undefined) {
        state = 'gated';
      } else {
        shadow += 1;
        state = d.would_block ? 'shadow_block' : 'shadow_quiet';
        if (d.would_block) avoidedChars += d.chars || 0;
      }
    }
    compact.push({ name: d.name, s: state, c: d.chars || 0, ms: d.ms || 0 });
  }
  return {
    profile,
    run_id: runId,
    schema: SCHEMA_VERSION,
    evaluated: detectors.length,
    blocked,
    gated,
    shadow,
    enforcedChars,
    avoidedChars,
    detectors: compact,
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_SHADOW_RATE,
  PROFILE_GATE,
  gateState,
  shouldShadow,
  estChars,
  newRunId,
  summarize,
};
