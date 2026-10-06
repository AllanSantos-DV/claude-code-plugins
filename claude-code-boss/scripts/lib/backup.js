'use strict';
/**
 * backup.js — back up the plugin's LOCAL data into one portable .tar.gz and restore it on
 * another machine/installation. The local store matters even on the mcp-memory backend: it
 * keeps metrics, curation, policies, skills drafts and router history.
 *
 * What goes in (from the resolved data dir — never a hardcoded path; this machine's is
 * ~/.config/opencode/brain-data): everything EXCEPT re-creatable or machine-bound files —
 * the embedding models (re-downloaded), .runtime journals, the mcp server jar, locks, pids,
 * logs, tokens. SQLite stores run in WAL with the brain daemon holding them open, so each
 * .db is snapshotted with `VACUUM INTO` on its own connection (a raw copy is not consistent).
 * From the global dir only the brain and hooks user-config (the model-router one holds the
 * NVIDIA key — never exported).
 *
 * STREAMED end to end: the mcp-memory server's snapshot is GBs (6 GB memory.db → 4.2 GB
 * snapshot on the owner's machine), so nothing is held in memory — snapshots go to temp files,
 * the archive is written through gzip as a stream with the manifest LAST, and a restore is
 * extracted the same way into a staging dir and verified before anything is swapped.
 *
 * The remote mcp-memory backend is backed up by its server (contract in
 * docs/BACKUP-CONTRACT.md): the archive records whether that part is included.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');

const FORMAT = 'claude-code-boss-backup';
const FORMAT_VERSION = 1;
const MANIFEST = 'backup.json';
const REMOTE_ENTRY = 'remote/mcp-memory.snapshot';
const SKIP_TOP_DIRS = new Set(['models', '.runtime', 'mcp', 'logs', 'brain-http.spawn.lock']);
const SKIP_FILE = [/\.lock$/, /\.log$/, /\.token$/, /\.pid$/, /^brain-http\./, /^active-data-dir\.json$/, /^\.tmp-/, /-(wal|shm|journal)$/, /\.tmp$/, /^claude-wrapper\.exe$/, /^state\.json$/];
const GLOBAL_FILES = ['user-config.json', path.join('hooks', 'user-config.json')];

// ── tar (ustar) — small on purpose: regular files only, paths ≤ 255 bytes ────────────────
function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function tarHeader(name, size, mtime) {
  const b = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`backup: path too long for the archive: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  b.write(base, 0, 100, 'utf8');
  b.write(octal(0o644, 8), 100); b.write(octal(0, 8), 108); b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124); b.write(octal(Math.floor(mtime / 1000), 12), 136);
  b.write('        ', 148); b.write('0', 156); b.write('ustar\0', 257); b.write('00', 263);
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const x of b) sum += x;
  b.write(octal(sum, 7) + ' ', 148);
  return b;
}

function parseHeader(h) {
  const str = (s, e) => h.subarray(s, e).toString('utf8').replace(/\0.*$/s, '');
  const size = parseInt(str(124, 136).trim() || '0', 8);
  const prefix = str(345, 500);
  return { name: prefix ? `${prefix}/${str(0, 100)}` : str(0, 100), size, type: str(156, 157) || '0' };
}

// ── collect ─────────────────────────────────────────────────────────────────────────────
function walk(root, rel = '', acc = []) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!rel && SKIP_TOP_DIRS.has(e.name)) continue;
      walk(root, r, acc);
    } else if (e.isFile() && !SKIP_FILE.some((re) => re.test(e.name))) {
      acc.push(r);
    }
  }
  return acc;
}

function sqliteSnapshot(src, Database, tmpDir) {
  const tmp = path.join(tmpDir, `ccb-backup-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const db = new Database(src, { readonly: true });
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  return tmp;
}

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

const toPosix = (p) => p.split(path.sep).join('/');

/** Write entries [{name, file|data}] as a gzip'd tar, streaming (backpressure-aware). */
async function writeTarGz(entries, outFile) {
  const tmp = `${outFile}.tmp-${process.pid}`;
  const out = fs.createWriteStream(tmp);
  const gz = zlib.createGzip();
  gz.pipe(out);
  const write = async (buf) => { if (!gz.write(buf)) await once(gz, 'drain'); };
  try {
    for (const e of entries) {
      const size = e.data ? e.data.length : fs.statSync(e.file).size;
      await write(tarHeader(e.name, size, Date.now()));
      if (e.data) await write(e.data);
      else for await (const chunk of fs.createReadStream(e.file)) await write(chunk);
      const pad = (512 - (size % 512)) % 512;
      if (pad) await write(Buffer.alloc(pad, 0));
    }
    await write(Buffer.alloc(1024, 0));
    gz.end();
    await once(out, 'close');
  } catch (err) {
    gz.destroy(); out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, outFile);
}

