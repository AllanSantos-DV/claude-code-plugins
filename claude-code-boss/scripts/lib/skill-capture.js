'use strict';
/**
 * skill-capture.js — pure validation for `capture_lesson` `type:"skill"`.
 *
 * ADR: type:"skill" fixes the root cause of the dead skill-promotion loop —
 * `summary` was never authored with a Skill's frontmatter `description` in mind
 * (no length budget, no USE-FOR/DO-NOT-USE-FOR shape), so brain-promote.js had to
 * truncate it post-hoc, silently destroying meaning (a cut before a "do NOT use
 * for" qualifier changes the skill's trigger condition). The fix moves the
 * constraint to the SOURCE: the acting agent, already in-loop with full context
 * (the Reflexion/ExpeL pattern this plugin already uses — see bff3e40), fills a
 * validated template AT CAPTURE TIME. Mechanical rejection (not a hopeful prompt)
 * guarantees the shape, mirroring `policy_activate`'s validation style in this
 * same server: out-of-range → `isError`, nothing stored, caller retries.
 *
 * No I/O, no store access — pure so it's testable without booting the MCP server.
 */

const DESCRIPTION_MIN = 40;
const DESCRIPTION_MAX = 280; // same budget brain-promote.js's legacy truncation already used
const USE_FOR_MAX = 400;
const DO_NOT_USE_FOR_MAX = 400;

/**
 * @param {{description?: unknown, useFor?: unknown, doNotUseFor?: unknown}} fields
 * @param {{descriptionMin?: number, descriptionMax?: number, useForMax?: number, doNotUseForMax?: number}} [limits]
 *   Overridable via config/brain-config.json `kb.skillCapture` (lib/brain-config.js
 *   getSkillCapture()). Defaults to the module constants above when omitted — this
 *   function stays a pure computation either way (no I/O, no config read here).
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
function validateSkillFields(fields, limits) {
  const lim = limits || {};
  const descMin = Number.isFinite(lim.descriptionMin) ? lim.descriptionMin : DESCRIPTION_MIN;
  const descMax = Number.isFinite(lim.descriptionMax) ? lim.descriptionMax : DESCRIPTION_MAX;
  const useForMax = Number.isFinite(lim.useForMax) ? lim.useForMax : USE_FOR_MAX;
  const doNotUseForMax = Number.isFinite(lim.doNotUseForMax) ? lim.doNotUseForMax : DO_NOT_USE_FOR_MAX;
  const f = fields || {};
  const description = typeof f.description === 'string' ? f.description.trim() : '';
  const useFor = typeof f.useFor === 'string' ? f.useFor.trim() : '';
  const doNotUseFor = typeof f.doNotUseFor === 'string' ? f.doNotUseFor.trim() : '';

  if (!description) {
    return { ok: false, reason: 'description-missing', message: 'capture_lesson: type:"skill" requires `description` (a non-empty string). Nothing was stored.' };
  }
  if (description.length < descMin) {
    return {
      ok: false, reason: 'description-too-short',
      message: `capture_lesson: type:"skill" \`description\` is ${description.length} chars, below the minimum of ${descMin}. Write a fuller trigger condition (when should this be used?). Nothing was stored.`,
    };
  }
  if (description.length > descMax) {
    return {
      ok: false, reason: 'description-too-long',
      message: `capture_lesson: type:"skill" \`description\` is ${description.length} chars, over the maximum of ${descMax} (skills are always-loaded context — this is not truncated for you). Shorten it and retry. Nothing was stored.`,
    };
  }
  if (!useFor) {
    return { ok: false, reason: 'use-for-missing', message: 'capture_lesson: type:"skill" requires `useFor` (a non-empty string: when this skill applies). Nothing was stored.' };
  }
  if (useFor.length > useForMax) {
    return {
      ok: false, reason: 'use-for-too-long',
      message: `capture_lesson: type:"skill" \`useFor\` is ${useFor.length} chars, over the maximum of ${useForMax}. Shorten it and retry. Nothing was stored.`,
    };
  }
  if (!doNotUseFor) {
    return { ok: false, reason: 'do-not-use-for-missing', message: 'capture_lesson: type:"skill" requires `doNotUseFor` (a non-empty string: when this skill does NOT apply). Nothing was stored.' };
  }
  if (doNotUseFor.length > doNotUseForMax) {
    return {
      ok: false, reason: 'do-not-use-for-too-long',
      message: `capture_lesson: type:"skill" \`doNotUseFor\` is ${doNotUseFor.length} chars, over the maximum of ${doNotUseForMax}. Shorten it and retry. Nothing was stored.`,
    };
  }
  return { ok: true, description, useFor, doNotUseFor };
}

module.exports = { validateSkillFields, DESCRIPTION_MIN, DESCRIPTION_MAX, USE_FOR_MAX, DO_NOT_USE_FOR_MAX };
