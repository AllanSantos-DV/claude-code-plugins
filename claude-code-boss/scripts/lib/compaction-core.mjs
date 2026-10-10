/**
 * compaction-core.mjs — pure core of the controlled compaction (no I/O, no clock, no `$`).
 *
 * ESM on purpose: the same file is imported by the function-hook module
 * (hooks/compaction.mjs, which runs with no Node and no `require`) and by Node
 * (`require()` of ESM, Node >= 22.13 — package.json engines), so the decision the
 * session takes and the one the tests check are the same code.
 *
 * Two decisions:
 *   - planCompaction: WHAT to cut. User and assistant text is never touched; only
 *     stale tool results are truncated (a superseded read, a command that failed and
 *     later succeeded, an old large output), each leaving a note saying why. Messages
 *     left unchanged are returned as the very same objects, so the engine keeps them
 *     as its own (their `handle`).
 *   - decideTiming: WHEN. Rewriting history re-bills the kept messages as a cache
 *     write on the next request. With a warm provider cache that is waste; once the
 *     cache has expired the next request pays the write anyway — so past the
 *     threshold we wait for the cache to go cold, and NEVER compact a warm cache (owner's
 *     rule, 08/10). If it never cools, the engine's own auto-compaction runs at its limit —
 *     and with the cache still warm its SUMMARY is kept (chooseCompaction): it reads the prefix
 *     from the cache, while pruning would re-bill the kept 75–95% as a write (owner, 10/10).
 *   - thresholdFor: the threshold is a PERCENT of the window the engine applies right now
 *     (model limit or a smaller compaction window), so one setting fits 200K and 1M models.
 *
 * Measured basis (spike F0, Claude Code 2.1.291): docs/BACKLOG.md Q35.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  thresholdPercent: 30,        // % of the engine's window; past it, compact once the cache is cold
  minThresholdPercent: 10,     // the slider's range (and the clamp on hand-edited configs)
  maxThresholdPercent: 80,
  minIntervalMs: 10 * 60000,   // never two compactions closer than this
  preserveRecentMessages: 6,   // newest messages never touched (the first is always kept)
  truncateHeadChars: 300,      // what survives of a pruned result, before the note
  bigResultChars: 4000,        // an old result larger than this is truncated even if current
  minReductionRatio: 0.15,     // below this the engine's own summary runs instead
  // With a WARM cache the engine's auto-compaction summary is the cheap one: it reads the prefix
  // from the cache and leaves ~5% of the window. Our pruning keeps 75–95% and re-bills it as a
  // cache write — measured 09/10: −12% for a 780k-token write (~7× the summary's cost). Pruning
  // only beats the summary there above ~85% reduction (break-even), so that is the bar.
  warmMinReductionRatio: 0.85,
  // TTL used while no cache write has been observed for this host. The LONGER window on
  // purpose: assuming 5 min when the contract is 1 h would compact with the cache alive.
  unknownTtlMs: 60 * 60000,
});

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function size(m) {
  let n = (m.text || '').length;
  for (const u of m.toolUses || []) n += JSON.stringify(u.input || {}).length;
  for (const r of m.toolResults || []) n += (r.text || '').length;
  return n;
}

function note(reason, tool, input, cut) {
  const what = reason === 'superseded-read'
    ? `a later read/edit of ${String(input.file_path ?? '?')} supersedes it`
    : reason === 'failed-then-fixed'
      ? 'the same command later succeeded'
      : 'old, large output';
  return `\n[compaction: ${cut} chars of this ${tool} result pruned — ${what}]`;
}

/**
 * The engine's copies in a history it rebuilt after a compaction answered by a hook
 * (resume/continue). Exact rules only — see the comment inside. Also the RESUME SIGNAL:
 * a reloaded history with copies is a re-expanded one (sizes alone gave a false positive).
 * @returns {{list: object[], dropped: number}}
 */
