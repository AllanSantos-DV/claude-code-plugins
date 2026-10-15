#!/usr/bin/env node
/**
 * skill-metric.js — UserPromptExpansion + PostToolUse(Skill) hook (Plan #9 Loop 4).
 *
 * Records `skill.invoked` for both ways a skill runs: the user types a
 * `/skill` or `/command` (UserPromptExpansion, `command`), or the model calls
 * the Skill tool (PostToolUse matcher `Skill`, `tool_input.skill`). The tool
 * path is ~99% of the invocations. Pure instrumentation: never blocks, fails silent.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

/** Side-effect only (records the metric); the reply is always `{}`. */
async function run(ev) {
  ev = ev || {};
  const viaTool = ev.tool_name === 'Skill';
  const input = viaTool && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const cmd = viaTool ? input.skill || '' : ev.command || ev.command_name || '';
  const skillName = String(cmd).trim().replace(/^\//, '').split(/\s/)[0].slice(0, 80);
  if (!skillName) return;

  metrics.fire('skill.invoked', { skillName, via: viaTool ? 'tool' : 'typed' }, {
    sessionId: ev.session_id || ev.sessionId,
    cwd: ev.cwd,
  });
}

async function main() {
  const raw = await readStdin();
  await run(parsePayload(raw));
  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[skill-metric] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { main, run };
