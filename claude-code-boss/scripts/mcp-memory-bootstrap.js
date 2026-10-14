#!/usr/bin/env node
'use strict';
/**
 * mcp-memory-bootstrap.js — install / start / update the local mcp-memory-server from OUTSIDE
 * Claude Code (a silent CLI for other programs, e.g. the whatsapp-bridge). It is the same
 * bring-up the `backend_setup` / `backend_update` MCP tools do (lib/mcp-bootstrap/ + the
 * daemon restart used by the auto-update), minus any claude-code-boss config or state.
 *
 *   node mcp-memory-bootstrap.js status [--min X.Y.Z]
 *   node mcp-memory-bootstrap.js ensure [--min X.Y.Z]   install if missing, start if down,
 *                                                        update when older than the minimum
 *   node mcp-memory-bootstrap.js update                  bring it to the latest published release
 *
 * Contract: stdout is exactly ONE JSON line; progress goes to stderr (one line per step);
 * every child process is spawned hidden (no window). Exit code: 0 ok, 1 failed, 2 usage,
 * 3 Java 21+ missing (JSON carries `javaInstallCommand` — installing system software is the
 * caller's decision). The minimum defaults to MIN_SERVER_VERSION (lib/mcp-min-version.js).
 */
const path = require('path');
const os = require('os');

const { MIN_SERVER_VERSION } = require('./lib/mcp-min-version.js');
const launcher = require('./lib/mcp-bootstrap/launcher.js');

const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NEEDS_JAVA: 3 };
const COMMANDS = new Set(['status', 'ensure', 'update']);

/** argv (after the script name) → { cmd, min }; throws a usage message on anything unknown. */
function parseArgs(argv) {
  const out = { cmd: argv[0], min: MIN_SERVER_VERSION };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--min') {
      out.min = argv[++i];
      if (!/^v?\d+\.\d+\.\d+$/.test(String(out.min || ''))) throw new Error(`--min needs X.Y.Z (got ${JSON.stringify(out.min)})`);
    } else if (argv[i] === '--json') {
      // accepted for readability: output is always JSON
    } else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  if (!COMMANDS.has(out.cmd)) throw new Error(`command must be one of ${[...COMMANDS].join(', ')} (got ${JSON.stringify(out.cmd)})`);
  return out;
}

const atLeast = (version, min) => launcher.compareVersions(version, min) >= 0;

/** The real seams (daemon probe, Java, release lookup, download, bring-up, restart); tests inject fakes. */
function defaultDeps() {
  const install = require('./lib/mcp-bootstrap/install.js');
  return {
    launcher,
    probeDaemon: async () => {
      const url = require('./lib/mcp-bootstrap/registry.js').readDaemonUrl(path.join(os.homedir(), '.mcp-memory', 'run'), { label: 'mcp-memory-bootstrap' });
      if (!url) return { running: false };
      const r = await require('./lib/http-health.js').probeHealth(url, { timeoutMs: 3000 });
      if (r.status !== 200) return { running: false, url };
      let h = {};
      try { h = JSON.parse(r.body); } catch (err) { console.error(`[mcp-memory-bootstrap] /health is not JSON: ${err.message}`); }
      return { running: true, url, version: String(h.version || '') };
    },
    checkJava: install.checkJava,
    resolveLatest: () => require('./lib/mcp-bootstrap/release-resolver.js').resolveLatestAsset(),
    downloadServerJar: (emit) => install.downloadServerJar({}, (status, detail) => emit(`download ${status}: ${detail}`)),
    ensureLocalDaemon: (emit) => install.ensureLocalDaemon({}, (step, status, detail) => emit(`${step}/3 ${status}: ${detail}`)),
    restartOnJar: (jarPath, version) => require('./lib/mcp-daemon-restart.js').restartForBootUpdate({}, { latestVersion: version, prepareUpdate: async () => jarPath }),
    javaInstallCommand: () => require('./lib/setup-tools.js').javaInstallCommand(),
  };
}

