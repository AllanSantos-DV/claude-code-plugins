'use strict';
/**
 * dashboard-backup.js — the dashboard's Backup card: create / list / download / restore the
 * plugin's data (lib/backup.js), plus the mcp-memory server part when the server supports it
 * (lib/backup-remote.js, docs/BACKUP-CONTRACT.md). Archives live in
 * globalDir()/backups (outside the data dir, so a backup never contains older backups).
 *
 * Create and restore run as a background JOB (one at a time) polled by GET /api/backup/status:
 * with the server's data an archive is GBs and takes minutes. Uploads are streamed to disk.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const KEEP = 5;
const NAME_RE = /^ccb-backup-[0-9TZ-]+(-pre-restore)?\.tar\.gz$/;

function createBackupRoutes({ pluginRoot, dataDir, globalDir, json, fail, deps = {} }) {
  const lib = (m) => require(path.join(pluginRoot, 'scripts', 'lib', m));
  const backup = deps.backup || lib('backup.js');
  const remote = deps.remote || lib('backup-remote.js');
  const backupsDir = () => path.join(globalDir(), 'backups');
  const pluginVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version; } catch (err) { void err; return ''; } };
  const remoteOpts = (onProgress) => ({
    pluginRoot, tmpDir: os.tmpdir(), onProgress,
    loadConfig: deps.loadConfig || (() => lib('brain-config.js').load()),
    discoverUrl: deps.discoverUrl || (() => lib('mcp-wizard.js').discoverDaemonUrl()),
  });

  let job = { status: 'idle' };
  const progress = (msg) => { job.step = msg; };

  function startJob(kind, work) {
    if (job.status === 'running') return { ok: false, error: `a backup ${job.kind} is already running` };
    job = { kind, status: 'running', step: 'starting', startedAt: new Date().toISOString() };
    const mine = job;
    Promise.resolve().then(work).then(
      (result) => { mine.status = 'completed'; mine.result = result; mine.finishedAt = new Date().toISOString(); },
      (err) => { mine.status = 'failed'; mine.error = err.message; mine.finishedAt = new Date().toISOString(); console.error(`[dashboard-backup] ${kind}: ${err.message}`); },
    );
    return { ok: true, job: mine };
  }

  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  function prune() {
    const dir = backupsDir();
    const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(KEEP)) fs.rmSync(path.join(dir, f), { force: true });
  }

  async function make({ suffix = '', withRemote = true } = {}) {
    const rem = withRemote ? await remote.exportRemote(remoteOpts(progress)) : { kind: 'skipped', included: false, reason: 'pre-restore copy: local data only (the server keeps its own pre-import copy)' };
    const outFile = path.join(backupsDir(), `ccb-backup-${stamp()}${suffix}.tar.gz`);
    try {
      const { manifest } = await backup.createBackup({ dataDir: dataDir(), globalDir: globalDir(), outFile, pluginVersion: pluginVersion(), remote: rem, onProgress: progress });
      prune();
      return { name: path.basename(outFile), size: fs.statSync(outFile).size, items: manifest.items.length, remote: manifest.remote };
    } finally {
      if (rem.file) fs.rmSync(rem.file, { force: true });
    }
  }

  /** Stop the brain daemon (it holds the stores open); clients respawn it on reconnect. */
  async function stopBrainDaemon() {
    if (deps.stopBrainDaemon) return deps.stopBrainDaemon();
    const port = Number(process.env.BRAIN_HTTP_PORT) || 38217;
    const health = async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch (err) { void err; return false; } };
    if (!(await health())) return false;
    let token = '';
    try { token = fs.readFileSync(path.join(dataDir(), 'brain-http.token'), 'utf8').trim(); } catch (err) { console.error(`[dashboard-backup] brain token: ${err.message}`); }
    try {
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
    } catch (err) { if (err.name !== 'AbortError') console.error(`[dashboard-backup] shutdown: ${err.message}`); }
    for (let i = 0; i < 50; i++) { if (!(await health())) return true; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`the brain daemon on port ${port} did not stop — close it and try again`);
  }

  async function restoreFrom(upload) {
    const staging = path.join(path.dirname(dataDir()), `.ccb-restore-staging-${Date.now()}`);
    try {
      progress('verifying the archive (every checksum, before touching anything)');
      const extracted = await backup.extractBackup(upload, staging);
      progress('saving the current data first (pre-restore copy)');
      const safety = await make({ suffix: '-pre-restore', withRemote: false });
      progress('stopping the memory service for a moment');
      const stopped = await stopBrainDaemon();
      progress('restoring');
      const r = backup.applyStaged(extracted, { dataDir: dataDir(), globalDir: globalDir() });
      let remoteResult = { included: false };
      if (r.remote && r.remote.included) {
        progress('handing the memory server its data (large databases take minutes)');
        try { remoteResult = { included: true, restored: true, ...(await remote.importRemote(r.remoteSnapshot, remoteOpts(progress))) }; }
        catch (err) { remoteResult = { included: true, restored: false, error: err.message }; }
      }
      const m = extracted.manifest;
      return { restored: r.restored, from: { createdAt: m.createdAt, host: m.host, pluginVersion: m.pluginVersion }, preRestoreBackup: safety.name, brainDaemonRestarted: stopped, remote: remoteResult };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(upload, { force: true });
    }
  }

  return {
    create(req, res) {
      const r = startJob('create', () => make());
      return r.ok ? json(res, r) : fail(res, r.error, 409);
    },
    status(req, res) { json(res, { ok: true, job }); },
    list(req, res) {
      try {
        fs.mkdirSync(backupsDir(), { recursive: true });
        const items = fs.readdirSync(backupsDir()).filter((f) => NAME_RE.test(f)).map((f) => { const st = fs.statSync(path.join(backupsDir(), f)); return { name: f, size: st.size, createdAt: st.mtime.toISOString() }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        json(res, { ok: true, dir: backupsDir(), items });
      } catch (err) { console.error(`[dashboard-backup] list: ${err.message}`); fail(res, err.message); }
    },
    download(req, res, url) {
      const name = url.searchParams.get('name') || '';
      if (!NAME_RE.test(name)) return fail(res, 'invalid backup name', 400);
      const file = path.join(backupsDir(), name);
      if (!fs.existsSync(file)) return fail(res, 'backup not found', 404);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    },
    async restore(req, res) {
      if (job.status === 'running') return fail(res, `a backup ${job.kind} is already running`, 409);
      fs.mkdirSync(backupsDir(), { recursive: true });
      const upload = path.join(backupsDir(), `.upload-${Date.now()}.tar.gz`);
      try { await pipeline(req, fs.createWriteStream(upload)); }
      catch (err) { fs.rmSync(upload, { force: true }); console.error(`[dashboard-backup] upload: ${err.message}`); return fail(res, `upload failed: ${err.message}`, 400); }
      const r = startJob('restore', () => restoreFrom(upload));
      return r.ok ? json(res, r) : fail(res, r.error, 409);
    },
  };
}

module.exports = { createBackupRoutes, NAME_RE, KEEP };
