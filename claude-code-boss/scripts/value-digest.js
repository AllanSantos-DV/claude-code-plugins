#!/usr/bin/env node
/**
 * value-digest.js — SessionStart: one line a day with what curation did for THIS project
 * in the last 7 days (tokens saved, redirects, runs, raw cost) and its biggest bottleneck.
 *
 * The owner's complaint behind the Phase C metrics: "I can't tell where to invest". The
 * dashboard answers it, but only when opened — this brings the answer to the session.
 * Same numbers as the panel (lib/curation-metrics.summarizeCuration). Deterministic,
 * zero model quota; silent when the window had no curation activity; once per 24h per
 * project (stamp in the plugin data dir).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic-write.js');

const WINDOW_DAYS = 7;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const tok = (chars) => {
  const t = Math.round(chars / 4);
  return t >= 1000 ? `~${(t / 1000).toFixed(1).replace(/\.0$/, '')}k` : `~${t}`;
};

function stampPath(project) {
  const { dataDir } = require('./lib/data-dir.js');
  return path.join(dataDir(), '.runtime', `value-digest-${String(project).replace(/[^\w.-]+/g, '_').slice(0, 80)}.json`);
}

function onCooldown(p, now) {
  try { const t = JSON.parse(fs.readFileSync(p, 'utf8')).ts; return Number.isFinite(t) && now - t < COOLDOWN_MS; }
  catch (err) { if (err.code !== 'ENOENT') console.error(`[value-digest] stamp ${p}: ${err.message}`); return false; }
}

/** Pure: the biggest bottleneck of a summarizeCuration() result, or null. */
function bottleneck(s) {
  const unc = Object.entries(s.uncovered.byScript).sort((a, b) => b[1] - a[1])[0];
  if (unc && unc[1] >= 2) return `variantes do script \`${unc[0]}\` rodando cruas (${unc[1]}x) — estenda o script para cobri-las`;
  if (s.rawEnteredContext.chars > s.totals.savedChars && s.rawEnteredContext.count >= 2) {
    return `saída crua entrando no contexto (${tok(s.rawEnteredContext.chars)} tokens em ${s.rawEnteredContext.count} comandos) supera a economia`;
  }
  const failing = Object.entries(s.runs.byScript).filter(([, r]) => r.runs >= 3 && r.successRate < 0.8).sort((a, b) => a[1].successRate - b[1].successRate)[0];
  if (failing) return `script \`${failing[0]}\` falhando (${Math.round(failing[1].successRate * 100)}% de sucesso em ${failing[1].runs} execuções)`;
  return null;
}

/** Pure: the digest line for a summary, or null when there was no curation activity. */
function formatDigest(s) {
  const activity = s.redirects.total + s.runs.total + s.shaped.cuts + s.rawEnteredContext.count + s.uncovered.total + s.pending;
  if (!activity) return null;
  const parts = [`${tok(s.totals.savedChars)} tokens economizados (moldador ${tok(s.shaped.savedChars)}, redirects ${tok(s.redirectSavings.estChars)} estimados)`,
    `${s.redirects.total} redirects`, `${s.runs.total} execuções de scripts curados`, `custo cru ${tok(s.rawEnteredContext.chars)} tokens`];
  const b = bottleneck(s);
  return `[BOSS] Curadoria nos últimos ${WINDOW_DAYS} dias: ${parts.join(', ')}. Maior gargalo: ${b || 'nenhum claro'}. Detalhes: /dashboard → Curation & guards.`;
}

async function run(event, { now = Date.now() } = {}) {
  const { hookEnv } = require('./lib/hook-context.js');
  const root = hookEnv().CLAUDE_PROJECT_DIR || (event && event.cwd) || '';
  if (!root) return null;
  const project = path.basename(path.resolve(root));
  const sp = stampPath(project);
  if (onCooldown(sp, now)) return null;
  const ms = require('./lib/metrics-store.js');
  const { summarizeCuration, CURATION_EVENTS } = require('./lib/curation-metrics.js');
  const since = now - WINDOW_DAYS * 86400_000;
  const rows = [];
  for (const ev of CURATION_EVENTS) for (const r of ms.getEventLogIsolated(project, { eventName: ev, limit: 500 })) if (r.ts >= since) rows.push(r);
  const text = formatDigest(summarizeCuration(rows));
  if (!text) return null; // nothing to report: stay silent, and don't burn the day's slot
  try { fs.mkdirSync(path.dirname(sp), { recursive: true }); writeJsonAtomic(sp, { ts: now }); }
  catch (err) { console.error(`[value-digest] could not stamp ${sp}: ${err.message}`); }
  return text;
}

module.exports = { run, formatDigest, bottleneck, WINDOW_DAYS };
