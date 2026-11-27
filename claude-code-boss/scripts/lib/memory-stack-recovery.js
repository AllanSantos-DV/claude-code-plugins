'use strict';
/**
 * memory-stack-recovery.js — brings the memory stack the Boss manages (the local mcp-memory server
 * and the embeddings house and graph engine it starts) back after an update or an outage, with no
 * action from the user. Each stage is bounded, journals a line and raises a Windows notification,
 * and the outcome is one of four states a screen can show: recovering, recovered, degraded (the
 * server answers but a resource is missing) or critical (it cannot run without the missing piece).
 *
 * A configured server address means the server is the user's own: nothing here runs for it.
 * Every external effect is a seam in `deps`, so a test never reaches the real registry, server or toasts.
 */
const fs = require('fs');
const cp = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');
const { readJsonLoud } = require('../../engine/lib/json-file.js');
const { settleWithin } = require('../../engine/lib/settle-within.js');

const STATES = ['ok', 'recovering', 'recovered', 'degraded', 'critical'];
const OBSOLETE_ENV = [
  { name: 'MCP_RULES_MODE', removedIn: '3.0.0' },
  { name: 'MCP_ENFORCE_RULES', removedIn: '3.0.0' },
];
const MODEL_FILES = ['model.onnx', 'tokenizer.json'];
const MODEL_RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const REPLAY_EVERY_MS = 6 * 60 * 60 * 1000;
const REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_FILES = 100;
const JAR_SETTLE_MS = 2 * 60 * 1000;
const RECOVERED_SHOWN_MS = 24 * 60 * 60 * 1000;
const STUCK_RECOVERING_MS = 10 * 60 * 1000;
const FRESH_OK_MS = 5 * 60 * 1000;
const LAUNCH_RETRY_MS = 10 * 60 * 1000;
const SIMILAR_AT = 0.8;
const LAUNCH_WAIT_PROBES = 10;
const MODEL_WAIT_PROBES = 20;
const PROBE_PAUSE_MS = 1000;
const DEFAULT_STAGE_MS = { env: 8000, probe: 6000, launch: 90000, model: 60000, replay: 60000, jars: 10000 };

const stateFile = () => path.join(require('../../engine/lib/data-dir.js').globalDir(), 'memory-stack-state.json');
const home = (env) => env.USERPROFILE || env.HOME || os.homedir();

