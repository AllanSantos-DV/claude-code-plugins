'use strict';
/**
 * transcript-block.js — deterministic clean of a Claude Code transcript JSONL
 * slice into human prompt CYCLES, for lesson capture (Phase 1, task 2).
 *
 * A "cycle" = one human prompt (deduped by promptId) + the assistant's TEXT
 * reply. Everything is stripped MECHANICALLY here (NO content regex, NO semantic
 * judgment — that is the agent's job):
 *   - exclude sub-agent turns (isSidechain / agentId)
 *   - exclude hook feedback (isMeta) and compaction summaries (isCompactSummary)
 *   - exclude tool-return user envelopes (content carries tool_result, not human)
 *   - keep only assistant content blocks of type 'text' (drop thinking/tool_use/tool_result)
 *
 * Counting cycles (not raw envelopes) matters: a real transcript had 237 user
 * envelopes but only 13 distinct human promptIds.
 */

function _asObj(line) {
  if (line && typeof line === 'object') return line;
  try { return JSON.parse(line); } catch (err) { void err; return null; }
}

/** Human user text: string content or joined 'text' blocks; null if it's a tool return. */
function _userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null; // tool return, not a human turn
    const parts = c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/** Assistant text: only 'text' content blocks (drop thinking/tool_use/tool_result). */
function _assistantText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  }
  return '';
}

function _excluded(o) {
  return !o || o.isSidechain === true || !!o.agentId || o.isMeta === true || o.isCompactSummary === true;
}

/**
 * Reduce raw JSONL lines (strings or parsed objects) into ordered human cycles.
 * @param {Array<string|object>} lines
 * @returns {Array<{promptId:string, user:string, assistant:string}>}
 */
function _newAcc() {
  return { cycles: [], byPrompt: new Map(), current: null };
}

// Fold one parsed envelope into the accumulator. endOffset (absolute byte offset
// just AFTER this envelope's line incl the '\n') is recorded on the cycle so a
// caller can advance a byte cursor over exactly the cycles it consumed.
function _step(acc, o, endOffset) {
  if (_excluded(o)) return;
  if (o.type === 'user') {
    const text = _userText(o.message);
    if (text == null) return; // tool return or empty → not a human turn
    const pid = o.promptId || `__anon-${acc.cycles.length}`;
    let c = acc.byPrompt.get(pid);
    if (c) {
      c.user += (c.user ? '\n' : '') + text; // multi-envelope human turn → append
    } else {
      c = { promptId: pid, user: text, assistant: '', endOffset };
      acc.byPrompt.set(pid, c);
      acc.cycles.push(c);
    }
    if (endOffset != null) c.endOffset = endOffset;
    acc.current = c;
  } else if (o.type === 'assistant') {
    if (!acc.current) return; // assistant with no preceding human turn → skip
    const text = _assistantText(o.message);
    if (text) acc.current.assistant += (acc.current.assistant ? '\n' : '') + text;
    if (endOffset != null) acc.current.endOffset = endOffset;
  }
  // other top-level types (attachment, last-prompt, queue-operation) ignored
}

/**
 * Reduce raw JSONL lines (strings or parsed objects) into ordered human cycles.
 * @param {Array<string|object>} lines
 * @returns {Array<{promptId:string, user:string, assistant:string}>}
 */
function extractCycles(lines) {
  const acc = _newAcc();
  for (const line of lines || []) _step(acc, _asObj(line), null);
  return acc.cycles;
}

/**
 * Same reduction over a raw byte Buffer, attaching to each cycle `endOffset` =
 * absolute byte offset (fromOffset + position) just AFTER the cycle's last line —
 * so a byte cursor advances over exactly the cycles a caller consumes.
 * @param {Buffer} buf
 * @param {number} fromOffset  absolute byte offset of buf[0] within the file
 * @returns {Array<{promptId:string, user:string, assistant:string, endOffset:number}>}
 */
function extractCyclesFromBuffer(buf, fromOffset) {
  const acc = _newAcc();
  const base = typeof fromOffset === 'number' ? fromOffset : 0;
  let pos = 0;
  const n = buf.length;
  while (pos < n) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? n : nl;
    const nextPos = nl === -1 ? n : nl + 1;
    const lineStr = buf.toString('utf8', pos, end);
    if (lineStr) _step(acc, _asObj(lineStr), base + nextPos);
    pos = nextPos;
  }
  return acc.cycles;
}

/**
 * Pack cycles into a role-marked block, OLDEST-first (FIFO), HARD-capped at
 * maxChars. Always includes at least the oldest cycle (truncated if it alone
 * exceeds the cap) so a fired offer is never empty. Returns { text, kept } where
 * kept = number of leading cycles included — the caller advances its cursor over
 * exactly those, leaving the rest for the next window (never skipped).
 */
function packCycles(cycles, maxChars) {
  const cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 12000;
  const list = cycles || [];
  const parts = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const piece = `## USER\n${list[i].user}\n## ASSISTANT\n${list[i].assistant}`;
    const add = piece.length + (parts.length ? 2 : 0); // '\n\n' join cost
    if (parts.length > 0 && total + add > cap) break; // always keep at least the oldest
    parts.push(piece);
    total += add;
  }
  let text = parts.join('\n\n');
  if (text.length > cap) text = text.slice(0, cap); // hard guarantee for a lone huge cycle
  return { text, kept: parts.length };
}

/** Back-compat: the packed text only (oldest-first, hard-capped). */
function renderBlock(cycles, maxChars) {
  return packCycles(cycles, maxChars).text;
}

module.exports = { extractCycles, extractCyclesFromBuffer, renderBlock, packCycles, _userText, _assistantText };
