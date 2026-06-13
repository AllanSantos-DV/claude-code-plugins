#!/usr/bin/env node
/**
 * plugin-setup.js — runs after npm install (postinstall) and after plugin updates.
 *
 * Three jobs:
 *  1. Ensure root dependencies are present (installs them when node_modules is
 *     missing, e.g. the plugin was copied into the Claude Code cache without them).
 *  2. Ensure the brain-server (MCP) dependencies are present. It is a SEPARATE
 *     package (servers/brain-server/package.json) that the root install does NOT
 *     cover — without it the Brain MCP is DOWN on a fresh install.
 *  3. Warm the embedding model so the Brain learning loop works out of the box
 *     (semantic search + dedup → recurrence → skill promotion). See brain-warm.js.
 *
 * The plugin has NO required native module — it runs on any machine with a modern
 * Node, no C/C++ build toolchain: SQLite uses the built-in `node:sqlite`. The
 * embedder model (`@xenova/transformers`, pure JS/WASM) is REQUIRED for full value
 * and is downloaded here — internet is assumed, since the plugin was just fetched
 * online. The warm is skipped in CI and is non-fatal: the model is also fetched
 * lazily on first use, and keyword search keeps working meanwhile.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const MIN_NODE = [22, 13, 0];

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: PLUGIN_ROOT, timeout: 120000, ...opts });
    return true;
  } catch (err) {
    console.error(`[PLUGIN-SETUP] command failed: ${cmd} → ${err.message}`);
    return false;
  }
}

function meetsMinNode() {
  const [maj, min] = process.versions.node.split('.').map((n) => parseInt(n, 10));
  if (maj !== MIN_NODE[0]) return maj > MIN_NODE[0];
  return min >= MIN_NODE[1];
}

function warnNodeVersion() {
  if (meetsMinNode()) return;
  process.stderr.write(
    `[plugin-setup] WARNING: Node ${process.versions.node} detected. This plugin ` +
    `recommends Node >= ${MIN_NODE.join('.')} for the built-in node:sqlite backend. ` +
    `On older Node the Brain KB falls back to JSON (slower, no metrics). ` +
    `Upgrade Node to enable SQLite.\n`
  );
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
  if (!warmed) {
    process.stderr.write(
      '[plugin-setup] Embedding model warm FAILED. The Brain runs in keyword mode ' +
      'for now; the model is fetched on first capture. To retry: npm run setup:brain\n'
    );
  }
}

/**
 * Install the brain-server (MCP) dependencies. It is a separate package
 * (servers/brain-server/package.json, ESM) that the root `npm install` does NOT
 * cover. Without it the Brain MCP (brain_search / brain_store / capture_lesson)
 * fails to start — `@modelcontextprotocol/sdk` is unresolved.
 */
function installBrainServer() {
  const bsDir = path.join(PLUGIN_ROOT, 'servers', 'brain-server');
  if (!fs.existsSync(path.join(bsDir, 'package.json'))) return;
  if (fs.existsSync(path.join(bsDir, 'node_modules'))) {
    process.stdout.write('[plugin-setup] brain-server (MCP) deps present\n');
    return;
  }
  process.stdout.write('[plugin-setup] Installing brain-server (MCP) deps...\n');
  const ok = run('npm install --omit=dev --no-audit --no-fund', { cwd: bsDir });
  if (!ok) {
    process.stderr.write(
      '[plugin-setup] brain-server install FAILED — the Brain MCP (brain_search/' +
      'brain_store/capture_lesson) will be DOWN. Retry: cd servers/brain-server && npm install\n'
    );
  }
}

(async () => {
  warnNodeVersion();

  const nodeModules = path.join(PLUGIN_ROOT, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    process.stdout.write('[plugin-setup] Dependencies present\n');
  } else {
    process.stdout.write('[plugin-setup] Installing dependencies...\n');
    // An optional prebuilt binary (e.g. onnxruntime for the embedder) may fail to
    // fetch on some platforms — that is expected and non-fatal. The plugin still
    // runs on node:sqlite + JSON fallback, so we never fail the whole setup on it.
    const ok = run('npm install --prefer-offline --no-audit --no-fund');
    if (!ok) {
      process.stderr.write(
        '[plugin-setup] npm install reported errors (likely an optional prebuilt ' +
        'dependency). The plugin still works via node:sqlite + JSON fallback.\n'
      );
    }
  }

  installBrainServer();
  warmEmbedder();

  process.stdout.write('[plugin-setup] Done\n');
})();