/** Reads and writes the user-level environment variables of the machine (the registry on Windows). */
function windowsUserEnv(exec) {
  const reg = (args) => (exec
    ? exec('reg.exe', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    : cp.execFileSync('reg.exe', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }));
  const checked = (name) => { if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`refusing an unexpected variable name: ${name}`); return name; };
  return {
    get(name) {
      try {
        const m = new RegExp(`^\\s*${checked(name)}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(reg(['query', 'HKCU\\Environment', '/v', name]));
        return m ? m[1].trim() : null;
      } catch (err) {
        if (err && err.status === 1) return null;
        throw err;
      }
    },
    set(name, value) { reg(['add', 'HKCU\\Environment', '/v', checked(name), '/t', 'REG_SZ', '/d', value, '/f']); },
    del(name) { reg(['delete', 'HKCU\\Environment', '/v', checked(name), '/f']); },
  };
}

/**
 * Remove the user variables the current server refuses to start with. The values are written to a
 * backup file first and the backup is read back before anything is deleted. A variable that only
 * this process carries (injected by the parent) is dropped from the copy the server will inherit,
 * without a backup or a report: it comes back with every session and there is nothing to restore.
 * @returns {{changed: Array<{name:string,value:string,scope:string}>, backupFile?: string}}
 */
function neutralizeObsoleteEnv({ userEnv, env = process.env, backupDir, now = Date.now }) {
  const found = [];
  for (const v of OBSOLETE_ENV) {
    const user = userEnv ? userEnv.get(v.name) : null;
    if (user) found.push({ name: v.name, value: user, scope: 'user', removedIn: v.removedIn });
  }
  const dropFromProcess = () => { for (const v of OBSOLETE_ENV) delete env[v.name]; };
  if (!found.length) { dropFromProcess(); return { changed: [] }; }
  const backupFile = path.join(backupDir, `env-backup-${now()}.json`);
  fs.mkdirSync(backupDir, { recursive: true });
  writeJsonAtomic(backupFile, { at: now(), entries: found });
  if (readJsonLoud(backupFile, 'memory-stack env backup').entries.length !== found.length) throw new Error(`the backup ${backupFile} did not read back; nothing was removed`);
  for (const f of found) userEnv.del(f.name);
  dropFromProcess();
  return { changed: found, backupFile };
}

const EMBEDDING_MODEL_NAME = /e5|bge|gte|minilm|mpnet|embed|sentence|labse|nomic|jina/i;
const hasModel = (dir) => !!dir && MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
/** Were the model files of `dir` written after `since`? A file whose date cannot be read counts as not newer. */
const modelRewrittenSince = (dir, since) => MODEL_FILES.some((f) => {
  try { return fs.statSync(path.join(dir, f)).mtimeMs > since; } catch (err) { console.error(`[memory-stack] cannot read the date of ${f} in ${dir}: ${err.message}`); return false; }
});

/**
 * An embedding model already on disk, in the order the server itself keeps it: the variable already
 * set, ~/.mcp-memory/model, then the snapshots of the model hub cache. A hub cache is shared with
 * every other model on the machine, so it is used only when exactly one embedding model is in it
 * (by name); anything ambiguous is reported, never guessed: vectors from another model would
 * silently corrupt recall.
 * @returns {?{dir:string, source:string, configured:boolean}|{ambiguous:string[]}}
 */
function findLocalModelDir({ env = process.env } = {}) {
  if (hasModel(env.CASA_MODEL_DIR)) return { dir: env.CASA_MODEL_DIR, source: 'CASA_MODEL_DIR', configured: true };
  const own = path.join(home(env), '.mcp-memory', 'model');
  if (hasModel(own)) return { dir: own, source: '~/.mcp-memory/model', configured: false };
  const hubs = [env.HF_HUB_CACHE, env.HF_HOME && path.join(env.HF_HOME, 'hub'), path.join(home(env), '.cache', 'huggingface', 'hub')].filter(Boolean);
  const snapshots = [];
  for (const hub of hubs) {
    let models = [];
    try { models = fs.readdirSync(hub).filter((n) => n.startsWith('models--')); } catch (err) { if (err.code !== 'ENOENT') console.error(`[memory-stack] cannot list ${hub}: ${err.message}`); continue; }
    for (const m of models) {
      const snapDir = path.join(hub, m, 'snapshots');
      let revs = [];
      try { revs = fs.readdirSync(snapDir); } catch (err) { if (err.code !== 'ENOENT') console.error(`[memory-stack] cannot list ${snapDir}: ${err.message}`); continue; }
      if (!EMBEDDING_MODEL_NAME.test(m)) continue;
      for (const r of revs) if (hasModel(path.join(snapDir, r))) snapshots.push({ dir: path.join(snapDir, r), model: m, mtime: fs.statSync(path.join(snapDir, r)).mtimeMs });
    }
  }
  snapshots.sort((a, b) => b.mtime - a.mtime);
  const models = [...new Set(snapshots.map((s) => s.model))];
  if (models.length > 1) return { ambiguous: models };
  return snapshots.length ? { dir: snapshots[0].dir, source: 'model hub cache', configured: false } : null;
}

/**
 * The stack state from the server's /health, or from the reason it did not answer.
 * @param {{health?: object, error?: string}} probe
 * @returns {{state:'ok'|'recovering'|'degraded'|'critical', message:string, nextAction:string, problems:string[], casaDown:boolean}}
 */
function classifyStack({ health, error }) {
  if (!health) {
    return { state: 'critical', casaDown: false, problems: [], message: `The memory server does not answer: ${error || 'no reply'}.`, nextAction: 'The Boss tries to start it again at the next session start; the cause is in ~/.mcp-memory/logs/daemon.log.' };
  }
  const checks = health.checks || {};
  const product = health.product || {};
  const deps = Array.isArray(product.dependencies) ? product.dependencies : [];
  const critical = [];
  const degraded = [];
  const updating = [];
  if (checks.database && checks.database !== 'ok') critical.push(`database ${checks.database}`);
  if (checks.embedding_model && checks.embedding_model !== 'ok') critical.push(`embedding model ${checks.embedding_model}`);
  let casaDown = false;
  let casaNeedsModel = false;
  for (const d of deps) {
    const why = [d.reason, d.warning].filter(Boolean).join(' — ');
    if (d.state === 'updating') updating.push(`${d.name}: ${d.reason || 'updating'}`);
    else if (d.state === 'missing' || d.state === 'degraded') {
      if (d.name === 'casa-de-embeddings') {
        casaDown = true;
        casaNeedsModel = d.state === 'missing' || /model|CASA_MODEL_DIR|download|baix|503|proxy/i.test(why);
        critical.push(`${d.name} ${d.state}${why ? ` (${why})` : ''}`);
      } else degraded.push(`${d.name} ${d.state}${why ? ` (${why})` : ''}`);
    } else if (d.warning) degraded.push(`${d.name}: ${d.warning}`);
  }
  if (product.update && product.update.error) degraded.push(`the server update check failed: ${product.update.error}`);
  const join = (list) => list.join('; ');
  if (critical.length) return { state: 'critical', casaDown, casaNeedsModel, problems: [...critical, ...degraded], message: `The memory server is up but cannot work without: ${join(critical)}.`, nextAction: 'The Boss looks for a local copy of the missing piece and restarts the server once; otherwise see ~/.mcp-memory/logs/daemon.log.' };
  if (updating.length) return { state: 'recovering', casaDown, casaNeedsModel, problems: updating, message: `The memory stack is recovering: ${join(updating)}.`, nextAction: 'Nothing to do; it finishes by itself.' };
  if (degraded.length) return { state: 'degraded', casaDown, casaNeedsModel, problems: degraded, message: `The memory server is up with a resource missing: ${join(degraded)}.`, nextAction: 'Memory keeps working; the Boss shows the failure here until it is resolved.' };
  return { state: 'ok', casaDown, casaNeedsModel, problems: [], message: 'The memory stack is healthy.', nextAction: '' };
}

/** GET /health of the local server, with a hard ceiling. */
function fetchHealth({ env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let url = '';
    try { url = require('./mcp-memory-auto-update.js').resolveTargetUrl({ runDir: env.MCP_RUN_DIR || path.join(home(env), '.mcp-memory', 'run') }); } catch (err) { return resolve({ error: err.message }); }
    if (!url) return resolve({ error: 'no daemon.json: the server never announced itself' });
    const req = require('http').get(`${url.replace(/\/+$/, '')}/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ health: JSON.parse(body) }); } catch (err) { resolve({ error: `/health is not JSON: ${err.message}` }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `/health did not answer in ${timeoutMs} ms` }); });
    req.on('error', (err) => resolve({ error: err.message }));
  });
}

