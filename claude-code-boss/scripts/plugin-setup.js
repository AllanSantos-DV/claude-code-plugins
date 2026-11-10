#!/usr/bin/env node
/**
 * plugin-setup.js — runs after npm install (postinstall) and after plugin updates.
 *
 * Three jobs:
 *  1. Ensure root dependencies are present (installs them when they do not resolve,
 *     e.g. the plugin was copied into the Claude Code cache without them, or the
 *     last setup died mid-install).
 *  2. Ensure the brain-server (MCP) dependencies are present. It is a SEPARATE
 *     package (servers/brain-server/package.json) that the root install does NOT
 *     cover — without it the Brain MCP is DOWN on a fresh install.
 *  3. Warm the embedding model so the Brain learning loop works out of the box
 *     (semantic search + dedup → recurrence → skill promotion). See brain-warm.js.
 *
 * The plugin has NO required native module — it runs on any machine with a modern
 * Node, no C/C++ build toolchain: SQLite uses the built-in `node:sqlite`. The
 * embedder model (`@huggingface/transformers`, sucessor do @xenova; ONNX nativo) is REQUIRED for full value
 * and is downloaded here — internet is assumed, since the plugin was just fetched
 * online. The warm is skipped in CI and is non-fatal: the model is also fetched
 * lazily on first use, and keyword search keeps working meanwhile.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Resolve the package root this setup operates on. A postinstall ALWAYS runs
 * INSIDE the package being installed, so the install/verify target is derived
 * from THIS file's location (`__dirname/..`) — NOT process.env.CLAUDE_PLUGIN_ROOT,
 * which is a RUNTIME pointer that can aim at a DIFFERENT checkout (dev machines
 * set it per the README). Trusting the env here made the postinstall check/install
 * the brain-server deps in the WRONG tree and report a false "deps present",
 * leaving the Brain MCP DOWN in the freshly-installed copy.
 * @returns {string} absolute path to the package root being set up
 */
function setupRoot() {
  return path.resolve(__dirname, '..');
}
const PLUGIN_ROOT = setupRoot();
const { nodeSupport, supportAdvice } = require('./lib/node-support.js');

/**
 * Runs one setup command.
 * @returns {{ok: boolean, interrupted: boolean}} interrupted when it was killed (timeout or
 *   signal): what it was writing may be half done, unlike an npm that exits with errors.
 */
function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: PLUGIN_ROOT, timeout: 120000, ...opts, windowsHide: true });
    return { ok: true, interrupted: false };
  } catch (err) {
    console.error(`[PLUGIN-SETUP] command failed: ${cmd} → ${err.message}`);
    return { ok: false, interrupted: err.code === 'ETIMEDOUT' || Boolean(err.signal) };
  }
}

// Warn, never fail: the install itself still works, and the doctor + SessionStart advisory
// keep repeating the same advice until the Node is replaced.
function warnNodeVersion(version = process.version, write = (s) => process.stderr.write(s)) {
  const s = nodeSupport(version);
  if (s.ok) return false;
  write(`[plugin-setup] WARNING: ${supportAdvice(s)}\n`);
  return true;
}

/**
 * Download + verify the embedding model so the Brain learning loop is ready out
 * of the box. Internet is assumed (the plugin was just fetched over the network).
 * Skipped in CI (tests don't need the model) and when CLAUDE_SKIP_EMBED_WARM=1.
 * Non-fatal but LOUD on failure — the model is also fetched lazily on first use.
 */
function warmEmbedder() {
  if (process.env.CI || process.env.CLAUDE_SKIP_EMBED_WARM === '1') {
    process.stdout.write('[plugin-setup] Skipping embedder warm (CI or CLAUDE_SKIP_EMBED_WARM=1).\n');
    return;
  }
  process.stdout.write(
    '[plugin-setup] Warming embedding model (one-time download; required for ' +
    'semantic search + the learning loop)…\n'
  );
  const warmed = run(
    `"${process.execPath}" "${path.join(PLUGIN_ROOT, 'scripts', 'brain-warm.js')}"`,
    { timeout: 600000 }
  );
  if (!warmed.ok) {
    process.stderr.write(
      '[plugin-setup] Embedding model warm FAILED. The Brain runs in keyword mode ' +
      'for now; the model is fetched on first capture. To retry: npm run setup:brain\n'
    );
  }
}

