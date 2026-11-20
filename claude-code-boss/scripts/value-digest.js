#!/usr/bin/env node
/**
 * value-digest.js — SessionStart: one line a day with what curation did for THIS project
 * in the last 7 days (tokens saved, redirects, runs, raw cost) and its biggest bottleneck,
 * plus its compactions and cache hit rate and how well the read-burst bundles matched its reads.
 *
 * The owner's complaint behind the Phase C metrics: "I can't tell where to invest". The
 * dashboard answers it, but only when opened — this brings the answer to the session.
 * Same numbers as the panel (lib/curation-metrics.summarizeCuration). Deterministic,
 * zero model quota; silent when the window had none of the three; once per 24h per
 * project (stamp in the plugin data dir).
 */
'use strict';
const path = require('path');

const WINDOW_DAYS = 7;
const BRIEF_EVENTS = ['compaction.run', 'compaction.settled', 'cache.turn'];
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const { onCooldown: cooldownActive, stamp } = require('./lib/cooldown-stamp.js');
const { CHARS_PER_TOKEN } = require('./lib/economy-metrics.js');
const onCooldown = (p, now) => cooldownActive(p, COOLDOWN_MS, now);
const tok = (chars) => {
  return fmtTokens(chars / CHARS_PER_TOKEN);
};
function fmtTokens(n) {
  const t = Math.round(n);
  return t >= 1000 ? `~${(t / 1000).toFixed(1).replace(/\.0$/, '')}k` : `~${t}`;
}

function stampPath(project) {
  const { dataDir } = require('../engine/lib/data-dir.js');
  return path.join(dataDir(), '.runtime', `value-digest-${String(project).replace(/[^\w.-]+/g, '_').slice(0, 80)}.json`);
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

/** Pure: the compaction and cache sentence, or null when the window had neither. */
function compactionSentence(c) {
  if (!c || (!c.cuts && !c.cacheTurns)) return null;
  const cuts = c.cuts ? `${c.cuts} compactações${c.measured ? ` (${fmtTokens(c.tokensCut)} tokens cortados em ${c.measured} medidas)` : ''}` : 'nenhuma compactação';
  const cache = c.hitPct != null ? `cache com ${String(c.hitPct).replace('.', ',')}% de acerto em ${c.cacheTurns} chamadas` : 'cache sem leitura';
  return `Compactação e cache nos últimos ${WINDOW_DAYS} dias: ${cuts}, ${cache}.`;
}

/** Pure: the read-burst sentence, or null when no bundle was delivered in the window. */
function readBurstSentence(r) {
  if (!r || (!r.delivered && !r.closed)) return null;
  const rate = r.hitRate == null ? 'nenhum arquivo lido depois da entrega ainda'
    : `${r.hits} dos ${r.readAfter} arquivos lidos depois estavam no pacote (${Math.round(r.hitRate * 100)}%)`;
  return `Contexto pronto das rajadas de leitura: ${r.delivered} entregas, ${rate}.`;
}

/** Pure: the curation sentences of a summarizeCuration() result, or null when there was no curation activity. */
function curationSentence(s) {
  const activity = s.redirects.total + s.runs.total + s.shaped.cuts + s.rawEnteredContext.count + s.uncovered.total + s.pending;
  if (!activity) return null;
  const parts = [`${tok(s.totals.savedChars)} tokens economizados (moldador ${tok(s.shaped.savedChars)}, scripts curados ${tok(s.exact.savedChars)} exatos, redirects ${tok(s.redirectSavings.estChars)} estimados)`,
    `${s.redirects.total} redirects`, `${s.runs.total} execuções de scripts curados`, `custo cru ${tok(s.rawEnteredContext.chars)} tokens`];
  const e = s.economy;
  if (e && e.total.cuts) {
    // Real value of the cuts: each kept token would have been re-read every turn until the compaction.
    const usd = e.total.usd > 0 ? `, ~US$ ${e.total.usd.toFixed(2)} na rota API` : '';
    const eta = e.eta != null ? `, ${(e.eta * 100).toFixed(1)}% do gasto evitado` : '';
    parts.push(`com permanência (${e.measured.cuts} medidos, ${e.estimated.cuts} estimados) valem ${fmtTokens(e.total.tokens)} tokens de entrada equivalentes${usd}${eta}`);
  }
  const b = bottleneck(s);
  return `Curadoria nos últimos ${WINDOW_DAYS} dias: ${parts.join(', ')}. Maior gargalo: ${b || 'nenhum claro'}.`;
}

/**
 * Pure: the digest line, or null when the window had nothing to report.
 * @param {object} s  summarizeCuration() result
 * @param {{compaction?: object|null, readBurst?: object|null}} [extra]  compactionCacheBrief() and read-burst summarizeOutcomes() of the window
 */
function formatDigest(s, { compaction = null, readBurst = null } = {}) {
  const sentences = [curationSentence(s), compactionSentence(compaction), readBurstSentence(readBurst)].filter(Boolean);
  if (!sentences.length) return null;
  return `[BOSS] ${sentences.join(' ')} Detalhes: /dashboard → Curation & guards.`;
}

async function run(event, { now = Date.now() } = {}) {
  const { hookEnv } = require('./lib/hook-context.js');
  const root = hookEnv().CLAUDE_PROJECT_DIR || (event && event.cwd) || '';
  if (!root) return null;
  const project = require('../engine/lib/metrics-project.js').metricsKeyFor(root); // the key metrics.js writes under
  const sp = stampPath(project);
  if (onCooldown(sp, now)) return null;
  const ms = require('../engine/lib/metrics-store.js');
  const { summarizeCuration, CURATION_EVENTS, ECONOMY_EVENTS } = require('./lib/curation-metrics.js');
  const since = now - WINDOW_DAYS * 86400_000;
  const rows = [];
  for (const ev of [...CURATION_EVENTS, ...ECONOMY_EVENTS]) for (const r of ms.getEventLogIsolated(project, { eventName: ev, sinceTs: since })) if (r.ts >= since) rows.push(r);
  const compactionRows = [];
  for (const ev of BRIEF_EVENTS) for (const r of ms.getEventLogIsolated(project, { eventName: ev, sinceTs: since })) if (r.ts >= since) compactionRows.push(r);
  const compaction = require('./lib/compaction-metrics.js').compactionCacheBrief(compactionRows);
  // The read-burst journal is one per data dir: this project's share is the sessions its metrics saw.
  const sessions = new Set(rows.concat(compactionRows).map((r) => r.sessionId || r.session_id).filter(Boolean));
  const rb = require('./lib/read-burst.js');
  const readBurst = sessions.size ? rb.summarizeOutcomes(rb.readJournal().entries, { sinceMs: since, sessions }) : null;
  const text = formatDigest(summarizeCuration(rows), { compaction, readBurst });
  if (!text) return null; // nothing to report: stay silent, and don't burn the day's slot
  stamp(sp, now);
  return text;
}

module.exports = { run, formatDigest, compactionSentence, readBurstSentence, bottleneck, WINDOW_DAYS };