export function dropEngineCopies(input) {
  // Exact duplicates go first. Resuming (-c/--resume) after a compaction answered by a hook,
  // the engine rebuilds the history with each kept copy INTERLEAVED with its original
  // (measured: 52 messages vs 22 — [thinking, tool_use, thinking', tool_use'], results in
  // pairs, [thinking', thinking, DONE, DONE']); the API then saw each tool_use twice and
  // rejected the latest assistant message's thinking. Two rules, both exact:
  //   1. a message whose tool ids were ALL seen before is a copy (tool ids are unique per call);
  //   2. a block of consecutive assistant messages is ONE API response (its tool results come
  //      in a user message after it). A block where every non-empty signature (tool id or
  //      text) appears exactly twice and the thinking-only rows are even in number was doubled:
  //      keep the first of each signature and half of the thinking-only rows.
  // Anything else is kept as it is — plain repeated text is never matched.
  const keep = input.map(() => true);
  const sig = (m) => {
    const uses = (m.toolUses || []).map((u) => u.tool_use_id);
    const res = (m.toolResults || []).map((r) => r.tool_use_id);
    if (uses.length || res.length) return `tool:${[...uses, ...res].sort().join(',')}`;
    return m.text ? `text:${m.role}\u0000${m.text}` : null; // null = thinking-only row
  };
  for (let i = 0; i < input.length;) {
    if (input[i].role !== 'assistant') { i++; continue; }
    let j = i;
    while (j < input.length && input[j].role === 'assistant') j++;
    const block = [];
    for (let k = i; k < j; k++) block.push(k);
    const counts = new Map();
    let empties = 0;
    for (const k of block) { const s = sig(input[k]); if (s == null) empties++; else counts.set(s, (counts.get(s) || 0) + 1); }
    // A copied block always carries a thinking-only row or a tool call; two identical texts alone
    // are not taken for a copy.
    const hasTool = [...counts.keys()].some((k) => k.startsWith('tool:'));
    const doubled = counts.size > 0 && (empties > 0 || hasTool) && [...counts.values()].every((c) => c === 2) && empties % 2 === 0;
    if (doubled) {
      const kept = new Set();
      let emptiesKept = 0;
      for (const k of block) {
        const s = sig(input[k]);
        if (s == null) { if (emptiesKept < empties / 2) emptiesKept++; else keep[k] = false; continue; }
        if (kept.has(s)) keep[k] = false; else kept.add(s);
      }
    }
    i = j;
  }
  const seenTool = new Set();
  input.forEach((m, i) => {
    if (!keep[i]) return;
    const ids = [...(m.toolUses || []).map((u) => `u:${u.tool_use_id}`), ...(m.toolResults || []).map((r) => `r:${r.tool_use_id}`)];
    if (!ids.length) return;
    if (ids.every((id) => seenTool.has(id))) { keep[i] = false; return; }
    for (const id of ids) seenTool.add(id);
  });
  const list = input.filter((_, i) => keep[i]);
  return { list, dropped: input.length - list.length };
}

/**
 * @param {ReadonlyArray<{role:string,text:string,toolUses?:Array<{tool_use_id:string,tool:string,input:object}>,toolResults?:Array<{tool_use_id:string,text:string,isError:boolean}>,handle?:string}>} messages
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{messages:object[], charsBefore:number, charsAfter:number, ratio:number,
 *   pruned:Array<{tool_use_id:string,tool:string,reason:string,savedChars:number}>, verbatimTextIntact:boolean,
 *   duplicatesDropped:number}}
 */
