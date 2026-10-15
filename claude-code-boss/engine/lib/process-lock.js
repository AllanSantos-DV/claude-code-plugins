'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CORRUPT_GRACE_MS = 30000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function parseOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && typeof parsed.token === 'string' && parsed.token) {
      return parsed;
    }
  } catch (err) { void err; }
  const legacyPid = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(legacyPid) && legacyPid > 0
    ? { pid: legacyPid, token: '', createdAt: 0, legacy: true }
    : null;
}

function reclaimFileFor(file) {
  return `${file}.reclaim`;
}

function clearStaleReclaim(file, opts = {}) {
  const io = opts.fs || fs;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const alive = typeof opts.pidAlive === 'function' ? opts.pidAlive : pidAlive;
  const reclaimFile = reclaimFileFor(file);
  if (!io.existsSync(reclaimFile)) return true;
  let raw;
  try { raw = io.readFileSync(reclaimFile, 'utf8'); }
  catch (err) { console.error(`[process-lock] reclaim read ${reclaimFile}: ${err.message}`); return false; }
  const owner = parseOwner(raw);
  if (owner && alive(owner.pid)) return false;
  if (!owner) {
    try {
      if ((now() - io.statSync(reclaimFile).mtimeMs) < CORRUPT_GRACE_MS) return false;
    } catch (err) { console.error(`[process-lock] reclaim stat ${reclaimFile}: ${err.message}`); return false; }
  }
  const quarantine = `${reclaimFile}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    io.renameSync(reclaimFile, quarantine);
  } catch (err) {
    console.error(`[process-lock] reclaim claim ${reclaimFile}: ${err.message}`);
    return false;
  }
  try {
    if (io.readFileSync(quarantine, 'utf8') !== raw) {
      if (!io.existsSync(reclaimFile)) io.renameSync(quarantine, reclaimFile);
      return false;
    }
    io.unlinkSync(quarantine);
    return true;
  } catch (err) {
    console.error(`[process-lock] stale reclaim cleanup ${quarantine}: ${err.message}`);
    return false;
  }
}

function acquireFileLock(file, opts = {}) {
  const io = opts.fs || fs;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const alive = typeof opts.pidAlive === 'function' ? opts.pidAlive : pidAlive;
  const owner = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: now(),
  };
  const rawOwner = JSON.stringify(owner);
  const reclaimFile = reclaimFileFor(file);
  const tryCreate = () => {
    if (io.existsSync(reclaimFile) && !clearStaleReclaim(file, opts)) {
      const err = new Error('lock reclaim in progress');
      err.code = 'ELOCKRECLAIM';
      throw err;
    }
    io.mkdirSync(path.dirname(file), { recursive: true });
    const fd = io.openSync(file, 'wx');
    try { io.writeSync(fd, rawOwner); } finally { io.closeSync(fd); }
  };

  try {
    tryCreate();
    return { acquired: true, owner };
  } catch (err) {
    if (err && err.code === 'ELOCKRECLAIM') {
      return { acquired: false, reason: 'reclaiming' };
    }
    if (!err || err.code !== 'EEXIST') {
      return { acquired: false, reason: `lock create failed: ${err && err.message || err}` };
    }
  }

  let raw;
  try { raw = io.readFileSync(file, 'utf8'); }
  catch (err) { return { acquired: false, reason: `lock read failed: ${err.message}` }; }
  const existing = parseOwner(raw);
  if (existing && alive(existing.pid)) return { acquired: false, reason: 'locked' };
  if (!existing) {
    try {
      const age = now() - io.statSync(file).mtimeMs;
      if (age < CORRUPT_GRACE_MS) return { acquired: false, reason: 'locked-corrupt-grace' };
    } catch (err) {
      return { acquired: false, reason: `lock stat failed: ${err.message}` };
    }
  }

  let reclaimFd;
  try {
    reclaimFd = io.openSync(reclaimFile, 'wx');
    io.writeSync(reclaimFd, rawOwner);
    io.closeSync(reclaimFd);
    reclaimFd = null;
  } catch (err) {
    if (reclaimFd !== undefined) {
      try { io.closeSync(reclaimFd); } catch (closeErr) { void closeErr; }
    }
    return {
      acquired: false,
      reason: err && err.code === 'EEXIST' ? 'reclaiming' : `reclaim lock failed: ${err.message}`,
    };
  }

  try {
    if (io.readFileSync(file, 'utf8') !== raw) return { acquired: false, reason: 'lock-changed' };
    io.unlinkSync(file);
    const fd = io.openSync(file, 'wx');
    try { io.writeSync(fd, rawOwner); } finally { io.closeSync(fd); }
    return { acquired: true, owner, reclaimed: true };
  } catch (err) {
    return { acquired: false, reason: `lock reclaim failed: ${err.message}` };
  } finally {
    try {
      if (io.readFileSync(reclaimFile, 'utf8') === rawOwner) io.unlinkSync(reclaimFile);
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.error(`[process-lock] reclaim release ${reclaimFile}: ${err.message}`);
    }
  }
}

function releaseFileLock(file, owner, opts = {}) {
  if (!owner || !owner.token) return false;
  const io = opts.fs || fs;
  try {
    const current = parseOwner(io.readFileSync(file, 'utf8'));
    if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
    io.unlinkSync(file);
    return true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error(`[process-lock] release ${file}: ${err.message}`);
    return false;
  }
}

module.exports = {
  CORRUPT_GRACE_MS,
  pidAlive,
  parseOwner,
  reclaimFileFor,
  clearStaleReclaim,
  acquireFileLock,
  releaseFileLock,
};
