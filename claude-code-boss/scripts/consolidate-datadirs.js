#!/usr/bin/env node
/**
 * consolidate-datadirs.js — guarded, backup-first CONSOLIDATION ENGINE
 * (split-brain KB fix, Phase 2).
 *
 * Phase 1 (lib/data-dir.js) made every writer AGREE on ONE canonical "active"
 * data dir. But a machine that ran older builds already has ORPHAN sibling dirs
 * under ~/.claude/plugins/data/ (claude-code-boss, -inline, -<marketplace>…),
 * each holding a populated `brain/<project>/brain.db`. Phase 1 stops NEW writes
 * from fragmenting; it does not fold the OLD forks back in. This engine does.
 *
 * It enumerates populated `claude-code-boss*` siblings (reusing doctor.js), and:
 *   - local backend  → reconciles each sibling shard INTO the active store
 *     (graft-missing-by-id + reconcile-collisions-by-id, then a near-dup pass
 *     that sums recurrence for independently-captured duplicates);
 *   - mcp-memory     → pushes every sibling entry (and the active folder's OWN
 *     leftover local writes) to the shared daemon, idempotently by documentId;
 *   - then DELETES only the siblings it fully absorbed (zero failures).
 *
 * SAFETY RAILS (this is DESTRUCTIVE — it can delete directories):
 *   1. DRY-RUN by default. `--apply` is required to write/delete anything.
 *   2. BACKUP FIRST. Before any destructive op, every sibling is copied to
 *      ~/.claude/plugins/data/_boss-backup-<ts>/. A failed backup ABORTS the
 *      whole apply LOUD — we never delete without a verified backup.
 *   3. A sibling is deleted ONLY if it absorbed with ZERO failures; any failure
 *      leaves the sibling AND its backup in place (fail-loud).
 *   4. The ACTIVE dir is NEVER deleted.
 *   5. Idempotent: a second run finds no siblings → no-op.
 *   6. NOT wired to run automatically — that is a later phase. Manual CLI only.
 *
 * Single-writer safety: the active brain.db may be open by the live HTTP daemon.
 * brain-store already opens SQLite in WAL with `PRAGMA busy_timeout = 5000`
 * (brain-store.js:192-194), so the consolidation and the daemon SERIALIZE writes
 * instead of throwing SQLITE_BUSY — no change needed there. All active-store
 * WRITES go through the ONE brain-store connection; sibling READS use a throwaway
 * read-only connection (mirrors brain-store.searchIsolated), so we never open a
 * second WRITER handle to the same file.
 *
 *   node scripts/consolidate-datadirs.js            # DRY-RUN: plan, write nothing
 *   node scripts/consolidate-datadirs.js --apply    # backup → absorb → delete
 *   node scripts/consolidate-datadirs.js --json      # machine-readable report
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSqlite } = require('./lib/sqlite-compat.js');

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** An embedding is usable only when it is a non-empty numeric array. */
function validVec(v) {
  return Array.isArray(v) && v.length > 0;
}

/** node:sqlite hands BLOBs back as Uint8Array (offset-safe via slice); mirror
 *  brain-store.blobToVector so a sibling's Float32 vector round-trips exactly. */
function blobToVec(blob) {
  const u8 = blob instanceof Uint8Array ? blob : Uint8Array.from(blob);
  const copy = u8.slice();
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength >> 2));
}

/** Tolerant JSON decode for the TEXT columns (content/source/tags). */
function safeJson(str, fallback) {
  if (str == null) return fallback;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); }
  catch (err) { console.error(`[consolidate-datadirs] JSON parse failed: ${err.message}`); return fallback; }
}

/**
 * Recency key for by-id reconcile. The entries schema has NO `updated_at`
 * column — the freshest write signal is `last_accessed` (bumped on every read/
 * merge), so we use it, falling back to `created_at`. ISO-8601 strings sort
 * lexicographically, so a plain string compare is a correct time compare.
 */
function recencyKey(e) {
  return String((e && (e.last_accessed || e.updated_at || e.created_at)) || '');
}

/** Clamp any recurrence to a positive integer (matches store.setRecurrence). */
function toRecurrence(v) {
  return Math.max(1, Math.floor(Number(v) || 1));
}

