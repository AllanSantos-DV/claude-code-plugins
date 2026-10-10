'use strict';

// A suite owns one private TMP tree. Children inherit it, so all 366 existing
// mkdtemp call sites stay isolated without sharing fixture names.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const owners = new Set();
const realSpawn = cp.spawn;
let tracking = false;

function trackDaemonSpawns() {
  if (tracking) return;
  // Capture the REAL ChildProcess returned by this suite's daemon launch. A
  // test-written lock file (including a valid-looking stale PID) is NO authority.
  cp.spawn = function (...args) {
    const child = Reflect.apply(realSpawn, this, args);
    const argv = args[1];
    const opts = args[2] || {};
    const at = Array.isArray(argv) ? argv.indexOf('--plugin-data') : -1;
    const data = at >= 0 && argv[at + 1];
    if (child instanceof cp.ChildProcess && Number.isInteger(child.pid) && data &&
        opts.env && opts.env.CLAUDE_PLUGIN_DATA &&
        path.resolve(opts.env.CLAUDE_PLUGIN_DATA) === path.resolve(data)) {
      for (const owner of owners) owner.register(child, path.resolve(data));
    }
    return child;
  };
  tracking = true;
  syncBuiltinESMExports();
}

function createTestTemp({ borrowedRoot } = {}) {
  const initialCwd = process.cwd();
  const base = borrowedRoot ? path.dirname(path.resolve(borrowedRoot)) : path.resolve(os.tmpdir());
  const root = borrowedRoot ? path.resolve(borrowedRoot) : fs.mkdtempSync(path.join(base, 'ccb-test-run-' + process.pid + '-'));
  if (borrowedRoot && (!/^ccb-test-run-\d+-[a-zA-Z0-9]+$/.test(path.basename(root)) || fs.lstatSync(root).isSymbolicLink())) {
    throw new Error('invalid borrowed test temp root');
  }
  const saved = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(saved)) process.env[k] = root;
  let closed = false;
  const pending = new Set();
  const daemons = new Set();
  function inside(target) {
    const rel = path.relative(root, path.resolve(target));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }
  const owner = { register(child, dataDir) {
    if (inside(dataDir)) daemons.add({ child, dataDir });
  } };
  owners.add(owner);
  trackDaemonSpawns();
  function remove(target) {
    if (!inside(target)) throw new Error('test cleanup escaped its owned tree');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }
  function stopOwnedDaemons(target) {
    for (const entry of daemons) {
      const rel = path.relative(path.resolve(target), entry.dataDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const child = entry.child;
      if (child.exitCode !== null || child.signalCode !== null) { daemons.delete(entry); continue; }
      // This object came from an actual spawn with its own plugin-data path;
      // never look up a process from JSON, a guessed PID or another suite.
      child.kill();
      const deadline = Date.now() + 2000;
      let exited = false;
      while (Date.now() < deadline) {
        try { process.kill(child.pid, 0); } catch (err) {
          if (err.code !== 'ESRCH') throw err;
          exited = true; break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      if (!exited) throw new Error('owned test daemon has not stopped; preserving fixture');
      daemons.delete(entry);
    }
  }
  function checkpoint() { return new Set(fs.readdirSync(root)); }
  function cleanupSince(before) {
    for (const name of fs.readdirSync(root)) {
      if (before.has(name)) continue;
      const target = path.join(root, name);
      try { stopOwnedDaemons(target); remove(target); } catch (err) {
        pending.add(target);
        console.error('[test-temp] deferred cleanup (' + (err.code || err.message) + '): ' + path.basename(target));
      }
    }
  }
  function cleanup() {
    if (closed) return;
    if (path.dirname(root) !== base || (!borrowedRoot && !path.basename(root).startsWith('ccb-test-run-' + process.pid + '-'))) {
      throw new Error('test cleanup root no longer belongs to this process');
    }
    try {
      stopOwnedDaemons(root);
      // The parent removes a borrowed tree only AFTER the child exits; Windows
      // then releases even a deliberately reloaded SQLite module's handles.
      if (!borrowedRoot) {
        if (inside(process.cwd())) process.chdir(initialCwd);
        remove(root);
      }
    } catch (err) {
      console.error('[test-temp] cleanup failed (' + (err.code || err.message) + '): ' + root + '; ' + pending.size + ' deferred fixture(s); ' + (err.syscall || '') + ' ' + (err.path || ''));
      process.exitCode = 1;
      return false;
    }
    closed = true;
    owners.delete(owner);
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k]; else process.env[k] = value;
    }
    return true;
  }
  process.once('exit', cleanup);
  process.once('SIGINT', () => { if (!process.listenerCount('SIGINT')) process.exit(130); });
  process.once('SIGTERM', () => { if (!process.listenerCount('SIGTERM')) process.exit(143); });
  return { root, checkpoint, cleanupSince, cleanup };
}

function runTestProcess(file) {
  const temp = createTestTemp();
  const result = cp.spawnSync(process.execPath, [file, ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, CCB_TEST_TEMP_ENTRY: file, CCB_TEST_TEMP_ROOT: temp.root },
  });
  if (result.error) console.error('[test-temp] child failed: ' + result.error.message);
  const cleaned = temp.cleanup();
  process.exit(cleaned === false ? 1 : (result.status === null ? 1 : result.status));
}

module.exports = { createTestTemp, runTestProcess };
