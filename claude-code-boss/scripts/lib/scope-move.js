'use strict';
/**
 * scope-move.js — makes a scope reclassification (project <-> user) undoable.
 *
 * A move deletes the original and writes a sanitized copy elsewhere. Before that happens the original is stored
 * whole in the promotion registry (lib/promotion-registry.js) as a record with `kind: 'move'`, so `undoMoves` can
 * put it back and drop the copy. The registry record is `{ id, ts, userEntryId (the copy), rule: 'MOVE', kind: 'move',
 * sources: [{project, entryId, title}], status, reason, move: { fromProject, toProject, toId, original } }`.
 * Vectors are not kept: a move already writes the copy without one, so a restored entry is re-embedded like it.
 */
const crypto = require('crypto');
const registry = require('./promotion-registry.js');

const newMoveId = () => `move-${crypto.randomBytes(4).toString('hex')}`;

/** True for a registry record written by `recordMove`. */
const isMove = (p) => !!p && p.kind === 'move';

/**
 * Record a move BEFORE its destructive steps (a write failure then aborts the move with nothing lost).
 * @param {string} dataDir
 * @param {{original:object, fromProject:string, toProject:string, toId:string, now?:number}} m
 *   original — the full entry as stored (store.getRaw); toId — the id the copy will be saved under
 * @returns {string} the move id, for `undoMoves`
 */
function recordMove(dataDir, { original, fromProject, toProject, toId, now = Date.now() }) {
  if (!original || !original.id) throw new Error('recordMove: the original entry (with its id) is required');
  const id = newMoveId();
  registry.addPromotion(dataDir, {
    id, ts: now, userEntryId: toId, rule: 'MOVE', kind: 'move',
    sources: [{ project: fromProject, entryId: original.id, title: original.title }],
    evidence: {}, thresholds: {}, status: 'active',
    reason: `scope move ${fromProject} -> ${toProject}`,
    move: { fromProject, toProject, toId, original: JSON.parse(JSON.stringify(original)) },
  });
  return id;
}

async function openScope({ store, index, graph }, project) {
  await store.init({ project });
  await index.init({ project });
  await graph.init({ project });
}

/**
 * Undo recorded moves: the original goes back to where it was (unless it is still there), then the copy is deleted.
 * The original is restored first, so a failure never leaves the entry in neither place.
 * @param {{dataDir:string, store:object, index:object, graph:object, now?:()=>number}} deps  store/index/graph are the engine modules
 * @param {string[]|'all'} ids  move ids, or 'all' for every active move
 * @returns {Promise<Array<{id:string, ok:boolean, note?:string, error?:string}>>}
 */
async function undoMoves(deps, ids) {
  const { dataDir } = deps;
  const now = deps.now || Date.now;
  const reg = registry.load(dataDir);
  const targets = ids === 'all' ? reg.promotions.filter((p) => isMove(p) && p.status === 'active').map((p) => p.id) : ids;
  const out = [];
  for (const id of targets) {
    const p = reg.promotions.find((x) => x.id === id);
    if (!isMove(p)) { out.push({ id, ok: false, error: 'unknown move id' }); continue; }
    if (p.status === 'reverted') { out.push({ id, ok: true, note: 'already undone' }); continue; }
    try {
      const { fromProject, toProject, toId, original } = p.move;
      await openScope(deps, fromProject);
      let restored = false;
      if (!deps.store.getRaw(original.id)) {
        const entry = JSON.parse(JSON.stringify(original));
        await deps.store.save(entry);
        await deps.index.index(entry);
        await deps.graph.registerNode(entry);
        restored = true;
      }
      await openScope(deps, toProject);
      const copy = deps.store.getRaw(toId);
      if (copy) {
        await deps.store.delete({ id: toId });
        await deps.index.deindex(toId);
        await deps.graph.unregisterNode(toId);
      }
      registry.markReverted(dataDir, id, now());
      out.push({ id, ok: true, note: `${restored ? 'original restored' : 'original was still in place'}; ${copy ? 'copy deleted' : 'the copy was already gone'}` });
    } catch (err) { out.push({ id, ok: false, error: err.message }); }
  }
  return out;
}

module.exports = { recordMove, undoMoves, isMove };
