#!/usr/bin/env node
/**
 * recall-health.js — makes recall DEGRADATION visible instead of silent.
 *
 * The compose recall path fails OPEN (empty context, prompt still runs) so a bad
 * daemon never breaks a turn — but that means "no memory" can go unnoticed. This
 * tiny counter records every recall outcome to DATA_DIR/.runtime/recall-health.json
 * so brain-health / the dashboard can surface a degraded state (e.g. "compose
 * unavailable — recall has been empty for N turns").
 *
 * Degraded reasons: 'no-compose' (daemon < 2.18 / tool missing), 'remote-error',
 * 'timeout'. The F2 ancestor-spine arm adds 'ancestor-timeout' / 'ancestor-error'
 * (a PARTIAL degradation: compose still returned, only the hierarchical union was
 * skipped) so byReason surfaces it without failing the turn. Everything else (a hit,
 * or an honest 'no-match') counts as ok.
 *
 * JANELA DESLIZANTE (report de campo v2.19.0): os totais eram VITALÍCIOS, sem
 * janela nem decaimento. Um usuário consertou a causa raiz e o alarme continuou
 * gritando "205 de 878 recalls recentes vazios" — as falhas da época em que o MCP
 * estava DOWN ficavam cravadas para sempre, e ele precisaria de centenas de recalls
 * bons só para diluir a taxa. Um alarme que nunca apaga ensina a ignorar o alarme,
 * e aí a próxima degradação REAL passa batida. Agora o veredito sai da janela dos
 * últimos WINDOW_SIZE outcomes; os totais vitalícios ficam para auditoria.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { dataDir } = require('./data-dir.js');
const { writeJsonAtomic } = require('./atomic-write.js');

const DATA_DIR = dataDir();
const FILE = path.join(DATA_DIR, '.runtime', 'recall-health.json');

const DEGRADED_REASONS = new Set(['no-compose', 'remote-error', 'timeout', 'ancestor-timeout', 'ancestor-error']);

// Quantos outcomes recentes decidem o veredito. Grande o bastante para uma
// degradação real não sumir num soluço; pequeno o bastante para o alarme APAGAR
// quando o problema é resolvido de fato.
const WINDOW_SIZE = 50;

/** Whether a retrieve `reason` represents a degraded recall (pure/testable). */
function isDegraded(reason) {
  return DEGRADED_REASONS.has(reason);
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch (err) { void err; return { ok: 0, degraded: 0, byReason: {}, lastDegraded: null, recent: [] }; }
}

/**
 * Aplica UM outcome ao estado (PURA — sem I/O, `now` injetado). Um estado legado
 * (gravado antes da janela existir) é migrado sem perder os totais: a janela nasce
 * vazia a partir de agora, que é justamente o que permite o alarme se apagar.
 * @returns {object} novo estado
 */
function applyOutcome(state, reason, now) {
  const h = state || {};
  const degraded = isDegraded(reason);
  const recent = Array.isArray(h.recent) ? h.recent.slice() : [];
  recent.push(degraded ? { ok: false, reason, ts: now } : { ok: true, ts: now });
  // Descarta o excedente pela FRENTE: a janela guarda sempre os mais recentes.
  if (recent.length > WINDOW_SIZE) recent.splice(0, recent.length - WINDOW_SIZE);

  return {
    ...h,
    ok: (h.ok || 0) + (degraded ? 0 : 1),
    degraded: (h.degraded || 0) + (degraded ? 1 : 0),
    byReason: degraded
      ? { ...(h.byReason || {}), [reason]: ((h.byReason || {})[reason] || 0) + 1 }
      : { ...(h.byReason || {}) },
    lastDegraded: degraded ? { reason, ts: now } : (h.lastDegraded || null),
    recent,
  };
}

/**
 * Veredito a partir do estado (PURA). `degradedRate` mede a JANELA — é o que decide
 * o alarme. Os totais vitalícios continuam expostos (`lifetime*`) para auditoria,
 * mas não mandam mais no veredito.
 */
function summarize(state) {
  const h = state || {};
  const recent = Array.isArray(h.recent) ? h.recent : [];
  const windowDegraded = recent.filter((e) => e && e.ok === false).length;
  const windowTotal = recent.length;
  return {
    ok: h.ok || 0,
    degraded: h.degraded || 0,
    lifetimeOk: h.ok || 0,
    lifetimeDegraded: h.degraded || 0,
    windowTotal,
    windowDegraded,
    total: windowTotal,
    degradedRate: windowTotal ? windowDegraded / windowTotal : 0,
    byReason: h.byReason || {},
    lastDegraded: h.lastDegraded || null,
  };
}

/** Record one recall outcome. Returns the updated snapshot. */
function record(reason) {
  const h = applyOutcome(read(), reason, Date.now());
  // Best-effort, last-writer-wins (tear-free publish, no cross-process lock).
  try {
    writeJsonAtomic(FILE, h);
  } catch (err) {
    console.error(`[recall-health] write failed: ${err.message}`);
  }
  return h;
}

/** Current snapshot for health/dashboard surfacing. */
function getStatus() {
  return summarize(read());
}

module.exports = { record, getStatus, isDegraded, applyOutcome, summarize, WINDOW_SIZE, FILE };
