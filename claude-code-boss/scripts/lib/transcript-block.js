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
function extractCycles(lines) {
  const cycles = [];
  const byPrompt = new Map(); // promptId → cycle (dedupe multi-envelope human turns)
  let current = null; // the cycle assistant text attaches to

  for (const line of lines || []) {
    const o = _asObj(line);
    if (_excluded(o)) continue;

    if (o.type === 'user') {
      const text = _userText(o.message);
      if (text == null) continue; // tool return or empty → not a human turn
      const pid = o.promptId || `__anon-${cycles.length}`;
      if (byPrompt.has(pid)) {
        const c = byPrompt.get(pid); // same human turn split across envelopes → append
        c.user += (c.user ? '\n' : '') + text;
        current = c;
      } else {
        const c = { promptId: pid, user: text, assistant: '' };
        byPrompt.set(pid, c);
        cycles.push(c);
        current = c;
      }
    } else if (o.type === 'assistant') {
      if (!current) continue; // assistant with no preceding human turn → skip
      const text = _assistantText(o.message);
      if (text) current.assistant += (current.assistant ? '\n' : '') + text;
    }
    // other top-level types (attachment, last-prompt, queue-operation) ignored
  }
  return cycles;
}

/**
 * Render cycles into a role-marked block, HARD-capped at maxChars. Keeps the
 * most RECENT cycles when over budget (newest context is most relevant) and
 * guarantees the returned string length ≤ maxChars.
 */
function renderBlock(cycles, maxChars) {
  const cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 12000;
  const rendered = (cycles || []).map(c => `## USER\n${c.user}\n## ASSISTANT\n${c.assistant}`);
  const kept = [];
  let total = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const add = rendered[i].length + (kept.length ? 2 : 0); // '\n\n' join cost
    if (total + add > cap) break;
    kept.unshift(rendered[i]);
    total += add;
  }
  let out = kept.join('\n\n');
  if (out.length > cap) out = out.slice(0, cap); // hard guarantee even for one huge cycle
  return out;
}

module.exports = { extractCycles, renderBlock, _userText, _assistantText };
