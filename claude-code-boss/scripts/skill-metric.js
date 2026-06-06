#!/usr/bin/env node
/**
 * skill-metric.js — UserPromptExpansion hook (Plan #9 Loop 4).
 *
 * Records `skill.invoked` whenever the user types a `/skill` or `/command`
 * that expands into a prompt. Claude Code does NOT emit PostToolUse for the
 * Skill tool — UserPromptExpansion is the only surface that fires when a
 * user-typed skill expands. Pure instrumentation: never blocks, fails silent.
 */
'use strict';

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  const cmd = ev.command || ev.command_name || '';
  const skillName = String(cmd).replace(/^\//, '').split(/\s/)[0].slice(0, 80);
  if (!skillName) return emitEmpty();

  metrics.fire('skill.invoked', { skillName }, {
    sessionId: ev.session_id || ev.sessionId,
    cwd: ev.cwd,
  });

  return emitEmpty();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[skill-metric] crashed: ${err.message}`);
    emitEmpty();
  });
}

module.exports = { main };
