'use strict';
/**
 * turn-budget.js — deterministic capture cadence (Phase 1, task 3).
 *
 * Decides WHEN a clean block is big enough to hand to the agent for lesson
 * capture. Pure arithmetic (no LLM). The budget scales with the session model
 * ONLY as a cadence hint — the model field is NOT guaranteed at Stop, so an
 * unknown/missing model falls back to the SMALLEST (most conservative) budget.
 *
 * Hard cap: maxChars never exceeds HOOK_SAFE_CHARS because a hook's output
 * string is capped (~10k) before it spills to a file — the injected block must
 * fit inline. Real model ids look like `claude-sonnet-5`, `claude-opus-4-8`, so
 * we match by FAMILY substring, not a literal `sonnet-*` glob.
 */

const HOOK_SAFE_CHARS = 9000;

// Ordered: first family whose pattern matches wins.
const FAMILIES = [
  { match: /opus/i,       minTurns: 4, maxTurns: 8, maxChars: 9000 },
  { match: /sonnet/i,     minTurns: 4, maxTurns: 6, maxChars: 8000 },
  { match: /haiku|mini/i, minTurns: 3, maxTurns: 5, maxChars: 6000 },
];

// Unknown / missing model → smallest, most conservative budget.
const SMALLEST = { minTurns: 3, maxTurns: 5, maxChars: 6000 };

const DEFAULT_BOUNDS = { maxCapturesPerSession: 8, cooldownMs: 2 * 60 * 1000 };

/** Resolve the {minTurns,maxTurns,maxChars} budget for a model id (family match). */
function budgetForModel(model) {
  const m = typeof model === 'string' ? model : '';
  const fam = FAMILIES.find(f => f.match.test(m));
  const b = fam
    ? { minTurns: fam.minTurns, maxTurns: fam.maxTurns, maxChars: fam.maxChars }
    : { ...SMALLEST };
  b.maxChars = Math.min(b.maxChars, HOOK_SAFE_CHARS); // never exceed the inline hook limit
  return b;
}

/**
 * Deterministic fire decision.
 * @param {{cycles?:number, chars?:number, model?:string, capturesThisSession?:number, lastCaptureTs?:number, now?:number}} input
 * @param {{maxCapturesPerSession?:number, cooldownMs?:number}} [bounds]
 * @returns {{fire:boolean, reason:string}}
 */
function shouldFire(input, bounds) {
  const {
    cycles = 0, chars = 0, model = '',
    capturesThisSession = 0, lastCaptureTs = 0, now = Date.now(),
  } = input || {};
  const b = { ...DEFAULT_BOUNDS, ...(bounds || {}) };
  const budget = budgetForModel(model);

  if (capturesThisSession >= b.maxCapturesPerSession) return { fire: false, reason: 'session-cap' };
  if (lastCaptureTs && (now - lastCaptureTs) < b.cooldownMs) return { fire: false, reason: 'cooldown' };
  if (cycles < budget.minTurns) return { fire: false, reason: 'below-min-turns' };
  if (cycles >= budget.maxTurns) return { fire: true, reason: 'max-turns' };
  if (chars >= budget.maxChars) return { fire: true, reason: 'max-chars' };
  return { fire: false, reason: 'accumulating' };
}

module.exports = { budgetForModel, shouldFire, DEFAULT_BOUNDS, HOOK_SAFE_CHARS, SMALLEST };