/** Order-preserving union of two arrays (tags/keywords), de-duped. */
function unionArrays(a, b) {
  const out = [];
  const seen = new Set();
  for (const arr of [a, b]) {
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const key = typeof x === 'string' ? x : JSON.stringify(x);
      if (!seen.has(key)) { seen.add(key); out.push(x); }
    }
  }
  return out;
}

/** ISO-ish, filename-safe timestamp for the backup dir name. */
function backupStamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

/** Row → entry, mirroring brain-store.rowToEntry (+ the joined embedding). */
function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    session_id: row.session_id,
    title: row.title,
    summary: row.summary,
    content: safeJson(row.content, {}),
    source: safeJson(row.source, {}),
    tags: safeJson(row.tags, []),
    confidence: row.confidence,
    access_count: row.access_count,
    recurrence: row.recurrence != null ? row.recurrence : 1,
    scope: row.scope || 'project',
    last_accessed: row.last_accessed,
    created_at: row.created_at,
    vector: row.vector ? blobToVec(row.vector) : null,
  };
}

// ── Default IO seams (all injectable for tests) ──────────────────────────────

/**
 * Read a sibling/active project shard directly (option (a) from the design):
 * side-effect-free SELECT via a THROWAWAY read-only connection. Preferred over
 * repointing the store singleton because brain-store freezes its STORE_DIR at
 * module load — it cannot be re-pointed at a sibling without reloading the
 * module. Returns [] (never throws) when the file/backend is unavailable.
 */
function readShardDefault(dir, project) {
  const Database = loadSqlite();
  if (!Database) return [];
  const dbPath = path.join(dir, 'brain', project, 'brain.db');
  if (!fs.existsSync(dbPath)) return [];
  let db;
  // readOnly so this is provably NOT a second writer handle to a file the live
  // daemon may hold open for writing (WAL permits one writer + many readers).
  try { db = new Database(dbPath, { readonly: true }); }
  catch (err) { console.error(`[consolidate-datadirs] open ${dbPath}: ${err.message}`); return []; }
  try {
    const rows = db.prepare(`
      SELECT e.id, e.type, e.project, e.session_id, e.title, e.summary, e.content,
             e.source, e.tags, e.confidence, e.access_count, e.recurrence, e.scope,
             e.last_accessed, e.created_at, em.vector
      FROM entries e LEFT JOIN embeddings em ON em.entry_id = e.id
    `).all();
    return rows.map(rowToEntry);
  } catch (err) {
    console.error(`[consolidate-datadirs] read ${dbPath}: ${err.message}`);
    return [];
  } finally {
    try { db.close(); } catch (err) { void err; /* throwaway read handle */ }
  }
}

/** Project shard names under `<dir>/brain/*` that actually carry a brain.db. */
function listProjectsDefault(dir) {
  const brain = path.join(dir, 'brain');
  let names;
  try { names = fs.readdirSync(brain); }
  catch (err) { void err; /* no brain/ here */ return []; }
  return names.filter((p) => {
    try { return fs.existsSync(path.join(brain, p, 'brain.db')); }
    catch (err) { void err; return false; }
  });
}

/** Enumerate populated `claude-code-boss*` candidates (reuse doctor.js). */
function enumerateDefault(activeDir) {
  return require('./doctor.js').findDataDirCandidates(activeDir);
}

function resolveDeps(_deps) {
  const dd = _deps || {};
  return {
    activeDir: dd.activeDir || require('./lib/data-dir.js').dataDir(),
    mode: dd.mode || require('./lib/brain-config.js').getBackendType(),
    store: dd.store || require('./brain-store.js'),
    index: dd.index || require('./brain-index.js'),
    graph: dd.graph || require('./brain-graph.js'),
    backend: dd.backend || require('./brain-backend.js'),
    consolidate: dd.consolidate || require('./brain-consolidate.js').consolidate,
    enumerate: dd.enumerate || enumerateDefault,
    readShard: dd.readShard || readShardDefault,
    listProjects: dd.listProjects || listProjectsDefault,
    fsx: dd.fsx || fs,
    backupBase: dd.backupBase || path.join(os.homedir(), '.claude', 'plugins', 'data'),
    now: dd.now || (() => Date.now()),
  };
}

// ── Core reconcile primitives (local backend) ────────────────────────────────

