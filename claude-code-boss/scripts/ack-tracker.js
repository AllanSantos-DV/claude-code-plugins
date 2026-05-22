#!/usr/bin/env node
/**
 * ACK Tracker — Tracks subagent lifecycle events (start/stop) and
 * reports active subagent count.
 *
 * Usage:
 *   node ack-tracker.js start   — increment active count
 *   node ack-tracker.js stop    — decrement active count
 *   node ack-tracker.js report  — print current counts
 *   node ack-tracker.js reset   — reset all counters
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const STATE_FILE = path.join(STATE_DIR, 'ack-state.json');

function getState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { activeSubagents: 0, totalSpawned: 0, totalCompleted: 0, history: [] };
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[ACK] Failed to save state: ${err.message}`);
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case 'start': {
    const state = getState();
    state.activeSubagents++;
    state.totalSpawned++;
    state.history.push({
      type: 'spawn',
      ts: new Date().toISOString(),
      active: state.activeSubagents,
    });
    saveState(state);
    break;
  }
  case 'stop': {
    const state = getState();
    state.activeSubagents = Math.max(0, state.activeSubagents - 1);
    state.totalCompleted++;
    state.history.push({
      type: 'complete',
      ts: new Date().toISOString(),
      active: state.activeSubagents,
    });
    saveState(state);
    break;
  }
  case 'report': {
    const state = getState();
    const report = {
      activeSubagents: state.activeSubagents,
      totalSpawned: state.totalSpawned,
      totalCompleted: state.totalCompleted,
      timestamp: new Date().toISOString(),
    };
    console.error(`[ACK] Active: ${report.activeSubagents}, Total spawned: ${report.totalSpawned}, Completed: ${report.totalCompleted}`);
    break;
  }
  case 'reset': {
    saveState({ activeSubagents: 0, totalSpawned: 0, totalCompleted: 0, history: [] });
    console.error('[ACK] Counter reset');
    break;
  }
  default: {
    const state = getState();
    console.error(`[ACK] Active: ${state.activeSubagents}, Total: ${state.totalSpawned}, Done: ${state.totalCompleted}`);
    break;
  }
}

// Hook protocol: always output empty JSON object
process.stdout.write(JSON.stringify({}));
