#!/usr/bin/env node
/**
 * brain-health.js — SessionStart + UserPromptSubmit liveness probe.
 *
 * Validates the brain MCP path can serve calls. Runs in two phases:
 *   1. Static checks (fs lookups, ~1ms): entry, deps, scripts, data dir writable.
 *   2. Active probe (~30ms): backend.init + backend.count — exercises the SAME
 *      in-process modules the brain MCP server uses, so a failure here means
 *      the MCP server would also fail to serve (and conversely, success here
 *      is a strong signal the MCP is healthy too).
 *
 * Behavior:
 *   - Healthy → exit 0 silently (`{}`), no context noise.
 *   - Defect  → emits `additionalContext` advisory listing exact failures +
 *     remediation. The agent is instructed to fix or surface to the user.
 *
 * Throttling: on UserPromptSubmit we run at most once per `cooldownMs`
 * (default 60s) per data dir, since the same probe just ran on SessionStart
 * and most prompts won't change health state.
 *
 * Per user request: "o hook de start session e prompt user deveria ser assim,
 * o hook valida se esta on, se esta exit 0, se nao instruir a subir".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');

const COOLDOWN_MS = 60_000;

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env && !env.includes('${')) return env;
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

function checkExists(p, kind) {
  try {
    return fs.existsSync(p) ? null : `${kind} missing: ${p}`;
  } catch (err) {
    return `${kind} stat failed: ${err.message}`;
  }
}

function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.brain-health-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return null;
  } catch (err) {
    return `data dir not writable: ${dir} (${err.message})`;
  }
}

function staticChecks(root, data) {
  const defects = [];
  const checks = [
    [path.join(root, 'servers', 'brain-server', 'index.js'), 'brain-server entry'],
    [path.join(root, 'servers', 'brain-server', 'node_modules'), 'brain-server deps (run npm install in servers/brain-server)'],
    [path.join(root, 'node_modules'), 'plugin deps (run npm install in plugin root)'],
    [path.join(root, 'scripts', 'brain-store.js'), 'brain-store script'],
  ];
  for (const [p, kind] of checks) {
    const err = checkExists(p, kind);
    if (err) defects.push(err);
  }
  const writeErr = checkWritable(data);
  if (writeErr) defects.push(writeErr);
  return defects;
}

async function liveProbe(root, projectKey) {
  // Active probe: exercise the same module path the MCP server uses.
  // Skip if static checks already failed (would crash on require).
  try {
    const backend = require(path.join(root, 'scripts', 'brain-backend.js'));
    await backend.init({ project: projectKey, skipEmbedder: true });
    await backend.count();
    if (backend.close) await backend.close();
    return null;
  } catch (err) {
    return `live probe failed: ${err.message}`;
  }
}

function shouldRunOnPrompt(data) {
  // Throttle: only re-probe on UserPromptSubmit if last run is older than cooldown.
  // SessionStart always runs.
  const stamp = path.join(data, '.brain-health-last');
  try {
    if (fs.existsSync(stamp)) {
      const last = parseInt(fs.readFileSync(stamp, 'utf-8'), 10);
      if (Number.isFinite(last) && (Date.now() - last) < COOLDOWN_MS) return false;
    }
  } catch { /* fallthrough → run */ }
  return true;
}

function recordRun(data) {
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, '.brain-health-last'), String(Date.now()));
  } catch { /* nothing actionable */ }
}

function emitAdvisory(eventName, defects) {
  const lines = defects.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext:
        '[BRAIN-HEALTH] Brain MCP path is DOWN — defects detected:\n' +
        lines +
        '\n\nAction: re-run `.vscode/scripts/install-local.mjs` — the new build takes effect ' +
        'on the next turn (no Claude Code restart needed). If the live probe failed, the agent ' +
        'must fix the listed cause before relying on `brain_search` / `brain_store` / ' +
        '`capture_lesson` — those calls will fail until resolved.',
    },
  });
}

(async () => {
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    const eventName = event.hook_event_name || 'SessionStart';
    const project = event.cwd ? path.basename(event.cwd) : 'default';

    const root = pluginRoot();
    const data = dataDir();

    if (eventName === 'UserPromptSubmit' && !shouldRunOnPrompt(data)) {
      emitEmpty();
      return;
    }

    const defects = staticChecks(root, data);

    // Only attempt the live probe when static checks passed — otherwise the
    // require() inside liveProbe would itself throw with a confusing path error.
    if (defects.length === 0) {
      const liveErr = await liveProbe(root, project);
      if (liveErr) defects.push(liveErr);
    }

    recordRun(data);

    if (defects.length === 0) { emitEmpty(); return; }
    emitAdvisory(eventName, defects);
  } catch (err) {
    console.error(`[BRAIN-HEALTH] probe crashed: ${err.message}`);
    emitEmpty();
  }
})();