/**
 * Remove the server versions older than the one running, once the running one is confirmed healthy.
 * @returns {{removed: string[], kept?: string, reason?: string}}
 */
function removeOldJars({ health, env = process.env }) {
  const L = require('./mcp-bootstrap/launcher.js');
  const newest = L.newestInstalledJar(env);
  if (!newest) return { removed: [], reason: 'no server jar installed' };
  const running = String(health && health.version || '');
  if (health.status !== 'healthy' || (health.checks && health.checks.database !== 'ok')) return { removed: [], reason: 'the server is not healthy' };
  if (L.compareVersions(running, newest.version) !== 0) return { removed: [], reason: `the running version ${running} is not the newest jar ${newest.version}` };
  const upMs = Number(health.uptimeMs);
  if (!Number.isFinite(upMs) || upMs < JAR_SETTLE_MS) return { removed: [], reason: 'the server has been up for under two minutes' };
  const removed = [];
  const locked = [];
  for (const sub of ['lib', 'server']) {
    const dir = path.join(home(env), '.mcp-memory', sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') console.error(`[memory-stack] cannot list ${dir}: ${err.message}`); continue; }
    for (const n of names) {
      const m = /^mcp-memory-server-(\d+\.\d+\.\d+)\.jar$/.exec(n);
      if (!m || L.compareVersions(m[1], newest.version) >= 0) continue;
      try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch (err) { locked.push(`${n}: ${err.code || err.message}`); }
    }
  }
  return { removed, locked, kept: newest.version };
}

const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: m[2].trim() };
};
const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '');
/** The lowercase words of a text longer than two characters, accents folded. */
const tokens = (s) => new Set(fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 2));
const NEGATIONS = new Set(['nao', 'nunca', 'sem', 'not', 'never']);
/** The negation words of a text, which the length filter of `tokens` would otherwise drop. */
const negations = (s) => new Set(fold(s).replace(/n['’]t\b/g, ' not').split(/[^\p{L}\p{N}]+/u).filter((w) => NEGATIONS.has(w)));
/**
 * How much two texts overlap, as the share of words they have in common. Texts that negate
 * different things are never alike, however many words they share.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0 (nothing in common) to 1 (the same words)
 */
function similarity(a, b) {
  const x = tokens(a); const y = tokens(b);
  if (!x.size || !y.size) return 0;
  const nx = negations(a); const ny = negations(b);
  if (nx.size !== ny.size || [...nx].some((t) => !ny.has(t))) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
const idFor = (text) => { const h = crypto.createHash('sha256').update(text).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };

/**
 * The working directory a Claude Code project folder belongs to, read from its newest transcripts.
 * @param {string} slugDir `~/.claude/projects/<slug>`
 * @returns {?string}
 */
function projectCwd(slugDir) {
  let transcripts = [];
  try { transcripts = fs.readdirSync(slugDir).filter((n) => n.endsWith('.jsonl')).map((n) => ({ n, t: fs.statSync(path.join(slugDir, n)).mtimeMs })).sort((a, b) => b.t - a.t); } catch (err) { console.error(`[memory-stack] cannot list ${slugDir}: ${err.message}`); return null; }
  for (const { n } of transcripts.slice(0, 3)) {
    let head = '';
    try {
      const fd = fs.openSync(path.join(slugDir, n), 'r');
      try {
        const buf = Buffer.alloc(200000);
        head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      } finally { fs.closeSync(fd); }
    } catch (err) { console.error(`[memory-stack] cannot read ${n}: ${err.message}`); continue; }
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (m) return JSON.parse(`"${m[1]}"`);
  }
  return null;
}

/** The auto-memory files (`~/.claude/projects/<slug>/memory/*.md`) written at or after `since`; a file whose date cannot be read is added to `failed`. */
function listMemoryFiles({ env = process.env, since, failed = [] }) {
  const root = path.join(home(env), '.claude', 'projects');
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch (err) { if (err.code !== 'ENOENT') console.error(`[memory-stack] cannot list ${root}: ${err.message}`); return out; }
  for (const slug of slugs) {
    const dir = path.join(root, slug, 'memory');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') console.error(`[memory-stack] cannot list ${dir}: ${err.message}`); continue; }
    for (const n of names) {
      if (!n.endsWith('.md') || n === 'MEMORY.md') continue;
      const file = path.join(dir, n);
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch (err) { failed.push(`${n}: ${err.message}`); continue; }
      if (mtimeMs >= since) out.push({ file, slugDir: path.join(root, slug) });
    }
  }
  return out;
}

/**
 * Copy the memories that were written to files while the server was down into the server, once
 * each: a file already copied (same content) or a memory the server already holds is skipped,
 * and no file is ever deleted. `abort.aborted` set by the caller stops the copy at the next file
 * or before the next save: a replay that timed out keeps running otherwise, after its lock is gone.
 * @returns {{copied:number, skippedDuplicate:number, unmapped:number, failed:string[], scanned:number}}
 */
async function replayFileMemories({ backend, env = process.env, since, ledger, deadline, abort = { aborted: false }, now = Date.now, resolveProject = (o) => require('../../engine/lib/project-id.js').tryResolveProjectId(o) }) {
  const r = { copied: 0, skippedDuplicate: 0, unmapped: 0, failed: [], scanned: 0 };
  const files = listMemoryFiles({ env, since, failed: r.failed });
  const cwds = new Map();
  let worked = 0;
  for (const { file, slugDir } of files) {
    if (abort.aborted || now() > deadline) { r.failed.push(`${path.basename(file)}: the replay budget ran out; the rest continues at the next run`); break; }
    r.scanned++;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { r.failed.push(`${path.basename(file)}: ${err.message}`); continue; }
    const id = idFor(text);
    if (!cwds.has(slugDir)) cwds.set(slugDir, projectCwd(slugDir));
    const cwd = cwds.get(slugDir);
    const project = cwd && resolveProject({ cwd });
    const ledgerKey = project ? `${project}:${id}` : id;
    if (ledger[ledgerKey]) { r.skippedDuplicate++; continue; }
    if (++worked > REPLAY_MAX_FILES) { r.failed.push(`${path.basename(file)}: more than ${REPLAY_MAX_FILES} new files in one run; the rest continues at the next run`); break; }
    const fm = frontmatter(text);
    if (!fm || !fm.meta.name || !fm.body) { r.failed.push(`${path.basename(file)}: no name/description/body frontmatter`); continue; }
    if (!project) { r.unmapped++; continue; }
    try {
      await backend.init({ project });
      const wanted = `${fm.meta.name}\n${fm.meta.description || ''}\n${fm.body}`;
      let dup = !!(await backend.get(id));
      if (!dup) {
        const hits = await backend.search(`${fm.meta.name} ${fm.meta.description || ''}`, { limit: 5 });
        dup = (hits || []).some((h) => similarity(wanted, [h.title, h.summary, typeof h.content === 'string' ? h.content : h.content && h.content.detail].filter(Boolean).join('\n')) >= SIMILAR_AT);
      }
      if (abort.aborted) break;
      if (!dup) {
        await backend.save({ id, title: fm.meta.name, summary: fm.meta.description || '', content: { detail: fm.body }, type: fm.meta.type === 'feedback' ? 'lesson' : 'knowledge', tags: ['replayed-from-file'], confidence: 0.6, source: { kind: 'memory-file', file: path.basename(file) } });
        r.copied++;
      } else r.skippedDuplicate++;
      ledger[ledgerKey] = { file: path.basename(file), at: now() };
    } catch (err) { r.failed.push(`${path.basename(file)}: ${err.message}`); }
  }
  return r;
}

const bounded = async (name, promise, ms) => {
  const s = await settleWithin(promise, ms);
  if (s.status === 'ok') return s.value;
  const err = new Error(s.status === 'timeout' ? `${name} did not finish within ${ms} ms` : `${name}: ${s.err && s.err.message || s.err}`);
  err.timedOut = s.status === 'timeout';
  throw err;
};

/** What the screens show: the state file, with a recovered state that fades to ok after a day. */
function readStack({ file = stateFile(), now = Date.now } = {}) {
  const s = readJsonLoud(file, 'memory-stack-state');
  if (!s) return null;
  if (s.state === 'recovered' && now() - (s.recoveredAt || 0) > RECOVERED_SHOWN_MS) return { ...s, state: 'ok', message: 'The memory stack is healthy.', nextAction: '' };
  if (s.state === 'recovering' && now() - (s.updatedAt || 0) > STUCK_RECOVERING_MS) return { ...s, state: 'critical', message: `A recovery started and never finished (${s.message}).`, nextAction: 'The Boss retries at the next session start; the detail is in the notices log.' };
  return s;
}

/**
 * Run the recovery once. Never throws: every failure becomes a step with its reason and the next
 * action, a log line and a notification, and the final state says what is still wrong.
 * @param {object} [opts]
 * @param {object} [opts.config] brain config (the replay runs only for a managed local server)
 * @param {object} [opts.deps] seams: userEnv, env, probe, launch, restart, backend, toast, log, now, sleep, file, backupDir, ledgerFile
 * @returns {Promise<{state:string, message:string, nextAction:string, steps:object[], advisory:string}>}
 */
async function recoverMemoryStack(opts = {}) {
  const d = opts.deps || {};
  const STAGE_MS = { ...DEFAULT_STAGE_MS, ...d.stageMs };
  const env = d.env || process.env;
  const now = d.now || Date.now;
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const file = d.file || stateFile();
  const globalDir = path.dirname(file);
  const backupDir = d.backupDir || path.join(globalDir, 'memory-stack-backups');
  const ledgerFile = d.ledgerFile || path.join(globalDir, 'memory-stack-replayed.json');
  const log = d.log || ((line) => require('./notice-once.js').logDetail(`[memory-stack] ${line}`));
  const toast = d.toast || ((t) => require('./win-toast.js').toast(t));
  const probe = d.probe || (() => fetchHealth({ env }));
  const mcp = (opts.config && opts.config.backend && opts.config.backend.mcpMemory) || {};
  const steps = [];
  let previous = null;
  try { previous = readJsonLoud(file, 'memory-stack-state'); } catch (err) { log(`state file unreadable, starting a new one: ${err.message}`); }
  let written = { ...(previous || {}) };
  const save = (patch) => { written = { ...written, ...patch }; writeJsonAtomic(file, { ...written, steps: steps.slice(-30), updatedAt: now() }); };
  const noticeBase = globalDir;
  const say = (step, status, detail, nextAction) => {
    steps.push({ step, status, detail, nextAction: nextAction || '', at: now() });
    log(`${step} ${status}: ${detail}${nextAction ? ` — next: ${nextAction}` : ''}`);
    const body = `${detail}${nextAction ? ` ${nextAction}` : ''}`.slice(0, 240);
    if (status === 'done') toast({ title: 'Boss memory: recovered a step', body });
    // The same failure is notified once until it is resolved; the log keeps every repeat.
    else if (status === 'failed' && require('./notice-once.js').notice({ key: `memory-stack:${step}`, signature: detail, text: body, detail, base: noticeBase })) toast({ title: 'Boss memory: needs attention', body });
  };
  const outcome = (state, c) => {
    const patch = { state, message: c.message, nextAction: c.nextAction, problems: c.problems || [] };
    if (state === 'ok' || state === 'recovered') { patch.outageSince = null; patch.modelTriedDir = null; patch.launchFailedAt = null; } else if (!(previous && previous.outageSince)) patch.outageSince = now();
    if (state === 'recovered') patch.recoveredAt = c.keepRecoveredAt || now();
    if (state === 'ok') for (const s of ['server-start', 'model', 'replay', 'recovery']) require('./notice-once.js').recovered(`memory-stack:${s}`, { base: noticeBase });
    save(patch);
    const changed = !previous || previous.state !== state || previous.message !== c.message;
    const advisory = state !== 'ok' && (steps.length || changed) ? `[BRAIN] ${c.message}${c.nextAction ? ` ${c.nextAction}` : ''}` : '';
    return { state, message: c.message, nextAction: c.nextAction, steps, advisory };
  };

  const untouched = (message) => ({ state: 'ok', message, nextAction: '', steps, advisory: '', untouched: true });
  if (!opts.config || !opts.config.backend || opts.config.backend.type !== 'mcp-memory') return untouched('The memory backend is not mcp-memory: nothing to recover.');
  if (String(mcp.serverUrl || '').trim()) return untouched('The server address is set: the server is yours and the Boss never touches it.');
  if (!opts.force && previous && previous.state === 'ok' && now() - (previous.updatedAt || 0) < FRESH_OK_MS) return { ...untouched(previous.message), skipped: true };
  const lockFile = path.join(globalDir, '.memory-stack.lock');
  const lock = d.lock || { acquire: () => require('../../engine/lib/process-lock.js').acquireFileLock(lockFile), release: (owner) => require('../../engine/lib/process-lock.js').releaseFileLock(lockFile, owner) };
  const held = lock.acquire();
  if (!held || !held.acquired) return { ...untouched(previous ? previous.message : 'Another recovery is running.'), skipped: true };
  try {
    save({ state: 'recovering', message: 'Checking the memory stack.', nextAction: '', recoveringSince: now() });
    const userEnv = d.userEnv === undefined ? (process.platform === 'win32' ? windowsUserEnv() : null) : d.userEnv;
    const envFix = await bounded('obsolete variable check', Promise.resolve().then(() => neutralizeObsoleteEnv({ userEnv, env, backupDir, now })), STAGE_MS.env);
    if (envFix.changed.length) {
      say('obsolete-env', 'done', `Removed ${envFix.changed.map((c) => `${c.name} (${c.scope})`).join(', ')}: the server refuses them since ${envFix.changed[0].removedIn}. The values are saved in ${envFix.backupFile}.`);
    }

    let p = await bounded('health probe', Promise.resolve(probe()), STAGE_MS.probe);
    let c = classifyStack(p);
    if (!p.health && previous && now() - (previous.launchFailedAt || 0) < LAUNCH_RETRY_MS) {
      log(`server start skipped: it failed less than ${LAUNCH_RETRY_MS / 60000} minutes ago (${previous.message})`);
    } else if (!p.health) {
      const launch = d.launch || (() => require('./mcp-bootstrap/launcher.js').runLauncher({ env }));
      let L = await bounded('server start', Promise.resolve(launch()), STAGE_MS.launch).catch((err) => ({ ok: false, error: err.message, timedOut: err.timedOut }));
      // A start that ran past its budget keeps running: the same probe window decides whether it came up.
      const pending = !L.ok && !!L.timedOut;
      const reportStart = () => {
        if (L.ok) return say('server-start', 'done', `The memory server is running again (v${L.version || '?'}).`);
        say('server-start', 'failed', `The memory server did not start: ${L.error}`, 'Fix the cause shown, then open a new session; the Boss tries again.');
        save({ launchFailedAt: now() });
        previous = { ...(previous || {}), launchFailedAt: now() };
      };
      if (!pending) reportStart();
      for (let i = 0; i < LAUNCH_WAIT_PROBES && !p.health && (L.ok || pending); i++) { await sleep(PROBE_PAUSE_MS); p = await bounded('health probe', Promise.resolve(probe()), STAGE_MS.probe); }
      if (pending) {
        if (p.health) L = { ok: true, version: p.health.version };
        reportStart();
      }
      c = classifyStack(p);
    }

    if (p.health && c.casaNeedsModel && !(previous && now() - (previous.modelRestartAt || 0) < MODEL_RESTART_COOLDOWN_MS)) {
      const userValue = (userEnv && userEnv.get('CASA_MODEL_DIR')) || env.CASA_MODEL_DIR;
      const bossValueGone = !!userValue && !hasModel(userValue) && !!previous && previous.modelWrittenByBoss === userValue;
      const model = !userValue || bossValueGone ? findLocalModelDir({ env })
        : hasModel(userValue) ? { dir: userValue, source: 'CASA_MODEL_DIR', configured: true }
          : { invalid: userValue };
      if (model && model.invalid) say('model', 'failed', `CASA_MODEL_DIR points at ${model.invalid}, which has no model files.`, 'Fix or remove that variable: the Boss never overwrites a value you set.');
      else if (model && model.ambiguous) say('model', 'failed', `Several embedding models are in the hub cache (${model.ambiguous.join(', ')}) and the Boss cannot tell which one the server uses.`, 'Set CASA_MODEL_DIR to the right folder, or copy the model to ~/.mcp-memory/model.');
      else if (!model) say('model', 'failed', 'The embeddings house has no model and none is on this machine.', 'Download the model once (the proxy may block it) or copy it to ~/.mcp-memory/model.');
      else if (previous && previous.modelTriedDir === model.dir && !modelRewrittenSince(model.dir, previous.modelRestartAt || 0)) log(`model step skipped: ${model.dir} was already tried and the house is still down`);
      else {
        save({ modelRestartAt: now(), modelTriedDir: model.dir });
        previous = { ...(previous || {}), modelRestartAt: now(), modelTriedDir: model.dir };
        if (!model.configured && userEnv) {
          userEnv.set('CASA_MODEL_DIR', model.dir);
          save({ modelWrittenByBoss: model.dir });
          previous = { ...previous, modelWrittenByBoss: model.dir };
        }
        env.CASA_MODEL_DIR = model.dir;
        const restart = d.restart || (() => defaultRestart({ env }));
        let R = await bounded('server restart', Promise.resolve(restart()), STAGE_MS.model).catch((err) => ({ ok: false, error: err.message, timedOut: err.timedOut }));
        const pending = !R.ok && !!R.timedOut;
        const restartFailed = () => say('model', 'failed', `Found the model in ${model.source} (${model.dir}) but the restart failed: ${R.error}`, 'Restart the memory server once; the variable CASA_MODEL_DIR is already set.');
        if (!R.ok && !pending) restartFailed();
        else {
          for (let i = 0; i < MODEL_WAIT_PROBES; i++) { await sleep(PROBE_PAUSE_MS); p = await bounded('health probe', Promise.resolve(probe()), STAGE_MS.probe); c = classifyStack(p); if (p.health && !c.casaDown) break; }
          if (pending && (!p.health || c.casaDown)) restartFailed();
          else if (!p.health) say('model', 'failed', `CASA_MODEL_DIR was set to ${model.dir} (${model.source}) and the server was restarted, but it does not answer: ${p.error || 'no reply'}.`, 'See ~/.mcp-memory/logs/daemon.log; the Boss tries again at the next session start.');
          else if (c.casaDown) say('model', 'failed', `CASA_MODEL_DIR was set to ${model.dir} (${model.source}) and the server restarted, but the embeddings house is still down.`, 'See ~/.casa-de-embeddings logs.');
          else say('model', 'done', `The embeddings house now uses the model found in ${model.source}; CASA_MODEL_DIR points at ${model.dir}.`);
        }
      }
    }

    if (p.health && c.state !== 'critical') {
      const due = !(previous && previous.replayedAt && now() - previous.replayedAt < REPLAY_EVERY_MS);
      if (due && (opts.config && opts.config.backend && opts.config.backend.type) === 'mcp-memory') {
        const backend = d.backend || require('../../engine/brain-backend.js');
        let ledger = {};
        try { ledger = readJsonLoud(ledgerFile, 'memory-stack-replayed') || {}; } catch (err) { log(`replay ledger unreadable, copies are re-checked by content: ${err.message}`); }
        const since = previous && previous.outageSince ? previous.outageSince - 24 * 60 * 60 * 1000 : now() - REPLAY_WINDOW_MS;
        const abort = { aborted: false };
        const rep = await bounded('memory replay', replayFileMemories({ backend, env, since, ledger, deadline: now() + STAGE_MS.replay - 2000, abort, now, resolveProject: d.resolveProject }), STAGE_MS.replay).catch((err) => { abort.aborted = true; return { error: err.message }; });
        if (rep.error) say('replay', 'failed', `Copying the memories saved in files failed: ${rep.error}`, 'The files are kept; the Boss retries at the next run.');
        else {
          writeJsonAtomic(ledgerFile, ledger);
          save({ replayedAt: now() });
          if (rep.copied) say('replay', 'done', `Copied ${rep.copied} memor${rep.copied === 1 ? 'y' : 'ies'} saved in files into the server (${rep.skippedDuplicate} already there, ${rep.unmapped} without a known project). The files were kept.`);
          if (rep.failed.length) say('replay', 'failed', `${rep.failed.length} file(s) were not copied: ${rep.failed.slice(0, 3).join('; ')}`, 'They stay in their files; the Boss retries at the next run.');
        }
      }
      if (c.state === 'ok') {
        const jars = removeOldJars({ health: p.health, env });
        if (jars.removed.length) say('old-version', 'done', `Removed the previous server version${jars.removed.length > 1 ? 's' : ''}: ${jars.removed.join(', ')} (v${jars.kept} is healthy).`);
        if (jars.locked.length) log(`old-version: could not remove ${jars.locked.join('; ')}; the next run tries again`);
      }
    }

    const failed = steps.filter((s) => s.status === 'failed');
    if (c.state === 'ok' && failed.length) {
      return outcome('degraded', { message: `The memory server is healthy but a recovery step failed: ${failed.map((f) => `${f.step}: ${f.detail}`).join('; ')}`.slice(0, 600), nextAction: failed[0].nextAction, problems: failed.map((f) => f.detail) });
    }
    if (c.state === 'ok' && steps.some((s) => s.status === 'done')) return outcome('recovered', c);
    if (c.state === 'ok' && previous && previous.state === 'recovered' && now() - (previous.recoveredAt || 0) < RECOVERED_SHOWN_MS) return outcome('recovered', { message: previous.message, nextAction: '', keepRecoveredAt: previous.recoveredAt });
    return outcome(c.state, c);
  } catch (err) {
    say('recovery', 'failed', `The recovery stopped: ${err.message}`, 'The Boss retries at the next session start.');
    return outcome('critical', { message: `The memory recovery stopped: ${err.message}`, nextAction: 'The Boss retries at the next session start; the detail is in the notices log.', problems: [] });
  } finally {
    lock.release(held.owner);
  }
}

/** Stop the running server and start it again through its own launcher, with `env`. */
async function defaultRestart({ env }) {
  const R = require('./mcp-daemon-restart.js');
  const registry = JSON.parse(fs.readFileSync(R.registryFile(env.MCP_RUN_DIR), 'utf8'));
  const pid = Number(registry.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('daemon.json has no valid pid');
  const proc = R.inspectWindowsProcess(pid, {});
  if (!/mcp-memory-server/i.test(proc.jarPath || '')) throw new Error(`pid ${pid} is not the memory server; refusing to stop it`);
  process.kill(pid, 'SIGTERM');
  if (!await R.waitPidGone(pid, {})) throw new Error(`the server (pid ${pid}) did not stop`);
  return require('./mcp-bootstrap/launcher.js').runLauncher({ env });
}

module.exports = {
  STATES, OBSOLETE_ENV, DEFAULT_STAGE_MS, windowsUserEnv, neutralizeObsoleteEnv, findLocalModelDir, classifyStack, fetchHealth,
  removeOldJars, replayFileMemories, similarity, readStack, recoverMemoryStack, stateFile,
};
