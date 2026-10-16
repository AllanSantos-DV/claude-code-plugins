'use strict';
/**
 * promotion-registry.js — what lesson promotion has done, on disk under <dataDir>/promotions/, plus the weekly stamp
 * and the one-shot SessionStart notice. Every function takes the data dir explicitly: a test passes a temp folder and
 * never reaches the real store.
 *
 * registry.json: { version, promotions: [{ id, ts, userEntryId, rule, sources:[{project,entryId,title}], evidence,
 *                  thresholds, status:'active'|'reverted', reason, revertedAt? }], rejected: [{ ts, project, entryId, title, rule, reason }] }
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../engine/lib/atomic-write.js');

const dirOf = (dataDir) => path.join(dataDir, 'promotions');
const registryPath = (dataDir) => path.join(dirOf(dataDir), 'registry.json');
const noticePath = (dataDir) => path.join(dirOf(dataDir), 'notice.json');
const stampPath = (dataDir) => path.join(dataDir, '.runtime', 'lesson-promote-last.json');

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} unreadable: ${err.message}`);
  }
  try { return JSON.parse(raw); } catch (err) { throw new Error(`${file} is not valid JSON (${err.message}) — fix or remove it; promotion will not guess over it`); }
}

function load(dataDir) {
  const r = readJson(registryPath(dataDir), null);
  if (!r) return { version: 1, promotions: [], rejected: [] };
  return { version: 1, promotions: Array.isArray(r.promotions) ? r.promotions : [], rejected: Array.isArray(r.rejected) ? r.rejected : [] };
}

function save(dataDir, registry) {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  writeJsonAtomic(registryPath(dataDir), registry);
}

/** Append one promotion (read-modify-write, atomic file). */
function addPromotion(dataDir, promotion) {
  const r = load(dataDir);
  r.promotions.push(promotion);
  save(dataDir, r);
}

function addRejection(dataDir, rejection) {
  const r = load(dataDir);
  if (!r.rejected.some((x) => x.entryId === rejection.entryId)) r.rejected.push(rejection);
  save(dataDir, r);
}

/** Mark a promotion reverted. @returns {object|null} the updated promotion, null when the id is unknown */
function markReverted(dataDir, id, ts) {
  const r = load(dataDir);
  const p = r.promotions.find((x) => x.id === id);
  if (!p) return null;
  p.status = 'reverted';
  p.revertedAt = ts;
  save(dataDir, r);
  return p;
}

// ── weekly stamp (global, not per project: the promotion reads every project) ──
function promotionDue(dataDir, nowMs, intervalDays) {
  let last;
  try { last = readJson(stampPath(dataDir), {}).ts; } catch (err) { console.error(`[lesson-promote] stamp: ${err.message} — treated as due`); }
  return !(Number.isFinite(last) && nowMs - last < intervalDays * 86400000);
}
function markPromotionRun(dataDir, nowMs) {
  fs.mkdirSync(path.dirname(stampPath(dataDir)), { recursive: true });
  writeJsonAtomic(stampPath(dataDir), { ts: nowMs });
}
/** A failed run gives the interval back (the stamp is written before spawning, so two sessions never start two runs). */
function unmarkPromotionRun(dataDir) {
  try { fs.unlinkSync(stampPath(dataDir)); } catch (err) { if (err.code !== 'ENOENT') console.error(`[lesson-promote] stamp not removed: ${err.message}`); }
}

// ── SessionStart notice ──
function writeNotice(dataDir, ids) {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const prev = (() => { try { return readJson(noticePath(dataDir), { ids: [] }).ids; } catch (err) { console.error(`[lesson-promote] notice: ${err.message}`); return []; } })();
  writeJsonAtomic(noticePath(dataDir), { ts: Date.now(), ids: [...new Set([...prev, ...ids])] });
}

/**
 * The one-line SessionStart notice for what the background run promoted since the last one; reading it consumes it.
 * Ids reverted meanwhile are left out. @returns {string|null}
 */
function takeNotice(dataDir) {
  const file = noticePath(dataDir);
  if (!fs.existsSync(file)) return null;
  let ids;
  try { ids = readJson(file, { ids: [] }).ids || []; } finally { try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') console.error(`[lesson-promote] notice not removed: ${err.message}`); } }
  const live = new Set(load(dataDir).promotions.filter((p) => p.status === 'active').map((p) => p.id));
  ids = ids.filter((i) => live.has(i));
  if (!ids.length) return null;
  const undo = ids.length <= 3 ? `node scripts/lesson-promote.js undo ${ids.join(' ')}` : 'node scripts/lesson-promote.js list';
  return `[BRAIN] ${ids.length} lição(ões) promovida(s) ao escopo do usuário — desfazer: ${undo}`;
}

module.exports = { registryPath, load, save, addPromotion, addRejection, markReverted, promotionDue, markPromotionRun, unmarkPromotionRun, writeNotice, takeNotice };
