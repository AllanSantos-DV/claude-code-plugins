'use strict';

// A suite owns one private TMP tree: a numbered slot inside ONE stable per-version folder under the
// user's local cache, claimed by a pid lock and emptied when the run ends. A second run takes the same
// slot again, so repeated runs add no new files. Children inherit the slot as TMP.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const owners = new Set();
const realSpawn = cp.spawn;
let tracking = false;

const VERSION_DIR = /^\d+\.\d+\.\d+/;

/**
 * The stable folder every test slot lives in: `<local cache>/claude-code-boss/test-cache/<version>/test-run`.
 * The segment is not `cache`: the plugin reads `<plugins>/cache/<marketplace>/<plugin>/<version>` out of
 * the paths it runs from, and every test path under a folder of that name would parse as a marketplace.
 * @returns {string}
 */
function cacheDir() {
  const local = process.env.LOCALAPPDATA ||
    (process.platform === 'win32' ? null : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')));
  if (!local) throw new Error('[test-temp] LOCALAPPDATA is not set: no stable folder for the test run');
  return path.join(local, 'claude-code-boss', 'test-cache', require('../package.json').version, 'test-run');
}

/**
 * Remove a path, waiting out the few hundred ms a Windows handle (an exiting process's cwd, the AV)
 * can keep it busy; fails loud after 5 s.
 * @param {string} target
 */
function removeRetry(target) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }); return; } catch (err) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code) || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Take the lowest slot whose pid lock is free (or left by a dead process), emptied.
 * @param {string} base  the stable folder from `cacheDir()`
 * @returns {string} the slot path
 */
function claimSlot(base) {
  fs.mkdirSync(base, { recursive: true });
  const versionsDir = path.dirname(path.dirname(base));
  for (const name of fs.readdirSync(versionsDir)) {
    if (!VERSION_DIR.test(name) || path.join(versionsDir, name, 'test-run') === base) continue;
    removeRetry(path.join(versionsDir, name, 'test-run'));
    const old = path.join(versionsDir, name);
    if (fs.readdirSync(old).length === 0) fs.rmdirSync(old);
  }
  for (let n = 1; ; n++) {
    const slot = path.join(base, 'slot-' + n);
    const lock = slot + '.lock';
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(fs.readFileSync(lock, 'utf8')) || 0;
      if (owner && !processGone(owner)) continue;
      fs.rmSync(lock, { force: true });
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (again) {
        if (again.code === 'EEXIST') continue;
        throw again;
      }
    }
    fs.mkdirSync(slot, { recursive: true });
    for (const name of fs.readdirSync(slot)) removeRetry(path.join(slot, name));
    return slot;
  }
}

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

/**
 * Has `pid` exited? On POSIX a killed child stays a ZOMBIE until Node's event loop reaps it, and
 * the synchronous wait below never yields to it — `kill(pid, 0)` keeps succeeding, so its state
 * is read instead (`ps -o stat=`: gone or `Z` = exited). Windows reports ESRCH once it exits.
 * Seen in the Linux CI container: every owned daemon was "not stopped" and its fixture deferred.
 */
function processGone(pid) {
  try { process.kill(pid, 0); } catch (err) {
    if (err.code === 'ESRCH') return true;
    throw err;
  }
  if (process.platform === 'win32') return false;
  const r = cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
  const state = String(r.stdout || '').trim();
  return !state || state.startsWith('Z');
}

function createTestTemp({ borrowedRoot } = {}) {
  const initialCwd = process.cwd();
  const base = cacheDir();
  const root = borrowedRoot ? path.resolve(borrowedRoot) : claimSlot(base);
  if (borrowedRoot && (path.dirname(root) !== base || !/^slot-\d+$/.test(path.basename(root)) || fs.lstatSync(root).isSymbolicLink())) {
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
    removeRetry(target);
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
        if (processGone(child.pid)) { exited = true; break; }
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
    if (path.dirname(root) !== base) throw new Error('test cleanup root no longer belongs to this process');
    try {
      stopOwnedDaemons(root);
      // The parent removes a borrowed tree only AFTER the child exits; Windows
      // then releases even a deliberately reloaded SQLite module's handles.
      if (!borrowedRoot) {
        if (inside(process.cwd())) process.chdir(initialCwd);
        for (const name of fs.readdirSync(root)) remove(path.join(root, name));
        fs.rmSync(root + '.lock', { force: true });
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
  const labelCount = new Map();
  /**
   * A fixture folder named by label and its order in the run, so the same run asks for the same names.
   * @param {string} label
   * @returns {string}
   */
  function dir(label) {
    const n = (labelCount.get(label) || 0) + 1;
    labelCount.set(label, n);
    const target = path.join(root, label + n);
    fs.mkdirSync(target);
    return target;
  }
  return { root, checkpoint, cleanupSince, cleanup, dir };
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