/** Fresh id → insert it, keeping the search index + graph consistent. */
async function graftEntry(d, project, incoming) {
  const entry = { ...incoming, project };
  const vector = validVec(incoming.vector) ? incoming.vector : undefined;
  delete entry.vector;
  await d.store.save(entry, vector);
  await d.index.index(entry);
  await d.graph.registerNode(entry);
}

/**
 * Colliding id (same lesson captured in both folders) → reconcile BY ID:
 *   - base = the record with the greater recency key (last_accessed→created_at);
 *   - recurrence = MAX (same id = same lesson; do NOT double-count — SUM is only
 *     for near-dup DIFFERENT ids, handled by the brain-consolidate pass);
 *   - tags/keywords = UNION;
 *   - embedding = the base's if valid, else the other's.
 */
async function reconcileEntry(d, project, existing, existingVector, incoming) {
  const incomingWins = recencyKey(incoming) > recencyKey(existing);
  const base = incomingWins ? incoming : existing;
  const baseVector = incomingWins ? incoming.vector : existingVector;
  const otherVector = incomingWins ? existingVector : incoming.vector;

  const reconciled = { ...base, project };
  delete reconciled.vector;
  reconciled.recurrence = Math.max(toRecurrence(existing.recurrence), toRecurrence(incoming.recurrence));
  reconciled.tags = unionArrays(existing.tags, incoming.tags);
  if (existing.keywords || incoming.keywords) {
    reconciled.keywords = unionArrays(existing.keywords, incoming.keywords);
  }
  const vector = validVec(baseVector) ? baseVector : (validVec(otherVector) ? otherVector : undefined);

  await d.store.save(reconciled, vector);
  await d.index.index(reconciled);
  await d.graph.registerNode(reconciled);
}

// ── Per-mode apply ───────────────────────────────────────────────────────────

function newSiblingReport(sibPath) {
  return { path: sibPath, populated: true, projects: 0, grafted: 0, reconciled: 0, pushed: 0, failed: 0, deleted: false };
}

/** Fold one sibling INTO the active local store, project by project. */
async function absorbSiblingLocal(d, sib, s) {
  const projects = d.listProjects(sib.path);
  s.projects = projects.length;
  for (const project of projects) {
    try {
      const incoming = d.readShard(sib.path, project);
      if (!incoming || incoming.length === 0) continue;
      // Scope the ONE store connection to the ACTIVE dir's project shard.
      await d.store.init({ project });
      await d.index.init({ project });
      await d.graph.init({ project });
      const vecMap = new Map();
      for (const r of (d.store.listWithVectors(project) || [])) vecMap.set(r.id, r.vector || null);

      for (const inc of incoming) {
        try {
          const existing = d.store.getRaw(inc.id);
          if (!existing) { await graftEntry(d, project, inc); s.grafted += 1; }
          else { await reconcileEntry(d, project, existing, vecMap.get(inc.id) || null, inc); s.reconciled += 1; }
        } catch (err) {
          console.error(`[consolidate-datadirs] entry ${inc && inc.id} (${sib.path} · ${project}): ${err.message}`);
          s.failed += 1;
        }
      }

      // Independently-captured near-dups (DIFFERENT ids, similar text) collapse
      // and SUM recurrence — the intra-project pass, now over the merged shard.
      try {
        await d.consolidate({ project, apply: true, _store: d.store });
      } catch (err) {
        console.error(`[consolidate-datadirs] near-dup pass (${sib.path} · ${project}): ${err.message}`);
        s.failed += 1;
      }
    } catch (err) {
      console.error(`[consolidate-datadirs] project ${project} (${sib.path}): ${err.message}`);
      s.failed += 1;
    }
  }
}

/** Push every entry of a shard to the mcp-memory daemon (idempotent by id). */
async function pushShardMcp(d, dir, project, counters) {
  await d.backend.init({ project });
  const entries = d.readShard(dir, project);
  for (const e of entries) {
    try { await d.backend.save(e); counters.pushed += 1; }
    catch (err) {
      console.error(`[consolidate-datadirs] mcp push ${e && e.id} (${dir} · ${project}): ${err.message}`);
      counters.failed += 1;
    }
  }
}

