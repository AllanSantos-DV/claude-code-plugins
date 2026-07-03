#!/usr/bin/env node
/**
 * pattern-detect.js — Stop hook (lean, throttled advisory).
 *
 * DESIGN (in-loop capture): instead of dumping the transcript for a separate
 * analyzer subagent to re-read (expensive/lossy), we just occasionally remind the
 * in-loop agent to capture reusable workflow patterns via the `capture_lesson` MCP
 * tool (type: pattern). The agent — with full context — writes the curated pattern;
 * the tool dedups/merges (bumping recurrence). Throttled so it doesn't nag.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const STATE = path.join(DATA_DIR, '.runtime', 'pattern-detect-state.json');
const EVERY = 6; // remind at most once per 6 stops

const { runStopDetectorCli } = require('./lib/hook-io.js');
const metrics = require('./lib/metrics.js');
const hooksCfg = require('./lib/hooks-config.js');

const REASON =
  'If a reusable workflow pattern emerged in this session (a shape worth ' +
  'repeating), capture it via the `capture_lesson` MCP tool (type: "pattern"). ' +
  'Only durable, generalizable patterns — skip one-offs.';

function tick() {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(STATE, 'utf-8')).n || 0; } catch { /* fresh */ }
  n += 1;
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ n }));
  } catch { /* best effort */ }
  return n;
}

async function run(event) {
  const input = event || {};
  if (!hooksCfg.getPatternDetect().enabled) return {};
  // Anti-loop guard: if Claude already retried this hook, allow stop.
  // https://code.claude.com/docs/en/hooks#stop_hook_active
  if (input.stop_hook_active) return {};
  const n = tick();
  if (n % EVERY !== 0) return {};
  metrics.fire('nudge.emitted', { kind: 'pattern' }, { sessionId: input.session_id || input.sessionId, cwd: input.cwd });
  return { block: true, reason: REASON };
}

if (require.main === module) {
  runStopDetectorCli(run, 'pattern-detect');
}

module.exports = { run };