async function main() {
  warnNodeVersion();

  // Every session's first prompt may spawn this in the background: one npm at a time.
  const { acquireFileLock, releaseFileLock } = require('../engine/lib/process-lock.js');
  const lockFile = path.join(process.env.CLAUDE_PLUGIN_DATA || PLUGIN_ROOT, 'plugin-setup.lock');
  const lock = acquireFileLock(lockFile);
  if (!lock.acquired) {
    process.stdout.write(`[plugin-setup] another setup is running (${lock.reason || 'lock held'}) — skipping\n`);
    return;
  }
  const ready = require('./lib/install-ready.js');
  // Read before this run overwrites the mark: a mark already there means the last setup died mid-install.
  const repair = Boolean(ready.setupInterrupted(PLUGIN_ROOT));
  let finished = false;
  try {
    ready.markSetup(PLUGIN_ROOT);
    finished = await setupSteps({ repair });
  } finally {
    if (finished) ready.clearSetup(PLUGIN_ROOT);
    releaseFileLock(lockFile, lock.owner);
  }
}

/**
 * Installs what is missing. A folder that exists is not enough: the deps must resolve,
 * and after an interrupted setup (`repair`) both installs run again over the half-written tree.
 * @param {object} [o]
 * @param {string} [o.root] plugin root
 * @param {boolean} [o.repair] the previous setup did not finish
 * @param {boolean} [o.inRootInstall] running as the root package's own postinstall (its install just finished)
 * @param {Function} [o.exec] runs a command, returns {ok, interrupted}
 * @param {Function} [o.warm] warms the embedder
 * @param {Function} [o.out] progress writer
 * @returns {Promise<boolean>} false when an install was killed midway (the mark stays, so the next setup repairs)
 */
async function setupSteps({
  root = PLUGIN_ROOT,
  repair = false,
  inRootInstall = process.env.npm_lifecycle_event === 'postinstall',
  exec = run,
  warm = warmEmbedder,
  out = (s) => process.stdout.write(s),
} = {}) {
  const ready = require('./lib/install-ready.js');
  let finished = true;
  const rootDeps = ready.packageDepsOk(root, 'plugin');
  if (inRootInstall || (!repair && fs.existsSync(path.join(root, 'node_modules')) && rootDeps.ok)) {
    out('[plugin-setup] Dependencies present\n');
  } else {
    out(`[plugin-setup] Installing dependencies (${repair ? 'previous setup did not finish' : rootDeps.detail})...\n`);
    // An optional prebuilt binary (e.g. onnxruntime for the embedder) may fail to
    // fetch on some platforms — that is expected and non-fatal. The plugin still
    // runs on node:sqlite + JSON fallback, so we never fail the whole setup on it.
    const r = exec('npm install --prefer-offline --no-audit --no-fund', { cwd: root });
    if (r.interrupted) finished = false;
    else if (!r.ok) {
      process.stderr.write(
        '[plugin-setup] npm install reported errors (likely an optional prebuilt ' +
        'dependency). The plugin still works via node:sqlite + JSON fallback.\n'
      );
    }
  }

  // The brain-server (MCP) is a separate ESM package the root install does not cover;
  // without its deps brain_search / brain_store / capture_lesson are down.
  const bsDir = path.join(root, 'servers', 'brain-server');
  if (fs.existsSync(path.join(bsDir, 'package.json'))) {
    if (!repair && ready.brainServerDepsOk(root).ok) {
      out('[plugin-setup] brain-server (MCP) deps present\n');
    } else {
      out('[plugin-setup] Installing brain-server (MCP) deps...\n');
      const r = exec('npm install --omit=dev --no-audit --no-fund', { cwd: bsDir });
      if (r.interrupted) finished = false;
      if (!r.ok) {
        process.stderr.write(
          '[plugin-setup] brain-server install FAILED — the Brain MCP (brain_search/' +
          'brain_store/capture_lesson) will be DOWN. Retry: cd servers/brain-server && npm install\n'
        );
      }
    }
  }

  warm();
  out(finished ? '[plugin-setup] Done\n' : '[plugin-setup] Interrupted: the next setup reinstalls\n');
  return finished;
}

if (require.main === module) {
  main();
}

module.exports = { setupRoot, warnNodeVersion, setupSteps };