/**
 * Build the archive. Returns { file, manifest }.
 * @param {{dataDir:string, globalDir:string, outFile:string, pluginVersion?:string,
 *          remote?:{kind:string, included:boolean, reason?:string, file?:string},
 *          Database?:Function, onProgress?:(msg:string)=>void}} o
 */
async function createBackup({ dataDir, globalDir, outFile, pluginVersion = '', remote = null, Database, onProgress = () => {} }) {
  if (!dataDir || !fs.existsSync(dataDir)) throw new Error(`backup: data dir not found: ${dataDir}`);
  const Db = Database || require('./sqlite-compat.js').loadSqlite();
  if (!Db) throw new Error('backup: no SQLite driver (node:sqlite / better-sqlite3) — cannot snapshot the stores safely');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-backup-'));
  try {
    const entries = [];
    const files = walk(dataDir);
    onProgress(`snapshotting ${files.length} local files`);
    for (const rel of files) {
      const abs = path.join(dataDir, rel);
      const isDb = rel.endsWith('.db');
      entries.push({ name: `data/${toPosix(rel)}`, file: isDb ? sqliteSnapshot(abs, Db, tmpDir) : abs, kind: isDb ? 'sqlite' : 'file' });
    }
    for (const rel of GLOBAL_FILES) {
      const abs = path.join(globalDir, rel);
      if (fs.existsSync(abs)) entries.push({ name: `global/${toPosix(rel)}`, file: abs, kind: 'file' });
    }
    if (remote && remote.included && remote.file) entries.push({ name: REMOTE_ENTRY, file: remote.file, kind: 'remote' });
    onProgress('computing checksums');
    const items = [];
    for (const e of entries) items.push({ path: e.name, kind: e.kind, size: fs.statSync(e.file).size, sha256: await hashFile(e.file) });
    const manifest = {
      format: FORMAT, version: FORMAT_VERSION, createdAt: new Date().toISOString(), host: os.hostname(),
      pluginVersion, items,
      remote: remote ? { kind: remote.kind, included: !!remote.included, ...(remote.reason ? { reason: remote.reason } : {}) } : { kind: 'none', included: false },
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    onProgress('writing the archive');
    await writeTarGz([...entries, { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) }], outFile);
    return { file: outFile, manifest };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** A tar entry name → a path inside stagingDir; throws on anything that could escape it. */
function stagedPath(stagingDir, name) {
  const segs = String(name).split('/');
  if (!name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || segs.some((s) => s === '..' || s === '' || s === '.')) throw new Error(`backup has an unsafe path: ${name}`);
  const p = path.join(stagingDir, ...segs);
  if (!p.startsWith(path.resolve(stagingDir) + path.sep)) throw new Error(`backup has an unsafe path: ${name}`);
  return p;
}

/**
 * Extract + verify an archive into stagingDir, streaming. Throws on anything wrong (format,
 * version, unsafe path, missing item, checksum). Returns { manifest, staged: Map<name, path> }.
 */
async function extractBackup(archiveFile, stagingDir) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const staged = new Map();
  const sums = new Map();
  let buf = Buffer.alloc(0);
  let cur = null; // { name, remaining, pad, out, hash }
  let ended = false;
  const input = fs.createReadStream(archiveFile).pipe(zlib.createGunzip());
  try {
    for await (const chunk of input) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (!ended) {
        if (cur) {
          if (cur.remaining > 0) {
            if (!buf.length) break;
            const take = buf.subarray(0, Math.min(buf.length, cur.remaining));
            buf = buf.subarray(take.length);
            cur.remaining -= take.length;
            cur.hash.update(take);
            if (!cur.out.write(take)) await once(cur.out, 'drain');
            continue;
          }
          if (buf.length < cur.pad) break;
          buf = buf.subarray(cur.pad);
          cur.out.end(); await once(cur.out, 'close');
          sums.set(cur.name, { sha256: cur.hash.digest('hex'), size: cur.size });
          cur = null;
          continue;
        }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512); buf = buf.subarray(512);
        if (h.every((x) => x === 0)) { ended = true; break; }
        const { name, size, type } = parseHeader(h);
        if (type !== '0') throw new Error(`backup has an unsupported entry type ${JSON.stringify(type)} (${name})`);
        const dest = stagedPath(stagingDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        staged.set(name, dest);
        cur = { name, size, remaining: size, pad: (512 - (size % 512)) % 512, out: fs.createWriteStream(dest), hash: crypto.createHash('sha256') };
      }
    }
  } catch (err) {
    if (cur) cur.out.destroy();
    if (/incorrect header check|unexpected end of file|invalid/i.test(err.message) && !staged.size) throw new Error(`not a backup archive (gzip): ${err.message}`);
    throw err;
  }
  if (cur) throw new Error(`backup is truncated (inside ${cur.name})`);
  const mPath = staged.get(MANIFEST);
  if (!mPath) throw new Error('not a claude-code-boss backup (no backup.json)');
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  if (manifest.format !== FORMAT) throw new Error(`not a claude-code-boss backup (format ${JSON.stringify(manifest.format)})`);
  if (manifest.version > FORMAT_VERSION) throw new Error(`backup format v${manifest.version} is newer than this plugin understands (v${FORMAT_VERSION}) — update the plugin first`);
  for (const it of manifest.items) {
    const got = sums.get(it.path);
    if (!got) throw new Error(`backup is incomplete: ${it.path} missing`);
    if (got.sha256 !== it.sha256 || got.size !== it.size) throw new Error(`backup is corrupt: checksum mismatch on ${it.path}`);
  }
  return { manifest, staged };
}

