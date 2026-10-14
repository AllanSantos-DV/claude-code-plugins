'use strict';
/**
 * cost-tuning.js — the two Claude Code knobs that decide what a long session costs,
 * kept in the user's settings.json `env` (pure core; the write lives in model-router-ensure,
 * which already owns settings.json and runs its writes in sequence at SessionStart).
 *
 *   - CLAUDE_CODE_PROMPT_CACHE_TTL=1h — API key / gateway / cloud sessions get a 5-minute cache
 *     by default (subscriptions already get 1 h). A tool call or a wait longer than 5 min
 *     (tests, CI, a background agent) expires it and the next request re-writes the whole
 *     context. Measured 2026-10-11 (docs/research/cost-2026-10-11): 14 such re-writes of
 *     450–770k tokens in ONE session-day, ~US$46 of a US$88 day. A 1 h write costs 1.6× a 5 min
 *     one, paid only on the new part of each turn. Proved through the owner's gateway
 *     (ephemeral_1h_input_tokens on the reply).
 *   - ENABLE_TOOL_SEARCH=true — always set (owner, 14/10): MCP tool schemas load on demand instead of
 *     all up front. A value the user already has (false, auto) is theirs and stays.
 *   - CLAUDE_CODE_AUTO_COMPACT_WINDOW (OFF by default since 14/10; opt-in through the config) — the window the engine's auto-compaction budgets
 *     against. At 1M it compacts at ~967k, so every call between compactions re-reads up to
 *     ~1M tokens; the boss's own prompt gate only acts at a person's prompt on a cold cache,
 *     never mid-turn or in delegated sessions. The engine compacts at the window minus a fixed
 *     33k buffer (`/context`, CC 2.1.293: 300k → 267k, 153k → 120k), mid-turn too, through its
 *     summary (hooks/compaction.mjs keeps it unless pruning cuts >= 85%). 153k → ~120k: the
 *     summary call reads the history from the warm cache (measured through a proxy), so
 *     compacting there pays back in ~28 calls of a ~39-call cycle. Replayed on 7,049 real calls
 *     (docs/research/compaction-warm-tail, 2026-10-12): −12.7% against the 300k window, same
 *     summary (the 300k window itself: US$513 → ~US$210 on 6 session-days, cost-2026-10-11).
 *
 * WHY the window is off by default: the fixed 153k made the ENGINE compact at ~120k, mid-turn, with the
 * cache WARM — 15 times in one session (14/10), each a summary plus a ~32k cache re-write, and the
 * boss's cold-cache gate never acted. The owner's rule is a PERCENT of the model window (the
 * compaction setting), never a fixed number, and only on a cold cache. A previous 153000 written by
 * us is restored by the ownership state below.
 *
 * Ownership, so nothing of the user's is lost: the state remembers what WE wrote and what was
 * there before. Turning the feature off restores the previous value. A value the user changes
 * after us is theirs: we yield and never re-apply over that same value. A window the user
 * set SMALLER than ours, or a TTL they set themselves, is never touched.
 */

const TTL_KEY = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const TOOL_SEARCH_KEY = 'ENABLE_TOOL_SEARCH'; // Anthropic's own switch (true | auto | auto:N | false)

const DEFAULTS = Object.freeze({ enabled: true, cacheTtl: '1h', autoCompactWindow: null, toolSearch: true });
const WINDOW_RANGE = Object.freeze([100000, 1000000]);

/** The effective config: unknown TTL values off, the window clamped (null = don't manage it). */
function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const ttl = c.cacheTtl === undefined ? DEFAULTS.cacheTtl : c.cacheTtl;
  const w = c.autoCompactWindow === undefined ? DEFAULTS.autoCompactWindow : c.autoCompactWindow;
  const n = Number(w);
  return {
    enabled: c.enabled !== false,
    toolSearch: c.toolSearch !== false,
    cacheTtl: ttl === '1h' ? '1h' : null, // Claude Code takes only 5m|1h; 5m is its default here
    autoCompactWindow: w === null || w === false || !Number.isFinite(n) ? null : Math.min(WINDOW_RANGE[1], Math.max(WINDOW_RANGE[0], Math.round(n))),
  };
}

