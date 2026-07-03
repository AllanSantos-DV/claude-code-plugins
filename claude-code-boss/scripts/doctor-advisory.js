#!/usr/bin/env node
/**
 * doctor-advisory.js — SessionStart hook (U3).
 *
 * Runs ONLY the cheap, critical doctor checks (Node version + env resolution —
 * no network/FS scans) and, when something critical is broken, injects a single
 * one-line advisory pointing at `npm run doctor`. Cooldown-guarded so it nags at
 * most once per cooldown window, and silent when everything's fine.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const { checkNode, checkEnv } = require('./doctor.js');

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most once per 6h

function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  return (env && !env.includes('${'))
    ? env : path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

function stampPath() {
  return path.join(dataDir(), '.runtime', 'doctor-advisory-last.json');
}

function onCooldown(p) {
  try {
    const last = JSON.parse(fs.readFileSync(p, 'utf8')).ts;
    return Number.isFinite(last) && (Date.now() - last) < COOLDOWN_MS;
  } catch { /* absent → not on cooldown */ return false; }
}

function stamp(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify({ ts: Date.now() })); }
  catch (e) { void e; }
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { /* defaults */ }
  const eventName = event.hook_event_name || 'SessionStart';

  const ctx = {
    nodeVersion: process.version,
    env: { root: process.env.CLAUDE_PLUGIN_ROOT || '', data: process.env.CLAUDE_PLUGIN_DATA || '' },
  };
  const criticalFails = [checkNode(ctx), checkEnv(ctx)].filter(r => r.status === 'fail');
  if (criticalFails.length === 0) return emitEmpty();

  const sp = stampPath();
  if (onCooldown(sp)) return emitEmpty();
  stamp(sp);

  const items = criticalFails.map(r => `${r.label}: ${r.detail}`).join('; ');
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `[DOCTOR] Critical setup issue — ${items}. Run \`npm run doctor\` (or the dashboard Doctor button) for the fix.`,
    },
  });
}

if (require.main === module) {
  main().catch((err) => { console.error(`[doctor-advisory] ${err.message}`); emitEmpty(); });
}

module.exports = { onCooldown, stampPath, COOLDOWN_MS };
