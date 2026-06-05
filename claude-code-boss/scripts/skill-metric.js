#!/usr/bin/env node
/**
 * skill-metric.js — PostToolUse:Skill hook (Plan #9 Loop 4).
 *
 * Records `skill.invoked` metric every time the agent fires the Skill tool.
 * Pure instrumentation — never emits stop blocks, never blocks. Failures
 * degrade silently so a skill invocation is never disrupted by telemetry.
 */
'use strict';

const path = require('path');

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  if (ev.tool_name !== 'Skill') return emitEmpty();

  const input = ev.tool_input || {};
  const skillName = input.skill || input.skillName || input.name || '';
  if (!skillName) return emitEmpty();

  metrics.fire('skill.invoked', { skillName: String(skillName).slice(0, 80) }, {
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