/** Push a sibling's shards to the daemon, project by project. */
async function absorbSiblingMcp(d, sib, s) {
  const projects = d.listProjects(sib.path);
  s.projects = projects.length;
  for (const project of projects) {
    try { await pushShardMcp(d, sib.path, project, s); }
    catch (err) {
      console.error(`[consolidate-datadirs] mcp project ${project} (${sib.path}): ${err.message}`);
      s.failed += 1;
    }
  }
}

// ── Delete rail ──────────────────────────────────────────────────────────────

function safeDeleteSibling(d, activeDir, dir) {
  if (path.resolve(dir) === path.resolve(activeDir)) {
    console.error(`[consolidate-datadirs] refusing to delete the ACTIVE dir: ${dir}`);
    return false;
  }
  try { d.fsx.rmSync(dir, { recursive: true, force: true }); return true; }
  catch (err) { console.error(`[consolidate-datadirs] delete failed for ${dir}: ${err.message}`); return false; }
}

// ── Dry-run plan (read-only; writes NOTHING) ─────────────────────────────────

function planSibling(d, activeDir, sib, mode) {
  const s = newSiblingReport(sib.path);
  const projects = d.listProjects(sib.path);
  s.projects = projects.length;
  for (const project of projects) {
    try {
      const incoming = d.readShard(sib.path, project);
      if (!incoming || incoming.length === 0) continue;
      const activeIds = new Set((d.readShard(activeDir, project) || []).map((e) => e.id));
      let miss = 0, coll = 0;
      for (const inc of incoming) { if (activeIds.has(inc.id)) coll += 1; else miss += 1; }
      if (mode === 'mcp-memory') s.pushed += incoming.length; // all pushed idempotently
      else { s.grafted += miss; s.reconciled += coll; }
    } catch (err) {
      console.error(`[consolidate-datadirs] plan ${project} (${sib.path}): ${err.message}`);
      s.failed += 1;
    }
  }
  return s;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * @param {{apply?:boolean, _deps?:object}} [opts]
 * @returns {Promise<{ok:boolean, apply:boolean, mode:string, activeDir:string,
 *   siblings:Array, activeLocal?:object, backupDir?:string, reason?:string}>}
 */
async function consolidate({ apply = false, _deps = {} } = {}) {
  const d = resolveDeps(_deps);
  const { activeDir, mode } = d;
  const report = { ok: true, apply, mode, activeDir, siblings: [] };

  const enumerated = d.enumerate(activeDir) || [];
  const siblings = enumerated.filter(
    (c) => c && c.populated && path.resolve(c.path) !== path.resolve(activeDir),
  );

  // Steady state after a prior successful run: nothing to do (idempotent no-op).
  if (siblings.length === 0) {
    report.reason = 'no-siblings';
    return report;
  }

  // DRY-RUN: compute a graft/reconcile (or push) plan and write NOTHING.
  if (!apply) {
    for (const sib of siblings) report.siblings.push(planSibling(d, activeDir, sib, mode));
    return report;
  }

  // ── APPLY ──
  // (a) BACKUP FIRST — copy every sibling before ANY destructive write/delete.
  const backupDir = path.join(d.backupBase, `_boss-backup-${backupStamp(d.now())}`);
  report.backupDir = backupDir;
  const backedUp = new Map();
  try {
    d.fsx.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    console.error(`[consolidate-datadirs] backup root mkdir failed (${backupDir}): ${err.message}`);
    report.ok = false;
    report.reason = 'backup-failed';
    for (const sib of siblings) report.siblings.push(newSiblingReport(sib.path));
    return report;
  }
  for (const sib of siblings) {
    const dst = path.join(backupDir, path.basename(sib.path));
    try {
      d.fsx.cpSync(sib.path, dst, { recursive: true });
      if (!d.fsx.existsSync(dst)) throw new Error('backup copy missing after cpSync');
      backedUp.set(sib.path, true);
    } catch (err) {
      console.error(`[consolidate-datadirs] backup FAILED for ${sib.path}: ${err.message}`);
      backedUp.set(sib.path, false);
    }
  }
  // Hard gate: never proceed to the DESTRUCTIVE phase without a verified backup
  // for EVERY sibling. Absorb hasn't run yet, so aborting here leaves all state
  // untouched — the safest failure.
  if (!siblings.every((s) => backedUp.get(s.path) === true)) {
    console.error('[consolidate-datadirs] one or more sibling backups failed — aborting BEFORE any absorb/delete');
    report.ok = false;
    report.reason = 'backup-failed';
    for (const sib of siblings) report.siblings.push(newSiblingReport(sib.path));
    return report;
  }

  // (b/c) ABSORB, then (d) DELETE only zero-failure siblings. Fail-open per
  // sibling: an error logs and continues; it never aborts the whole run.
  if (mode === 'mcp-memory') {
    // The split-brain left LOCAL writes in the ACTIVE folder's own brain.db even
    // in mcp mode; push those to the daemon too (the active dir is never deleted).
    report.activeLocal = { projects: 0, pushed: 0, failed: 0 };
    const activeProjects = d.listProjects(activeDir);
    report.activeLocal.projects = activeProjects.length;
    for (const project of activeProjects) {
      try { await pushShardMcp(d, activeDir, project, report.activeLocal); }
      catch (err) {
        console.error(`[consolidate-datadirs] mcp active project ${project}: ${err.message}`);
        report.activeLocal.failed += 1;
      }
    }
  }

  for (const sib of siblings) {
    const s = newSiblingReport(sib.path);
    try {
      if (mode === 'mcp-memory') await absorbSiblingMcp(d, sib, s);
      else await absorbSiblingLocal(d, sib, s);
    } catch (err) {
      console.error(`[consolidate-datadirs] sibling ${sib.path}: ${err.message}`);
      s.failed += 1;
    }
    if (s.failed === 0) {
      s.deleted = safeDeleteSibling(d, activeDir, sib.path);
      if (!s.deleted) s.failed += 1; // a delete that didn't happen is a fail-loud signal
    }
    report.siblings.push(s);
  }
  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function formatReport(r) {
  const lines = ['claude-code-boss — consolidate-datadirs', ''];
  lines.push(`  mode:   ${r.mode}   (${r.apply ? 'APPLY' : 'DRY-RUN'})`);
  lines.push(`  active: ${r.activeDir}`);
  if (r.reason === 'no-siblings') {
    lines.push('');
    lines.push('  No populated sibling data dirs — nothing to consolidate (steady state).');
    return lines.join('\n');
  }
  if (r.backupDir) lines.push(`  backup: ${r.backupDir}`);
  if (r.reason) lines.push(`  reason: ${r.reason}`);
  if (r.activeLocal) {
    lines.push(`  active-local push: ${r.activeLocal.pushed} pushed, ${r.activeLocal.failed} failed (${r.activeLocal.projects} project[s])`);
  }
  lines.push('');
  for (const s of r.siblings) {
    lines.push(`  • ${s.path}`);
    lines.push(r.apply
      ? `      grafted ${s.grafted}, reconciled ${s.reconciled}, pushed ${s.pushed}, failed ${s.failed} → ${s.deleted ? 'DELETED' : 'kept'}`
      : `      would graft ${s.grafted}, would reconcile ${s.reconciled}, would push ${s.pushed}  (${s.projects} project[s])`);
  }
  lines.push('');
  lines.push(r.apply
    ? '  (backup-first; a sibling is deleted only after a zero-failure absorb)'
    : '  DRY-RUN — nothing written. Re-run with --apply to execute.');
  return lines.join('\n');
}

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    const asJson = process.argv.includes('--json');
    let report;
    try {
      report = await consolidate({ apply });
    } catch (err) {
      console.error(`[consolidate-datadirs] fatal: ${err.message}`);
      report = { ok: false, apply, mode: 'unknown', activeDir: '', siblings: [], reason: `fatal: ${err.message}` };
    }
    // Best-effort teardown of any singleton we may have opened.
    try { await require('./brain-store.js').close(); } catch (err) { void err; }
    if (apply) { try { await require('./brain-backend.js').close(); } catch (err) { void err; } }

    if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(formatReport(report) + '\n');

    const anyFailure = report.siblings.some((s) => s.failed > 0)
      || (report.activeLocal && report.activeLocal.failed > 0);
    process.exit(report.ok && !anyFailure ? 0 : 1);
  })();
}

module.exports = {
  consolidate,
  formatReport,
  // Exposed for deterministic unit tests of the pure pieces.
  _test: { validVec, blobToVec, safeJson, recencyKey, toRecurrence, unionArrays, backupStamp, rowToEntry, readShardDefault, listProjectsDefault },
};