/** rename, falling back to copy when staging and target are on different volumes. */
function moveFile(src, dst) {
  try { fs.renameSync(src, dst); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst); fs.rmSync(src, { force: true });
  }
}

/**
 * Swap verified staged files into dataDir/globalDir. The caller must have stopped the brain
 * daemon (it holds the stores open). Every replaced file is first moved aside; on any failure
 * everything already swapped is rolled back. Files not in the backup are left alone.
 * @returns {{restored:number, remote:object, remoteSnapshot:string|null}}
 */
function applyStaged({ manifest, staged }, { dataDir, globalDir }) {
  const stamp = Date.now();
  const swapped = [];
  try {
    for (const it of manifest.items) {
      if (it.kind === 'remote') continue;
      const [root, ...rest] = it.path.split('/');
      const base = root === 'data' ? dataDir : root === 'global' ? globalDir : null;
      if (!base) throw new Error(`backup: unknown section ${root}`);
      const target = path.join(base, ...rest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const aside = fs.existsSync(target) ? `${target}.pre-restore-${stamp}` : null;
      if (aside) fs.renameSync(target, aside);
      try { moveFile(staged.get(it.path), target); } catch (err) { if (aside) fs.renameSync(aside, target); throw err; }
      swapped.push({ target, aside });
      if (it.kind === 'sqlite') for (const s of ['-wal', '-shm']) fs.rmSync(target + s, { force: true });
    }
  } catch (err) {
    for (const { target, aside } of swapped.reverse()) {
      try { fs.rmSync(target, { force: true }); if (aside) fs.renameSync(aside, target); } catch (e) { console.error(`[backup] rollback ${target}: ${e.message}`); }
    }
    throw new Error(`restore failed and was rolled back: ${err.message}`);
  }
  for (const { aside } of swapped) if (aside) fs.rmSync(aside, { force: true });
  return { restored: swapped.length, remote: manifest.remote, remoteSnapshot: staged.get(REMOTE_ENTRY) || null };
}

module.exports = { createBackup, extractBackup, applyStaged, writeTarGz, stagedPath, FORMAT, FORMAT_VERSION, REMOTE_ENTRY };
