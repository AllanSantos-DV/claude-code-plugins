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
 *     threshold we wait for the cache to go cold, unless the hard ceiling forces it.
 *
 * Measured basis (spike F0, Claude Code 2.1.291): docs/BACKLOG.md Q35.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  thresholdTokens: 250000,     // compact past this, once the provider cache is cold
  hardCeilingTokens: 400000,   // past this, compact now even with a warm cache
  minIntervalMs: 10 * 60000,   // never two compactions closer than this
  preserveRecentMessages: 6,   // newest messages never touched (the first is always kept)
  truncateHeadChars: 300,      // what survives of a pruned result, before the note
  bigResultChars: 4000,        // an old result larger than this is truncated even if current
  minReductionRatio: 0.15,     // below this the engine's own summary runs instead
  // TTL used while no cache write has been observed for this host. The LONGER window on
  // purpose: assuming 5 min when the contract is 1 h would compact with the cache alive.
  unknownTtlMs: 60 * 60000,
  resumeExpansionFactor: 1.5,  // reloaded history this much larger than the last response…
  resumeMinGrowthTokens: 20000, // …and at least this many tokens larger = re-expanded
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
 * @param {ReadonlyArray<{role:string,text:string,toolUses?:Array<{tool_use_id:string,tool:string,input:object}>,toolResults?:Array<{tool_use_id:string,text:string,isError:boolean}>,handle?:string}>} messages
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{messages:object[], charsBefore:number, charsAfter:number, ratio:number,
 *   pruned:Array<{tool_use_id:string,tool:string,reason:string,savedChars:number}>, verbatimTextIntact:boolean,
 *   duplicatesDropped:number}}
 */
export function planCompaction(messages, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const input = Array.isArray(messages) ? messages : [];
  // Exact duplicates go first. Resuming (-c/--resume) after a compaction answered by a hook,
  // the engine rebuilds the history with the kept copies AND the originals (measured: 46
  // messages vs 18; the API then saw the same tool_use twice and rejected the thinking of the
  // latest assistant message). Tool ids are unique per call, so a message whose tool ids were
  // all seen before is a copy; plain text is never matched (a repeated "ok" is legitimate).
  // The copies form one contiguous run. Inside it, a text message identical to an earlier one
  // is a copy too (its thinking was what the API rejected); the run opens at a tool-id copy —
  // and reaches back over the repeated text right before it — and closes at the first message
  // that is new (a new tool id, or a text never seen). Outside a run, repeated text is kept.
  const seenUse = new Set();
  const seenRes = new Set();
  const firstText = new Map(); // textKey → index of its first occurrence
  const keep = input.map(() => true);
  let inCopyRun = false;
  input.forEach((m, i) => {
    const uses = (m.toolUses || []).map((u) => u.tool_use_id);
    const res = (m.toolResults || []).map((r) => r.tool_use_id);
    const textKey = m.text ? `${m.role}\u0000${m.text}` : null;
    const repeatedText = textKey != null && firstText.has(textKey) && firstText.get(textKey) < i;
    if (!uses.length && !res.length) {
      if (inCopyRun && repeatedText) { keep[i] = false; return; }
      if (inCopyRun && textKey && !repeatedText) inCopyRun = false;
      if (textKey && !firstText.has(textKey)) firstText.set(textKey, i);
      return;
    }
    const dup = uses.every((id) => seenUse.has(id)) && res.every((id) => seenRes.has(id));
    if (dup) {
      if (!inCopyRun) { // reach back over the repeated text the run started with
        for (let j = i - 1; j >= 0 && keep[j]; j--) {
          const p = input[j];
          const pk = p.text ? `${p.role}\u0000${p.text}` : null;
          if ((p.toolUses || []).length || (p.toolResults || []).length || !pk || !(firstText.get(pk) < j)) break;
          keep[j] = false;
        }
      }
      inCopyRun = true;
      keep[i] = false;
      return;
    }
    inCopyRun = false;
    for (const id of uses) seenUse.add(id);
    for (const id of res) seenRes.add(id);
    if (textKey && !firstText.has(textKey)) firstText.set(textKey, i);
  });
  const list = input.filter((_, i) => keep[i]);
  const duplicatesDropped = input.length - list.length;
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
  if (s.tokens < o.thresholdTokens) return { action: 'none', reason: 'below-threshold' };
  if (s.lastCompactAt != null && s.now - s.lastCompactAt < o.minIntervalMs) return { action: 'none', reason: 'cooldown' };
  if (s.tokens >= o.hardCeilingTokens) return { action: 'compact', reason: 'hard-ceiling' };
  // No answer seen yet (and no resumed session's age): the cache's age is unknown — never
  // read that as "cold" (it compacted a fresh session's first prompt). Only the ceiling acts.
  if (s.lastAnswerAt == null) return { action: 'none', reason: 'cache-age-unknown' };
  const ttl = Number.isFinite(s.ttlMs) && s.ttlMs > 0 ? s.ttlMs : o.unknownTtlMs;
  const idle = s.now - s.lastAnswerAt;
  if (idle >= ttl) return { action: 'compact', reason: 'cache-cold' };
  return { action: 'wait', reason: 'cache-warm', dueInMs: ttl - idle };
}

/**
 * A resumed/continued session (`--resume`, `-c`): after a compaction answered by a
 * hook, Claude Code reloads the ORIGINAL history (measured, BACKLOG Q35). The size
 * the last response had (SessionStart `context_tokens`) is the pruned size; a
 * reloaded history much larger than it was re-expanded and is pruned again before
 * anything reaches the API — the provider cache holds the pruned prefix, not this one.
 * @param {{reloadedTokens:number, lastTokens?:number}} s
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function classifyResume(s, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const last = Number.isFinite(s.lastTokens) ? s.lastTokens : 0;
  // Not tied to the threshold: a manual /compact at 100k reloads as 100k vs 7k — re-expanded all the same.
  const reexpanded = s.reloadedTokens > last * o.resumeExpansionFactor && s.reloadedTokens - last >= o.resumeMinGrowthTokens;
  return { reexpanded, reloadedTokens: s.reloadedTokens, lastTokens: last };
}

/** Rough tokens of a message list read as JSON (4 chars/token: sizing, never billing). */
export function estimateTokens(messages) {
  return Math.round(JSON.stringify(messages || []).length / 4);
}
