#!/usr/bin/env node
/**
 * Brain Research MCP Server v2 — transport selector.
 *
 * Default (no args): StdioServerTransport — one server per host connection, the
 * historical behavior, used by .mcp.json (Claude Code). UNCHANGED.
 *
 * --http [--port N | env BRAIN_HTTP_PORT]: a single long-lived HTTP daemon
 * (StreamableHTTP, stateful) — opt-in, additive. See lib/http-daemon.js.
 *
 * The MCP assembly (tools + handlers) is shared by both transports via
 * lib/mcp-server.js (createBrainServer); the lib in scripts/ is reused, never
 * duplicated.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createBrainServer } from './lib/mcp-server.js';
import { resolvePort } from './lib/daemon-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve plugin env vars robustly: ignore unexpanded "${...}" literals (some
// install contexts don't expand .mcp.json env), derive sane defaults, and
// normalize process.env so downstream requires (brain-store etc.) inherit them.
function valid(v) { return v && !v.includes('${') ? v : null; }
function resolveEnv(name, fallback) {
  const resolved = valid(process.env[name]) || fallback;
  process.env[name] = resolved;
  return resolved;
}
// CLI arg fallback for the buggy .mcp.json env block (Claude Code issue #9427:
// ${...} does not expand in the MCP env block, but DOES expand in args). We pass
// --plugin-data ${CLAUDE_PLUGIN_DATA} so the server gets the SAME data dir the
// hooks use (avoids a split-brain KB).
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? valid(process.argv[i + 1]) : null;
}

const PLUGIN_ROOT = resolveEnv('CLAUDE_PLUGIN_ROOT', path.resolve(__dirname, '..', '..'));
const DATA_DIR = argValue('--plugin-data')
  || resolveEnv('CLAUDE_PLUGIN_DATA',
       path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'plugins', 'data', 'claude-code-boss'));
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR; // normalize so brain-store inherits the resolved dir

// Publish the REAL active folder to the stable global pointer. The brain-server
// is the ONE process that reliably receives it (via --plugin-data), so it is the
// authoritative publisher; env-less SessionStart hooks then FOLLOW this pointer
// and resolve the SAME data dir (no split-brain KB). Best-effort — a failure
// here must never abort server startup.
try {
  const require = createRequire(import.meta.url);
  const { writeActivePointer } = require('../../scripts/lib/data-dir.js');
  writeActivePointer(DATA_DIR);
} catch (err) {
  console.error(`[brain-server] could not publish active-data-dir pointer: ${err.message}`);
}

// ─── Transport selection ─────────────────────────────────────────────────────
if (process.argv.includes('--http')) {
  // Opt-in long-lived HTTP daemon (additive). Port is deterministic per data-dir
  // (override: --port / BRAIN_HTTP_PORT). EADDRINUSE = a daemon already owns it.
  const port = Number(argValue('--port')) || resolvePort(DATA_DIR);
  const { startHttpDaemon } = await import('./lib/http-daemon.js');
  try {
    await startHttpDaemon({ pluginRoot: PLUGIN_ROOT, dataDir: DATA_DIR, port });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[brain-http] port ${port} already in use — another daemon owns it; exiting 0.`);
      process.exit(0);
    }
    throw err;
  }
} else {
  // Default: stdio — one server per host connection, exactly as before.
  // Best-effort, fire-and-forget: ensure the shared HTTP daemon is up & current
  // (auto-start + version swap). Never blocks or breaks the stdio path.
  if (process.env.BRAIN_HTTP_AUTOSTART !== '0') {
    import('./lib/daemon-supervisor.js')
      .then(({ ensureDaemon }) => ensureDaemon({ pluginRoot: PLUGIN_ROOT, dataDir: DATA_DIR }))
      .catch((e) => console.error(`[brain] daemon autostart skipped: ${e.message}`));
  }
  const server = createBrainServer({ pluginRoot: PLUGIN_ROOT, mode: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
