#!/usr/bin/env node
/**
 * Brain Research MCP Server v2 — HTTP daemon entrypoint.
 *
 * ONE mode: the long-lived HTTP daemon (StreamableHTTP, stateful — see
 * lib/http-daemon.js). .mcp.json points straight at it ("type":"http",
 * "url":"http://127.0.0.1:<FIXED_PORT>/mcp") — NO "command", so Claude Code
 * spawns nothing per session; every session is a thin HTTP client of the ONE
 * daemon (ADR-001 "daemon único"). The daemon itself is ensured/kept current
 * by the SessionStart hook (scripts/brain-daemon-ensure.js), which calls the
 * same ensureDaemon() this file used to call fire-and-forget from a stdio
 * branch that no longer exists here.
 *
 * Port: FIXED (see lib/daemon-common.js resolvePort — override BRAIN_HTTP_PORT
 * / --port). EADDRINUSE = a daemon already owns it (port IS the lock).
 *
 * The MCP assembly (tools + handlers) lives in lib/mcp-server.js
 * (createBrainServer) — shared code, not duplicated per transport.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { resolvePort } from './lib/daemon-common.js';
import { startHttpDaemon } from './lib/http-daemon.js';

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
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? valid(process.argv[i + 1]) : null;
}

const PLUGIN_ROOT = resolveEnv('CLAUDE_PLUGIN_ROOT', path.resolve(__dirname, '..', '..'));
let DATA_DIR = argValue('--plugin-data')
  || resolveEnv('CLAUDE_PLUGIN_DATA',
       path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'plugins', 'data', 'claude-code-boss'));

// Publish the REAL active folder to the stable global pointer. The daemon is the
// ONE process that reliably receives it (via --plugin-data, from the ensure hook),
// so it is the authoritative publisher; env-less callers then FOLLOW this pointer
// and resolve the SAME data dir (no split-brain KB). Best-effort — a failure here
// must never abort daemon startup.
//
// The publish can be REFUSED: writeActivePointer's anti-regression guard won't
// move the pointer from a heavier (data-bearing) folder onto this lighter one. If
// we ignored that and kept using DATA_DIR anyway, this process (the port-deriver /
// daemon itself) would operate on the near-empty sibling — no brain-http.token
// there, no data there — while every env-less caller follows the pointer to the
// OTHER, real folder. So this file must not just publish the pointer, it must also
// FOLLOW the verdict its own publish reached (publishAndFollow — the same helper
// dataDir() itself uses on its env branch — one rule, one place).
try {
  const require = createRequire(import.meta.url);
  const { publishAndFollow } = require('../../scripts/lib/data-dir.js');
  DATA_DIR = publishAndFollow(DATA_DIR);
} catch (err) {
  console.error(`[brain-server] could not publish active-data-dir pointer: ${err.message}`);
}
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR; // normalize so brain-store inherits the resolved (possibly followed) dir

// One-time (per daemon boot, not per session): fold stray sibling data dirs INTO
// this one. Fail-open — never blocks or breaks daemon startup.
try {
  createRequire(import.meta.url)('../../scripts/consolidate-datadirs-hook.js')
    .run({ activeDir: DATA_DIR });
} catch (err) {
  console.error(`[brain] data-dir consolidation skipped: ${err.message}`);
}

const port = Number(argValue('--port')) || resolvePort(DATA_DIR);
// Real plugin version for /health + lockfile (a hardcoded default was a false
// staleness signal for any version-aware consumer).
let version = '0.0.0-dev';
try {
  const pkg = createRequire(import.meta.url)('../../package.json');
  version = (pkg && pkg.version) || version;
} catch (err) {
  console.error(`[brain-server] could not read plugin version: ${err.message}`);
}
try {
  await startHttpDaemon({ pluginRoot: PLUGIN_ROOT, dataDir: DATA_DIR, port, version });
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[brain-http] port ${port} already in use — another daemon owns it; exiting 0.`);
    process.exit(0);
  }
  throw err;
}
