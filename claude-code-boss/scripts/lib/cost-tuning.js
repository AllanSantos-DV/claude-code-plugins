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
 *   - the auto-compact window (OFF by default since 14/10; opt-in through the config) — the window the engine's auto-compaction budgets
 *     against. Written as the top-level `autoCompactWindow` of settings.json, NOT as the env var
 *     CLAUDE_CODE_AUTO_COMPACT_WINDOW: the env var outranks `/autocompact`, the `--autocompact` flag and every
 *     settings key (code.claude.com/docs/en/model-config, "Set the auto-compact window"), so a user who typed
 *     `/autocompact 500k` would silently lose. The `modelSettings` entry that `/autocompact` saves beats the
 *     top-level key, so the user's command wins over the boss's value (`modelSettings` is per model id, which the
 *     boss cannot know). An env window we wrote in an earlier version is restored away by the ownership state.
 *     At 1M it compacts at ~967k, so every call between compactions re-reads up to
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
const WINDOW_SETTING_KEY = 'autoCompactWindow'; // top-level settings.json key; the user's /autocompact (modelSettings) beats it

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
  return want;
}

/** The window we ask for in settings.json (never in env): a number of tokens, or null. */
function wantedWindow(cfg) {
  return cfg.enabled && cfg.autoCompactWindow ? cfg.autoCompactWindow : null;
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

/**
 * The top-level `autoCompactWindow` of settings.json under the same ownership rules as the env keys: written only
 * where the user has none, a value the user sets or changes is theirs (we yield, never re-apply over it), and turning
 * the feature off restores what was there.
 * @param {object} settings  parsed settings.json
 * @param {number|null} want wantedWindow() output
 * @param {{window?:{applied?:number, previous?:(number|null), yielded?:*}}} [state]
 * @returns {{settings:object, state:object, changed:boolean, notes:string[]}}
 */
function planWindowSetting(settings, want, state) {
  const next = { ...(settings || {}) };
  const w = { ...((state && state.window) || {}) };
  const notes = [];
  const result = () => ({ settings: next, state: w, changed: next[WINDOW_SETTING_KEY] !== (settings || {})[WINDOW_SETTING_KEY], notes });

  if (w.applied != null) {
    const have = next[WINDOW_SETTING_KEY];
    if (have !== w.applied) {
      notes.push(`${WINDOW_SETTING_KEY}: changed by you (${have ?? 'removed'}) — left as is`);
      w.yielded = have ?? null; // removing it is a choice too
      delete w.applied; delete w.previous;
    } else if (want !== w.applied) {
      if (w.previous == null) delete next[WINDOW_SETTING_KEY]; else next[WINDOW_SETTING_KEY] = w.previous;
      notes.push(`${WINDOW_SETTING_KEY}: ${w.applied} → ${w.previous ?? 'unset'} (restored)`);
      delete w.applied; delete w.previous;
    }
  }
  if (want == null || w.applied != null) return result();
  const cur = next[WINDOW_SETTING_KEY];
  if ('yielded' in w && (cur ?? null) === w.yielded) return result(); // the user's choice stands
  delete w.yielded;
  if (cur != null) return result(); // the user's own window: never overwritten, not ours to restore
  w.previous = null; w.applied = want;
  next[WINDOW_SETTING_KEY] = want;
  notes.push(`${WINDOW_SETTING_KEY}: unset → ${want}`);
  return result();
}

/**
 * Env plan and settings-key plan of the cost knobs in one result (what the hook applies and the doctor reports).
 * @returns {{env:object, settings:object, state:object, changed:boolean, notes:string[]}}
 */
function planCostTuningAll(settings, want, wantWin, state) {
  const e = planCostTuning((settings || {}).env, want, state);
  const win = planWindowSetting(settings, wantWin, state);
  return { env: e.env, settings: win.settings, state: { ...e.state, window: win.state }, changed: e.changed || win.changed, notes: [...e.notes, ...win.notes] };
}

/**
 * The lines the user must SEE about the auto-compact window: the env var outranks `/autocompact`.
 *  - migrated: an earlier boss version had written the env var and this run moved it to the settings key;
 *  - override: the env var is set by something else (settings.json env or the process environment).
 * @param {{migrated:boolean, window:(number|null), env:object, processEnv:object}} a  env = settings.json env after the plan
 * @returns {{migrated:(string|null), override:(string|null)}}
 */
function autoCompactNotices({ migrated, window: win, env, processEnv }) {
  if (migrated) {
    return {
      migrated: win
        ? `[BOSS] A janela de auto-compact do boss (${win}) saiu da variável ${WINDOW_KEY} — que vence o /autocompact sem avisar — e passou para "${WINDOW_SETTING_KEY}" no settings.json: o seu /autocompact por modelo agora vale e vence o valor do boss. Reinicie o Claude Code para a variável sair do ambiente.`
        : `[BOSS] A variável ${WINDOW_KEY} que o boss tinha gravado foi removida do settings.json (ela vencia o /autocompact sem avisar). Reinicie o Claude Code para ela sair do ambiente.`,
      override: null,
    };
  }
  const inSettings = (env || {})[WINDOW_KEY];
  const v = inSettings !== undefined ? inSettings : (processEnv || {})[WINDOW_KEY];
  if (v === undefined || v === '') return { migrated: null, override: null };
  return {
    migrated: null,
    override: `[BOSS] ${WINDOW_KEY}=${v} está definida (${inSettings !== undefined ? 'env do settings.json' : 'ambiente do processo'}): ela vence o /autocompact, a flag --autocompact e o autoCompactWindow — o comando só relata o valor. Para voltar a controlar a janela com /autocompact, remova a variável.`,
  };
}

module.exports = { DEFAULTS, WINDOW_RANGE, TTL_KEY, WINDOW_KEY, WINDOW_SETTING_KEY, TOOL_SEARCH_KEY, resolveConfig, apiBilled, wanted, wantedWindow, planCostTuning, planWindowSetting, planCostTuningAll, autoCompactNotices };
