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

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => resolve(d));
  });
}

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

(async () => {
  try {
    const raw = await readStdin();
    // Anti-loop guard: if Claude already retried this hook, allow stop.
    // https://code.claude.com/docs/en/hooks#stop_hook_active
    try {
      const input = JSON.parse(raw || '{}');
      if (input.stop_hook_active) { process.stdout.write('{}'); return; }
    } catch { /* malformed input — fall through */ }
    const n = tick();
    if (n % EVERY !== 0) { process.stdout.write('{}'); return; }
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        'If a reusable workflow pattern emerged in this session (a shape worth ' +
        'repeating), capture it via the `capture_lesson` MCP tool (type: "pattern"). ' +
        'Only durable, generalizable patterns — skip one-offs.',
    }));
  } catch {
    process.stdout.write('{}');
  }
})();
