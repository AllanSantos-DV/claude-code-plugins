'use strict';
/**
 * dashboard-backup.js — the dashboard's Backup card: create / list / download / restore the
 * plugin's data (lib/backup.js), plus the mcp-memory server part when the server supports it
 * (lib/backup-remote.js, docs/BACKUP-CONTRACT.md). Archives live in
 * globalDir()/backups (outside the data dir, so a backup never contains older backups).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = 5;
const NAME_RE = /^ccb-backup-[0-9TZ-]+(-pre-restore)?\.tar\.gz$/;
const MAX_UPLOAD = 1024 * 1024 * 1024;

function createBackupRoutes({ pluginRoot, dataDir, globalDir, json, fail, deps = {} }) {
  const lib = (m) => require(path.join(pluginRoot, 'scripts', 'lib', m));
  const backup = deps.backup || lib('backup.js');
  const remote = deps.remote || lib('backup-remote.js');
  const backupsDir = () => path.join(globalDir(), 'backups');
  const pluginVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version; } catch (err) { void err; return ''; } };
  const remoteOpts = () => ({
    pluginRoot, tmpDir: os.tmpdir(),
    loadConfig: deps.loadConfig || (() => lib('brain-config.js').load()),
    discoverUrl: deps.discoverUrl || (() => lib('mcp-wizard.js').discoverDaemonUrl()),
  });

  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  function prune() {
    const dir = backupsDir();
    const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(KEEP)) fs.rmSync(path.join(dir, f), { force: true });
  }

  async function make(suffix = '') {
    const rem = await remote.exportRemote(remoteOpts());
    const outFile = path.join(backupsDir(), `ccb-backup-${stamp()}${suffix}.tar.gz`);
    try {
      const { manifest } = backup.createBackup({ dataDir: dataDir(), globalDir: globalDir(), outFile, pluginVersion: pluginVersion(), remote: rem });
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

  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { reject(new Error('backup file too large (> 1 GB)')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  return {
    async create(req, res) {
      try { json(res, { ok: true, backup: await make() }); }
      catch (err) { console.error(`[dashboard-backup] create: ${err.message}`); fail(res, err.message); }
    },
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
      try {
        const buf = await readRaw(req);
        const { manifest, data } = backup.readBackup(buf); // verify everything before touching anything
        const safety = await make('-pre-restore');           // current state, in case the user wants it back
        const stopped = await stopBrainDaemon();
        const r = backup.restoreBackup(buf, { dataDir: dataDir(), globalDir: globalDir() });
        let remoteResult = { included: false };
        if (manifest.remote && manifest.remote.included) {
          try { remoteResult = { included: true, restored: true, ...(await remote.importRemote(data.get('remote/mcp-memory.snapshot'), remoteOpts())) }; }
          catch (err) { remoteResult = { included: true, restored: false, error: err.message }; }
        }
        json(res, { ok: true, restored: r.restored, from: { createdAt: manifest.createdAt, host: manifest.host, pluginVersion: manifest.pluginVersion }, preRestoreBackup: safety.name, brainDaemonRestarted: stopped, remote: remoteResult });
      } catch (err) { console.error(`[dashboard-backup] restore: ${err.message}`); fail(res, err.message, 400); }
    },
  };
}

module.exports = { createBackupRoutes, NAME_RE, KEEP };
