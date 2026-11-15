'use strict';
/**
 * lib/hook-merge.js — merge the outputs of several hooks that ran for one tool call into the
 * single output the host reads, the way the host merges sibling hooks of the same matcher:
 * a decision of `deny` beats `ask` beats `allow`, every `additionalContext` and
 * `systemMessage` is kept, and an `updatedInput` only survives a call that is not denied.
 */

const RANK = { deny: 3, ask: 2, allow: 1 };

/**
 * @param {string[]} texts  the stdout text of each hook ('' or '{}' = nothing to say)
 * @param {{onBad?: (err: Error, text: string) => void}} [opts]  called for an unparsable output, which is skipped
 * @returns {string} merged JSON, or '{}' when no hook had anything to say
 */
function mergeHookOutputs(texts, { onBad } = {}) {
  const outs = [];
  for (const text of texts) {
    if (!text || text === '{}') continue;
    try {
      const o = JSON.parse(text);
      if (o && typeof o === 'object' && Object.keys(o).length) outs.push(o);
    } catch (err) {
      if (onBad) onBad(err, text);
    }
  }
  if (!outs.length) return '{}';

  const merged = {};
  const messages = [];
  const contexts = [];
  let hso = null;
  let decision = null;
  let reason = null;
  let updatedInput = null;
  for (const o of outs) {
    if (o.systemMessage) messages.push(o.systemMessage);
    for (const [k, v] of Object.entries(o)) {
      if (k !== 'systemMessage' && k !== 'hookSpecificOutput' && !(k in merged)) merged[k] = v;
    }
    const h = o.hookSpecificOutput;
    if (!h) continue;
    hso = hso || { hookEventName: h.hookEventName };
    if (h.additionalContext) contexts.push(h.additionalContext);
    const d = h.permissionDecision;
    if (d && (!decision || (RANK[d] || 0) > (RANK[decision] || 0))) {
      decision = d;
      reason = h.permissionDecisionReason || null;
      updatedInput = h.updatedInput || null;
    } else if (d && d === decision && !updatedInput && h.updatedInput) {
      updatedInput = h.updatedInput;
    }
  }
  if (messages.length) merged.systemMessage = messages.join(' ');
  if (hso) {
    if (contexts.length) hso.additionalContext = contexts.join('\n\n');
    if (decision) {
      hso.permissionDecision = decision;
      if (reason) hso.permissionDecisionReason = reason;
      if (decision !== 'deny' && updatedInput) hso.updatedInput = updatedInput;
    }
    merged.hookSpecificOutput = hso;
  }
  return JSON.stringify(merged);
}

module.exports = { mergeHookOutputs };