export function planCompaction(messages, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const input = Array.isArray(messages) ? messages : [];
  const { list, dropped: duplicatesDropped } = dropEngineCopies(input);
  const last = list.length - 1;
  const pinned = (i) => i === 0 || i > last - o.preserveRecentMessages;

  // Where each tool use lives; the last message touching each file / running each command OK.
  const useById = new Map();
  const lastFileTouch = new Map();
  const lastBashOk = new Map();
  list.forEach((m, i) => {
    for (const u of m.toolUses || []) {
      useById.set(u.tool_use_id, { tool: u.tool, input: u.input || {}, at: i });
      if (FILE_TOOLS.has(u.tool) && typeof (u.input || {}).file_path === 'string') lastFileTouch.set(u.input.file_path, i);
    }
  });
  list.forEach((m, i) => {
    for (const r of m.toolResults || []) {
      const u = useById.get(r.tool_use_id);
      if (u && u.tool === 'Bash' && !r.isError && typeof u.input.command === 'string') lastBashOk.set(u.input.command, i);
    }
  });

  const pruned = [];
  const out = list.map((m, i) => {
    if (pinned(i) || !(m.toolResults && m.toolResults.length)) return m;
    let changed = false;
    const results = m.toolResults.map((r) => {
      const u = useById.get(r.tool_use_id);
      if (!u) return r;
      let reason = null;
      const fp = typeof u.input.file_path === 'string' ? u.input.file_path : null;
      if (u.tool === 'Read' && fp && (lastFileTouch.get(fp) ?? -1) > u.at) reason = 'superseded-read';
      else if (u.tool === 'Bash' && r.isError && typeof u.input.command === 'string' && (lastBashOk.get(u.input.command) ?? -1) > i) reason = 'failed-then-fixed';
      else if ((r.text || '').length > o.bigResultChars) reason = 'big-old-result';
      if (!reason || (r.text || '').length <= o.truncateHeadChars) return r;
      const cut = r.text.length - o.truncateHeadChars;
      pruned.push({ tool_use_id: r.tool_use_id, tool: u.tool, reason, savedChars: cut });
      changed = true;
      return { ...r, text: r.text.slice(0, o.truncateHeadChars) + note(reason, u.tool, u.input, cut) };
    });
    if (!changed) return m;
    const { handle: _engineHandle, ...rest } = m; // rebuilt: the engine builds it from its fields
    void _engineHandle;
    return { ...rest, toolResults: results };
  });

  const charsBefore = input.reduce((n, m) => n + size(m), 0); // the cut counts the copies dropped
  const charsAfter = out.reduce((n, m) => n + size(m), 0);
  const verbatimTextIntact = out.length === list.length && out.every((m, i) => m.text === list[i].text && m.role === list[i].role);
  return { messages: out, charsBefore, charsAfter, ratio: charsBefore ? (charsBefore - charsAfter) / charsBefore : 0, pruned, verbatimTextIntact, duplicatesDropped };
}

/**
 * @param {{tokens?:number, now:number, lastAnswerAt?:number, lastCompactAt?:number, busy:boolean, ttlMs?:number}} s
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{action:'none', reason:string} | {action:'compact', reason:string} | {action:'wait', reason:'cache-warm', dueInMs:number}}
 */
export function decideTiming(s, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (s.busy) return { action: 'none', reason: 'busy' };
  if (s.tokens == null) return { action: 'none', reason: 'no-reading' };
  // thresholdTokens comes from thresholdFor() (a % of the engine's window, per prompt):
  // without a window reading there is no threshold — never act on a guess.
  if (!(Number(o.thresholdTokens) > 0)) return { action: 'none', reason: 'no-window' };
  if (s.tokens < o.thresholdTokens) return { action: 'none', reason: 'below-threshold' };
  if (s.lastCompactAt != null && s.now - s.lastCompactAt < o.minIntervalMs) return { action: 'none', reason: 'cooldown' };
  // No answer seen yet (and no resumed session's age): the cache's age is unknown — never
  // read that as "cold" (it compacted a fresh session's first prompt).
  if (s.lastAnswerAt == null) return { action: 'none', reason: 'cache-age-unknown' };
  const ttl = Number.isFinite(s.ttlMs) && s.ttlMs > 0 ? s.ttlMs : o.unknownTtlMs;
  const idle = s.now - s.lastAnswerAt;
  if (idle >= ttl) return { action: 'compact', reason: 'cache-cold' };
  return { action: 'wait', reason: 'cache-warm', dueInMs: ttl - idle };
}

/**
 * The threshold in tokens for the window the engine applies NOW. `window` is the
 * compaction window (`rawMaxTokens` of usage({breakdown}) — the model's limit or a smaller
 * one set by CLAUDE_CODE_AUTO_COMPACT_WINDOW/settings), falling back to the model window.
 * `aboveEngine`: the threshold sits at or past the engine's own auto-compact point — the
 * engine will compact first (through our pruning) and the gate will rarely act.
 * @param {{window?: number, engineAutoCompactAt?: number}} w
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{thresholdTokens: number|null, percent: number, aboveEngine: boolean}}
 */
