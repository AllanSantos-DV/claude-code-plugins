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
 * The remote mcp-memory backend is backed up by its server (contract in
 * docs/BACKUP-CONTRACT.md): the archive records whether that part is included.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FORMAT = 'claude-code-boss-backup';
const FORMAT_VERSION = 1;
const MANIFEST = 'backup.json';
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

function packTar(files) {
  const parts = [];
  for (const { name, data, mtime = Date.now() } of files) {
    parts.push(tarHeader(name, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function unpackTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const str = (s, e) => h.subarray(s, e).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const prefix = str(345, 500);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const type = str(156, 157) || '0';
    off += 512;
    if (type === '0') out.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
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

function sqliteSnapshot(src, Database) {
  const tmp = path.join(os.tmpdir(), `ccb-backup-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const db = new Database(src, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  try { return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Build the archive. Returns { file, manifest }.
 * @param {{dataDir:string, globalDir:string, outFile:string, pluginVersion?:string,
 *          remote?:{kind:string, included:boolean, reason?:string, file?:string}, Database?:Function}} o
 */
function createBackup({ dataDir, globalDir, outFile, pluginVersion = '', remote = null, Database }) {
  if (!dataDir || !fs.existsSync(dataDir)) throw new Error(`backup: data dir not found: ${dataDir}`);
  const Db = Database || require('./sqlite-compat.js').loadSqlite();
  if (!Db) throw new Error('backup: no SQLite driver (node:sqlite / better-sqlite3) — cannot snapshot the stores safely');
  const files = [];
  const items = [];
  const add = (name, data, kind) => { files.push({ name, data }); items.push({ path: name, kind, size: data.length, sha256: sha(data) }); };
  for (const rel of walk(dataDir)) {
    const abs = path.join(dataDir, rel);
    const isDb = rel.endsWith('.db');
    add(`data/${toPosix(rel)}`, isDb ? sqliteSnapshot(abs, Db) : fs.readFileSync(abs), isDb ? 'sqlite' : 'file');
  }
  for (const rel of GLOBAL_FILES) {
    const abs = path.join(globalDir, rel);
    if (fs.existsSync(abs)) add(`global/${toPosix(rel)}`, fs.readFileSync(abs), 'file');
  }
  if (remote && remote.included && remote.file) add('remote/mcp-memory.snapshot', fs.readFileSync(remote.file), 'remote');
  const manifest = {
    format: FORMAT, version: FORMAT_VERSION, createdAt: new Date().toISOString(), host: os.hostname(),
    pluginVersion, items,
    remote: remote ? { kind: remote.kind, included: !!remote.included, ...(remote.reason ? { reason: remote.reason } : {}) } : { kind: 'none', included: false },
  };
  const tar = packTar([{ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...files]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, zlib.gzipSync(tar));
  fs.renameSync(tmp, outFile);
  return { file: outFile, manifest };
}

/** Parse + verify an archive (format, version, every checksum). Throws on anything wrong. */
function readBackup(buf) {
  let tar;
  try { tar = zlib.gunzipSync(buf); } catch (err) { throw new Error(`not a backup archive (gzip): ${err.message}`); }
  const entries = unpackTar(tar);
  const m = entries.find((e) => e.name === MANIFEST);
  if (!m) throw new Error('not a claude-code-boss backup (no backup.json)');
  const manifest = JSON.parse(m.data.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`not a claude-code-boss backup (format ${JSON.stringify(manifest.format)})`);
  if (manifest.version > FORMAT_VERSION) throw new Error(`backup format v${manifest.version} is newer than this plugin understands (v${FORMAT_VERSION}) — update the plugin first`);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  for (const it of manifest.items) {
    const data = byName.get(it.path);
    if (!data) throw new Error(`backup is incomplete: ${it.path} missing`);
    if (sha(data) !== it.sha256) throw new Error(`backup is corrupt: checksum mismatch on ${it.path}`);
    if (it.path.split('/').some((s) => s === '..' || s === '')) throw new Error(`backup has an unsafe path: ${it.path}`);
  }
  return { manifest, data: byName };
}

/**
 * Restore into dataDir/globalDir. The caller must have stopped the brain daemon (it holds
 * the stores open). Every replaced file is first moved aside; on any failure everything
 * already swapped is rolled back. Files not in the backup are left alone.
 * @returns {{restored:number, remote:object}}
 */
function restoreBackup(buf, { dataDir, globalDir }) {
  const { manifest, data } = readBackup(buf);
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
      const staged = `${target}.restore-${stamp}`;
      fs.writeFileSync(staged, data.get(it.path));
      const aside = fs.existsSync(target) ? `${target}.pre-restore-${stamp}` : null;
      if (aside) fs.renameSync(target, aside);
      try { fs.renameSync(staged, target); } catch (err) { if (aside) fs.renameSync(aside, target); fs.rmSync(staged, { force: true }); throw err; }
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
  return { restored: swapped.length, remote: manifest.remote };
}

module.exports = { createBackup, readBackup, restoreBackup, packTar, unpackTar, FORMAT, FORMAT_VERSION };
