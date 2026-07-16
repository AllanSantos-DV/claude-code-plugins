'use strict';
/**
 * self-update-plan.js — PURE advisory planner for Fase 3 micro-C (self-update).
 *
 * Turns the policy-auditor's LATEST disposition (a JUDGED estimate, produced by
 * micro-B0/B1) into a structured, HONEST self-update advisory. It has NO side
 * effects: it never reads the filesystem, never touches the policy store, and
 * never mutates anything. Applying a candidate is a separate, EXPLICIT,
 * user-invoked, CAS-guarded, ledgered action (policy_apply_candidate).
 *
 * Honesty contract (NON-NEGOTIABLE):
 *   - Everything here is a JUDGED, heuristic estimate — NOT a measured
 *     false-positive rate and NOT proven truth. Every recommendation string
 *     says so and states that nothing changes without an explicit apply.
 *   - Promotion to ENFORCE (blocking) is only ever SURFACED as an eligibility
 *     recommendation; it is never applied and is not implemented here.
 *   - The only ever-applicable action is a reversible demote-to-advisory, and
 *     it is only offered when the judged signal actually recommends it.
 *
 * Thresholds are named constants (exported for the tests + tools to reuse).
 */

/** Minimum judged sample before we advise at all (below → insufficient-data). */
const MIN_SAMPLE = 5;
/** Judged likely-FP share at/above this → the rule looks TOO BROAD (demote). */
const HIGH_FP = 0.6;
/** Judged likely-FP share at/below this (+ enough decisive) → well-calibrated. */
const LOW_FP = 0.15;

/**
 * Appended to EVERY recommendation string so no advisory can be read as a
 * proven fact or as an already-applied change. Contains the required phrase
 * "JUDGED estimate" plus the "nothing changes without explicit apply" promise.
 */
const CAVEAT = 'This is a JUDGED estimate (a heuristic read of the policy-auditor\'s dispositions), NOT proven truth and NOT a measured false-positive rate; nothing changes unless you explicitly apply it (policy_apply_candidate).';

