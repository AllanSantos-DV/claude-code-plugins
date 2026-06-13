#!/usr/bin/env node
/**
 * skill-promote-trigger.js — Stop hook (Plan #9 Loop 1).
 *
 * Periodically runs `brain-promote.js scan` so recurring lessons that crossed
 * the threshold get drafted into staging without the user having to remember
 * to click the dashboard's Scan button.
 *
 * Cooldown: at most once per `cooldownMs` (default 10 min) per data dir.
 * The scan is cheap (~hundreds of ms) and idempotent — drafts overwrite by
 * slug — so a periodic re-run is safe. If `kb.skillPromotion.enabled === false`
 * the trigger is disabled.
 *
 * Spawn is fire-and-forget: this hook returns immediately so the Stop budget
 * isn't consumed by scanning.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { readStdin, parsePayload, emitEmpty } = require('./lib/hook-io.js');

const COOLDOWN_MS = 10 * 60 * 1000;

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env && !env.includes('${')) return env;
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

function loadCfg(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'config', 'brain-config.json'), 'utf-8');
    return JSON.parse(raw)?.kb?.skillPromotion || {};
  } catch { /* missing/invalid config: defaults */ return {}; }
}

function shouldRun(stampPath, cooldownMs) {
  try {
    if (!fs.existsSync(stampPath)) return true;
    const last = parseInt(fs.readFileSync(stampPath, 'utf-8'), 10);
    return !Number.isFinite(last) || (Date.now() - last) >= cooldownMs;
  } catch { /* unreadable stamp: allow run */ return true; }
}

function recordRun(stampPath) {
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, String(Date.now()));
  } catch { /* nothing actionable */ }
}

(async () => {
  try {
    const raw = await readStdin();
    const ev = parsePayload(raw) || {};
    const root = pluginRoot();
    const data = dataDir();

    const cfg = loadCfg(root);
    if (cfg.enabled === false) return emitEmpty();

    const stampPath = path.join(data, '.skill-scan-last');
    if (!shouldRun(stampPath, COOLDOWN_MS)) return emitEmpty();
    recordRun(stampPath);

    const project = ev.cwd ? path.basename(ev.cwd) : '';
    const args = [path.join(root, 'scripts', 'brain-promote.js'), 'scan'];
    if (project) { args.push('--project', project); }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data },
    });
    child.unref();

    emitEmpty();
  } catch (err) {
    console.error(`[skill-promote-trigger] crashed: ${err.message}`);
    emitEmpty();
  }
})();

module.exports = { shouldRun, loadCfg };
