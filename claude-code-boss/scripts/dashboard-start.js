#!/usr/bin/env node
/**
 * dashboard-start — SessionStart hook script.
 * Ensures the dashboard is running, starting it as a detached background
 * process only when not already alive. PID-file idempotency prevents
 * duplicate processes across multiple Claude sessions.
 *
 * Hook contract: must write JSON to stdout and exit 0.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PLUGIN_ROOT, '.runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'dashboard.pid');
const DASHBOARD_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'dashboard.js');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { const alive = err.code !== 'ESRCH'; return alive; }
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10); }
  catch (err) { void err; return null; }
}

function writePid(pid) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid));
  } catch (err) {
    process.stderr.write(`[DASHBOARD-START] Failed to write PID file: ${err.message}\n`);
  }
}

function run() {
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isAlive(existingPid)) {
    process.stdout.write(JSON.stringify({ ok: true, status: 'already-running', pid: existingPid }) + '\n');
    return;
  }

  // Spawn detached, no stdio inheritance — it writes its own dashboard.json
  const child = spawn(process.execPath, [DASHBOARD_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DASHBOARD_NO_OPEN: '0', // allow browser open on first start
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
  });
  child.unref();
  writePid(child.pid);

  process.stdout.write(JSON.stringify({ ok: true, status: 'started', pid: child.pid }) + '\n');
}

run();
