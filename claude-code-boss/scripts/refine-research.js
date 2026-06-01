#!/usr/bin/env node
/**
 * Refine Research — Stop hook (throttled).
 *
 * Reminds the agent to research and answer its own pending questions instead of
 * waiting for the user. Throttled (every Nth Stop) so it doesn't burn tokens on
 * every turn.
 *
 * Anti-loop: honors `stop_hook_active` per
 * https://docs.claude.com/en/docs/claude-code/hooks#stop-hook-active
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const STATE = path.join(DATA_DIR, '.runtime', 'refine-research-state.json');
const EVERY = 4; // remind at most once per 4 stops

const { readStdin, emitStopBlock } = require('./lib/hook-io.js');

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
    if (!raw) { process.stdout.write('{}'); return; }

    const event = JSON.parse(raw);
    // Anti-loop guard: if Claude already retried this hook, allow stop.
    if (event.stop_hook_active) { process.stdout.write('{}'); return; }

    const n = tick();
    if (n % EVERY !== 0) { process.stdout.write('{}'); return; }

    emitStopBlock(
      '[refine] If you asked questions in your previous response, research the ' +
      'answers now using project files (Read, Grep, Glob) and web search ' +
      '(WebSearch, WebFetch). Do NOT wait for the user — resolve the gaps ' +
      'yourself, then proceed with the task.'
    );
  } catch (err) {
    console.error(`[REFINE-RESEARCH] Error: ${err.message}`);
    process.stdout.write('{}');
  }
})();