/** Coerce to a finite non-negative integer count (defaults to 0). */
function num(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Render a share in [0,1] as a rounded percent, or "n/a" when null. */
function pct(x) {
  return x == null ? 'n/a' : `${Math.round(x * 100)}%`;
}

/**
 * Plan a self-update advisory for one policy from its latest disposition.
 *
 * PURE: returns a plain advisory object; performs NO side effects.
 *
 * @param {object} policy            A glob/shadow policy record (from policy-store.listVisible).
 * @param {object|null} latestDisposition The newest disposition for that policy (or null/undefined).
 * @returns {{
 *   policyId: (string|null),
 *   activationId: (string|null),
 *   signal: ('too-broad'|'well-calibrated'|'insufficient-data'),
 *   judged: { likelyFpShare: (number|null), decisive: number, uncertain: number, total: number, source: string },
 *   recommendation: string,
 *   candidate: { action: ('demote-to-advisory'|'enforce-eligible'|'none'), reason: string, requiresExplicitApply: boolean }
 * }}
 */
function planSelfUpdate(policy, latestDisposition) {
  const pol = policy && typeof policy === 'object' ? policy : {};
  const policyId = pol.id != null ? String(pol.id) : null;

  const disp = latestDisposition && typeof latestDisposition === 'object' ? latestDisposition : null;
  const counts = disp && disp.counts && typeof disp.counts === 'object' ? disp.counts : null;
  // activationId lineage: prefer the policy's telemetry key, fall back to the
  // disposition's (a demoted advisory has none — reported honestly as null).
  const activationId = pol.activationId != null
    ? String(pol.activationId)
    : (disp && disp.activationId != null ? String(disp.activationId) : null);
  const source = disp && disp.provenance && disp.provenance.source != null
    ? String(disp.provenance.source)
    : 'current-snapshot';

  const total = counts ? num(counts.total) : 0;
  const legit = counts ? num(counts.legit) : 0;
  const problem = counts ? num(counts.problem) : 0;
  const uncertain = counts ? num(counts.uncertain) : 0;
  const decisive = legit + problem;

  // ── Insufficient data ───────────────────────────────────────────────────
  // No disposition at all, or too small a sample. Also: a sample with ZERO
  // decisive judgments (all uncertain) cannot yield a likely-FP share, so it is
  // honestly insufficient too (labelling it "well-calibrated" would be a lie).
  if (!counts || total < MIN_SAMPLE) {
    return {
      policyId,
      activationId,
      signal: 'insufficient-data',
      judged: { likelyFpShare: null, decisive, uncertain, total, source },
      recommendation: `Insufficient adjudicated evidence (total=${total}, need at least ${MIN_SAMPLE}) to advise on this policy — adjudicate more first (/policy-adjudicate). ${CAVEAT}`,
      candidate: { action: 'none', reason: 'not-enough-judged-evidence', requiresExplicitApply: false },
    };
  }
  if (decisive === 0) {
    return {
      policyId,
      activationId,
      signal: 'insufficient-data',
      judged: { likelyFpShare: null, decisive, uncertain, total, source },
      recommendation: `No decisive judgments yet (all ${uncertain} judged occurrences are "uncertain"), so no likely-FP share can be computed — adjudicate more first (/policy-adjudicate). ${CAVEAT}`,
      candidate: { action: 'none', reason: 'no-decisive-judgments', requiresExplicitApply: false },
    };
  }

  // ── Decisive share (legit / (legit + problem)), decisive-only ───────────
  const likelyFpShare = legit / decisive;

  // ── Too broad → recommend a (reversible) demote-to-advisory ─────────────
  // The rule flags mostly-legitimate code (judged), so its shadow assertion
  // looks over-broad. Demoting keeps the glob advisory but drops the assertion.
  if (likelyFpShare >= HIGH_FP) {
    return {
      policyId,
      activationId,
      signal: 'too-broad',
      judged: { likelyFpShare, decisive, uncertain, total, source },
      recommendation: `Judged likely-FP share is about ${pct(likelyFpShare)} of ${decisive} decisive judgments (at or above ${pct(HIGH_FP)}): this rule appears to flag mostly-legitimate code, so it looks TOO BROAD. Consider demoting the shadow assertion back to a plain glob advisory (reversible). ${CAVEAT}`,
      candidate: { action: 'demote-to-advisory', reason: 'judged-mostly-legitimate', requiresExplicitApply: true },
    };
  }

  // ── Well-calibrated + enough decisive → enforce-ELIGIBLE (surface only) ──
  // The rule mostly flags real problems. Surface that it is ELIGIBLE for a
  // future enforce guard — a RECOMMENDATION only; enforcement is NOT applied
  // here and is not implemented.
  if (likelyFpShare <= LOW_FP && decisive >= MIN_SAMPLE) {
    return {
      policyId,
      activationId,
      signal: 'well-calibrated',
      judged: { likelyFpShare, decisive, uncertain, total, source },
      recommendation: `Judged likely-FP share is about ${pct(likelyFpShare)} of ${decisive} decisive judgments (at or below ${pct(LOW_FP)}): this rule mostly flags real problems, so it is ELIGIBLE for a future enforce (blocking) guard. Enforce-eligibility is a RECOMMENDATION ONLY — promotion to enforce is not implemented and is never applied here. ${CAVEAT}`,
      candidate: { action: 'enforce-eligible', reason: 'judged-mostly-problems', requiresExplicitApply: true },
    };
  }

  // ── Middling → no change recommended ────────────────────────────────────
  return {
    policyId,
    activationId,
    signal: 'well-calibrated',
    judged: { likelyFpShare, decisive, uncertain, total, source },
    recommendation: `Judged likely-FP share is about ${pct(likelyFpShare)} of ${decisive} decisive judgments — between the demote (at/above ${pct(HIGH_FP)}) and enforce-eligible (at/below ${pct(LOW_FP)}) thresholds — so no change is recommended. ${CAVEAT}`,
    candidate: { action: 'none', reason: 'judged-middling', requiresExplicitApply: false },
  };
}

module.exports = {
  planSelfUpdate,
  MIN_SAMPLE,
  HIGH_FP,
  LOW_FP,
  CAVEAT,
};