/**
 * Is the provider cache still warm? Unknown last answer → assume warm: the engine's
 * auto-compaction fires mid-session, right after turns, and if the cache was in fact cold the
 * summary costs about what the next cold request would have paid anyway.
 * @param {{now:number, lastAnswerAt:(number|null), ttlMs:number}} s
 * @returns {boolean}
 */
export function isCacheWarm(s) {
  if (s.lastAnswerAt == null) return true;
  return s.now - s.lastAnswerAt < s.ttlMs;
}

/**
 * WHO compacts when the engine's compaction runs: our pruning (every message kept, stale tool
 * results cut) or the engine's own summary.
 *   - verbatim text not intact → the summary (never a broken transcript);
 *   - the ENGINE'S AUTO compaction with a WARM cache → the summary, unless pruning cuts at least
 *     `warmMinReductionRatio`: pruning there re-bills the kept 75–95% as a cache write while the
 *     summary reads the prefix from the cache (owner-approved 10/10 after the measurement above);
 *   - otherwise (cold cache, or a manual /compact) → pruning when it cuts `minReductionRatio`, or
 *     when it drops the engine's duplicate copies of a resumed history.
 * @param {{plan:{ratio:number, duplicatesDropped:number, verbatimTextIntact:boolean}, trigger:string, warm:boolean}} s
 * @returns {{ours:boolean, why:string}}
 */
export function chooseCompaction(s, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { plan, trigger, warm } = s;
  if (!plan.verbatimTextIntact) return { ours: false, why: 'verbatim-not-intact' };
  if (warm && trigger === 'auto') {
    return plan.ratio >= o.warmMinReductionRatio
      ? { ours: true, why: 'warm-but-big-cut' }
      : { ours: false, why: 'warm-cache-summary-is-cheaper' };
  }
  if (plan.duplicatesDropped > 0) return { ours: true, why: 'engine-copies-dropped' };
  return plan.ratio >= o.minReductionRatio ? { ours: true, why: 'pruned' } : { ours: false, why: 'cut-too-small' };
}

export function thresholdFor(w, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const pct = clampPercent(o.thresholdPercent, o);
  const window = Number(w && w.window);
  if (!(window > 0)) return { thresholdTokens: null, percent: pct, aboveEngine: false };
  const thresholdTokens = Math.round(window * pct / 100);
  const engine = Number(w && w.engineAutoCompactAt);
  return { thresholdTokens, percent: pct, aboveEngine: engine > 0 && thresholdTokens >= engine };
}

/** The configured percent, inside the slider's range (a hand-edited config included). */
export function clampPercent(v, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.thresholdPercent;
  return Math.min(o.maxThresholdPercent, Math.max(o.minThresholdPercent, Math.round(n)));
}

/**
 * A resumed/continued session (`--resume`, `-c`): after a compaction answered by a hook,
 * Claude Code reloads the ORIGINAL history with the kept copies interleaved (measured,
 * BACKLOG Q35). Re-expanded = the reloaded history HAS those copies (dropEngineCopies) —
 * exact. A size comparison (reloaded estimate vs the last response) was tried and gave a
 * false positive on an uncompacted session (140k estimated vs 75k real), compacting with a
 * warm cache. Re-expanded is pruned again before anything reaches the API.
 * @param {{messages: object[], lastTokens?: number}} s
 */
export function classifyResume(s) {
  const { dropped } = dropEngineCopies(Array.isArray(s.messages) ? s.messages : []);
  return { reexpanded: dropped > 0, copies: dropped, lastTokens: Number.isFinite(s.lastTokens) ? s.lastTokens : 0 };
}

/** Rough tokens of a message list read as JSON (4 chars/token: sizing, never billing). */
export function estimateTokens(messages) {
  return Math.round(JSON.stringify(messages || []).length / 4);
}
