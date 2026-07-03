#!/usr/bin/env node
/**
 * failure-retro.js — Stop hook. Aggregates failures captured by
 * failure-detect.js this session and, if a loop pattern is detected,
 * blocks the Stop with a short retrospective prompt.
 *
 * Triggers (configurable):
 *   - REPEATED: same normalized {tool, cmd, exitCode} failed ≥ minFailures
 *     times within timeWindowMin.
 *   - CONSECUTIVE: ≥ consecutiveThreshold failures (any) in a row at the tail
 *     of the journal.
 *
 * Cooldown: per-(session, key) — never nudge same signature twice.
 *
 * Coexistence with curation-stop: if turn-journal has pending curation
 * entries, defer — curation block takes priority. Retro will fire on the
 * next Stop once curation is cleared, if the failures are still in window.
 *
 * Pure functions exported for unit tests.
 */
'use strict';

const { runStopDetectorCli } = require('./lib/hook-io.js');
const failureJournal = require('./lib/failure-journal.js');
const cooldown = require('./lib/cooldown-store.js');
const turnJournal = require('./lib/turn-journal.js');
const hooksCfg = require('./lib/hooks-config.js');
const metrics = require('./lib/metrics.js');

function loadConfig() {
  const cfg = hooksCfg.load();
  const fr = cfg.failureRetro || {};
  return {
    enabled: fr.enabled !== false,
    minFailures: Number.isFinite(fr.minFailures) ? fr.minFailures : 2,
    timeWindowMin: Number.isFinite(fr.timeWindowMin) ? fr.timeWindowMin : 10,
    consecutiveThreshold: Number.isFinite(fr.consecutiveThreshold) ? fr.consecutiveThreshold : 3,
  };
}

function repeatedKey(entry) {
  return `repeated::${entry.tool}::${entry.cmd}::${entry.exitCode == null ? '?' : entry.exitCode}`;
}

function consecutiveKey() {
  return 'consecutive::tail';
}

function evaluateTriggers(entries, cfg, now = Date.now()) {
  const recent = entries.filter(e => Number.isFinite(e.ts) && (now - e.ts) <= cfg.timeWindowMin * 60 * 1000);
  if (!recent.length) return [];

  const triggers = [];

  const byKey = new Map();
  for (const e of recent) {
    const k = repeatedKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  for (const [key, group] of byKey.entries()) {
    if (group.length >= cfg.minFailures) {
      triggers.push({ kind: 'repeated', key, group });
    }
  }

  if (recent.length >= cfg.consecutiveThreshold) {
    triggers.push({ kind: 'consecutive', key: consecutiveKey(), group: recent.slice(-cfg.consecutiveThreshold) });
  }

  return triggers;
}

function summarizeGroup(group) {
  if (!group?.length) return '';
  const first = group[0];
  const last = group[group.length - 1];
  const spanMin = Math.max(1, Math.round((last.ts - first.ts) / 60000));
  const exit = first.exitCode == null ? '?' : first.exitCode;
  return `${group.length}× exit ${exit} in ${spanMin}min`;
}

function buildRetroPrompt(triggers) {
  const lines = ['## 🔁 Failure pattern detected', ''];
  for (const t of triggers) {
    if (t.kind === 'repeated') {
      const sample = t.group[0];
      const target = sample.cmd ? `\`${sample.cmd}\`` : `${sample.tool}`;
      lines.push(`- ${sample.tool} ${target} failed ${summarizeGroup(t.group)}`);
    } else if (t.kind === 'consecutive') {
      const sigs = [...new Set(t.group.map(e => `${e.tool}:${(e.cmd || '').slice(0, 40)}`))].join(' → ');
      lines.push(`- ${t.group.length} consecutive failures: ${sigs}`);
    }
  }
  lines.push('');
  lines.push('Before retrying, pause and reflect ≤4 lines:');
  lines.push('1. **Root cause hypothesis:** one sentence — what is actually broken?');
  lines.push('2. **What changed since last green:** if known.');
  lines.push('3. **Capture lesson?** If this is a recurring CLASS of error (not a typo), call `capture_lesson({type:"lesson", title, summary, detail, tags})` once.');
  lines.push('4. **Next concrete step:** ONE action, not "investigate".');
  return lines.join('\n');
}

async function run(event) {
  const cfg = loadConfig();
  if (!cfg.enabled) return {};

  const ev = event || {};
  const sid = ev.session_id || ev.sessionId || 'default';

  if (turnJournal.readEntries(sid).length > 0) return {};

  const entries = failureJournal.readEntries(sid);
  if (!entries.length) return {};

  const triggers = evaluateTriggers(entries, cfg);
  const fresh = triggers.filter(t => !cooldown.has(sid, t.key));
  if (!fresh.length) return {};

  for (const t of fresh) cooldown.add(sid, t.key);
  for (const t of fresh) {
    metrics.fire('nudge.emitted', { kind: 'failure', trigger: t.kind, count: t.group?.length || 0 },
      { sessionId: sid, cwd: ev.cwd });
  }
  return { block: true, reason: buildRetroPrompt(fresh) };
}

if (require.main === module) {
  runStopDetectorCli(run, 'failure-retro');
}

module.exports = { run, evaluateTriggers, buildRetroPrompt, repeatedKey, consecutiveKey, summarizeGroup, loadConfig };