const on = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());

/**
 * Billed by the API (5-minute default cache) rather than a subscription (1 h already): a cloud
 * provider, an API key, or a base URL that is neither Anthropic's nor the boss's own proxy
 * (behind the proxy the credential is whatever the user logged in with — unknown, so no).
 * @param {object} env  the session's environment
 * @param {(url:string)=>boolean} isOurProxy
 */
function apiBilled(env, isOurProxy) {
  const e = env || {};
  if (on(e.CLAUDE_CODE_USE_BEDROCK) || on(e.CLAUDE_CODE_USE_VERTEX) || on(e.CLAUDE_CODE_USE_FOUNDRY)) return true;
  if (e.ANTHROPIC_API_KEY) return true;
  const base = String(e.ANTHROPIC_BASE_URL || '').trim();
  if (!base || isOurProxy(base)) return false;
  try { return new URL(base).host !== 'api.anthropic.com'; } catch (err) { void err; return false; }
}

/** What we want in env now: {KEY: value}. */
function wanted(cfg, billed) {
  const want = {};
  if (!cfg.enabled) return want;
  if (cfg.cacheTtl && billed) want[TTL_KEY] = cfg.cacheTtl;
  if (cfg.toolSearch) want[TOOL_SEARCH_KEY] = 'true'; // always: MCP tools load on demand, not all up front
  if (cfg.autoCompactWindow) want[WINDOW_KEY] = String(cfg.autoCompactWindow);
  return want;
}

/** May we write `val` over the user's own `cur`? Only a window LARGER than ours. */
function mayReplace(key, cur, val) {
  if (key !== WINDOW_KEY) return false;
  const n = Number(cur);
  return Number.isFinite(n) && n > Number(val);
}

/**
 * @param {object} env    current settings.json env
 * @param {object} want   wanted() output
 * @param {{applied?:object, previous?:object, yielded?:object}} [state]  persisted ownership
 * @returns {{env:object, state:object, changed:boolean, notes:string[]}}
 */
function planCostTuning(env, want, state) {
  const cur = { ...(env || {}) };
  const next = { ...cur };
  const s = {
    applied: { ...((state && state.applied) || {}) },
    previous: { ...((state && state.previous) || {}) },
    yielded: { ...((state && state.yielded) || {}) },
  };
  const notes = [];
  const restore = (key) => {
    if (s.previous[key] == null) delete next[key]; else next[key] = s.previous[key];
  };

  for (const key of Object.keys(s.applied)) {
    const ours = s.applied[key];
    if (cur[key] !== ours) { // changed by the user after us: theirs now
      notes.push(`${key}: changed by you (${cur[key] ?? 'removed'}) — left as is`);
      s.yielded[key] = cur[key] ?? null; // removing it is a choice too
      delete s.applied[key]; delete s.previous[key];
      continue;
    }
    if (want[key] === ours) continue;
    restore(key);
    notes.push(`${key}: ${ours} → ${s.previous[key] ?? 'unset'} (restored)`);
    delete s.applied[key]; delete s.previous[key];
  }

  for (const [key, val] of Object.entries(want)) {
    if (s.applied[key] === val) continue;
    const have = next[key];
    if (key in s.yielded && (have ?? null) === s.yielded[key]) continue; // the user's choice stands
    delete s.yielded[key];
    if (have === val) continue; // already so, by the user: not ours to restore later
    if (have != null && !mayReplace(key, have, val)) continue;
    s.previous[key] = have ?? null;
    s.applied[key] = val;
    next[key] = val;
    notes.push(`${key}: ${have ?? 'unset'} → ${val}`);
  }

  const keys = new Set([...Object.keys(cur), ...Object.keys(next)]);
  const changed = [...keys].some((k) => cur[k] !== next[k]);
  return { env: next, state: s, changed, notes };
}

module.exports = { DEFAULTS, WINDOW_RANGE, TTL_KEY, WINDOW_KEY, TOOL_SEARCH_KEY, resolveConfig, apiBilled, wanted, planCostTuning };