/** Read-only picture of the machine: launcher, newest installed jar, daemon /health, Java. */
async function snapshot(deps) {
  const jar = deps.launcher.newestInstalledJar();
  const daemon = await deps.probeDaemon();
  const java = deps.launcher.bundledJava() ? { ok: true, version: 'bundled runtime' } : await deps.checkJava();
  return {
    launcherInstalled: require('fs').existsSync(deps.launcher.launcherPath()),
    installedJar: jar ? { version: jar.version, path: jar.path } : null,
    daemon,
    java: java.ok ? { ok: true, version: java.version } : { ok: false, error: java.error },
  };
}

/** Bring the machine to `min`. Returns the JSON result (never throws for an expected failure). */
async function ensure({ min, deps, emit = () => {} }) {
  const before = await snapshot(deps);
  const base = { minServerVersion: min, before };
  if (before.daemon.running && atLeast(before.daemon.version, min)) {
    return { ok: true, action: 'none', url: before.daemon.url, version: before.daemon.version, ...base };
  }
  const actions = [];
  try {
    // The newest jar on disk must reach the minimum: otherwise download the latest published one.
    if (!before.installedJar || !atLeast(before.installedJar.version, min)) {
      emit('looking up the latest published server release');
      const latest = await deps.resolveLatest();
      if (!atLeast(latest.version, min)) {
        return { ok: false, error: `the latest published mcp-memory-server is ${latest.version}, below the required minimum ${min}`, ...base };
      }
      await deps.downloadServerJar(emit);
      actions.push(`downloaded ${latest.version}`);
    }
    const jar = deps.launcher.newestInstalledJar();
    if (before.daemon.running) {
      // A live OLDER daemon: the launcher would reuse it, so restart it onto the newer jar.
      emit(`restarting the running server ${before.daemon.version} onto ${jar.version}`);
      await deps.restartOnJar(jar.path, jar.version);
      actions.push(`restarted onto ${jar.version}`);
    } else {
      const r = await deps.ensureLocalDaemon(emit);
      actions.push(r.spawned ? 'started' : 'reused');
    }
  } catch (err) {
    const needsJava = /^Java check failed/.test(err.message);
    return { ok: false, error: err.message, ...(needsJava ? { needsJava: true, javaInstallCommand: deps.javaInstallCommand() } : {}), actions, ...base };
  }
  const after = await deps.probeDaemon();
  if (!after.running || !atLeast(after.version, min)) {
    return { ok: false, error: after.running ? `the server runs ${after.version}, below the required minimum ${min}` : 'the server did not answer /health after the bring-up', actions, ...base };
  }
  return { ok: true, action: actions.join(' + '), url: after.url, version: after.version, ...base };
}

/** CLI entry as data: argv → { code, result } (the caller prints result as one JSON line and exits with code). */
async function run(argv, deps = defaultDeps(), emit = (m) => console.error(`[mcp-memory-bootstrap] ${m}`)) {
  let args;
  try { args = parseArgs(argv); } catch (err) { return { code: EXIT.USAGE, result: { ok: false, error: err.message, usage: 'status|ensure|update [--min X.Y.Z]' } }; }
  if (args.cmd === 'status') {
    const s = await snapshot(deps);
    return { code: EXIT.OK, result: { ok: true, minServerVersion: args.min, meetsMinimum: !!(s.daemon.running && atLeast(s.daemon.version, args.min)), ...s } };
  }
  let min = args.min;
  if (args.cmd === 'update') {
    try { min = (await deps.resolveLatest()).version; }
    catch (err) { return { code: EXIT.FAILED, result: { ok: false, error: `could not resolve the latest release: ${err.message}` } }; }
  }
  const result = await ensure({ min, deps, emit });
  return { code: result.ok ? EXIT.OK : (result.needsJava ? EXIT.NEEDS_JAVA : EXIT.FAILED), result };
}

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, result }) => {
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(code));
  }, (err) => {
    process.stdout.write(JSON.stringify({ ok: false, error: `fatal: ${err && err.message ? err.message : err}` }) + '\n', () => process.exit(EXIT.FAILED));
  });
}

module.exports = { run, ensure, parseArgs, snapshot, EXIT, MIN_SERVER_VERSION };
