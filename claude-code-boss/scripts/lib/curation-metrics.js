'use strict';
/**
 * curation-metrics.js — C4 (Phase C): turn curation/guard events into numbers the
 * owner can act on. Pure (rows in, summary out) → unit-tested; the dashboard feeds it.
 *
 * The old view summed `curation.flagged` chars as "tokens curated away" — those are
 * raw outputs that ENTERED the context (the opposite). Here every number says what it
 * is: exact savings (shaper cuts), estimated savings (redirect: the signature's raw
 * baseline minus the script's average curated output — only where a baseline exists),
 * and the costs/gaps (raw output that entered context, uncovered variants, scripts
 * never used) that tell where to invest next.
 */

const CURATION_EVENTS = [
  'curation.used', 'curation.redirected', 'curation.uncovered', 'curation.skipped', 'curation.pending',
  'curation.bypass', 'curation.shaped', 'curation.flagged', 'curation.piped',
  'error-guard.denied', 'graph-guard.fired',
  // Stop-time curation blocks, the Bash shell-escape fix and Stop detectors that threw.
  'curation.stop.blocked', 'curation.stop.released', 'curation.stop.relented',
  'shell-escape.rewritten', 'shell-escape.warned', 'shell-escape.denied',
  'stop.detector.error',
  // Daily counts that replaced old raw noise rows (metrics-store.compactNoise): same totals.
  'metrics.daily',
];

const { summarizeEconomy, CHARS_PER_TOKEN } = require('./economy-metrics');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bump = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

/**
 * @param {Array<{eventName?:string,event_name?:string,payload?:object|string}>} rows
 * @param {{shellIds?:string[]}} [opts]  ids of the curated scripts that exist (for neverUsed)
 */
function summarizeCuration(rows, { shellIds = [], limitUnitsPerPercent } = {}) {
  const s = {
    redirects: { total: 0, allow: 0, ask: 0, byScript: {} },
    runs: { total: 0, byScript: {} },
    uncovered: { total: 0, byScript: {} },
    skipped: { exploration: 0, inline: 0 },
    pending: 0,
    bypass: 0,
    shaped: { cuts: 0, rawChars: 0, shownChars: 0, savedChars: 0, byFamily: {} },
    redirectSavings: { estChars: 0, withBaseline: 0, withoutBaseline: 0, measured: 0 },
    // EXACT savings: runs whose script reported the raw size it saw (lib/raw-report.js).
    exact: { runs: 0, rawChars: 0, shownChars: 0, savedChars: 0, byScript: {} },
    rawEnteredContext: { count: 0, chars: 0 },
    piped: { total: 0, byScript: {} }, // curated output filtered by the agent → tune that script
    guards: { errorGuardDenied: 0, graphGuardFired: 0 },
    // Stop blocks asking to curate: released = the agent curated/marked, relented = gave up after maxAttempts.
    stopBlocks: { blocked: 0, released: 0, relented: 0 },
    shellEscape: { rewritten: 0, warned: 0, denied: 0 },
    detectorErrors: {}, // Stop detector name → errors
    neverUsed: [],
    totals: { savedChars: 0, savedTokensApprox: 0 },
  };
  const baseline = {}; // sig → {chars, n} from raw noisy runs (flagged / pending)
  const used = {};     // scriptId → {chars, n, ok}
  const redirects = [];
  const cuts = []; // every cut with its time/session: the economy readings need them
  const cutOf = (r, chars) => ({ chars, ts: Number(r.ts), session_id: r.session_id || r.sessionId || null });
  const measured = new Set(); // report ids of runs with an exact raw size: their redirects are not estimated
  for (const r of rows || []) {
    const name = r.eventName || r.event_name;
    let p = r.payload || {};
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (err) { void err; p = {}; } }
    switch (name) {
      case 'curation.redirected':
        s.redirects.total++; bump(s.redirects, p.mode === 'ask' ? 'ask' : 'allow'); bump(s.redirects.byScript, p.shellId || '?');
        redirects.push(p); break;
      case 'curation.used': {
        s.runs.total++;
        const id = p.scriptId || '?';
        const u = used[id] || (used[id] = { chars: 0, n: 0, ok: 0, runs: 0 });
        u.runs++; if (p.success !== false) u.ok++;
        if (Number.isFinite(Number(p.rawChars)) && p.rawChars !== undefined) {
          const raw = num(p.rawChars); const shown = num(p.chars); const saved = Math.max(0, raw - shown);
          s.exact.runs++; s.exact.rawChars += raw; s.exact.shownChars += shown; s.exact.savedChars += saved;
          bump(s.exact.byScript, id, saved);
          cuts.push(cutOf(r, saved));
          for (const rid of [].concat(p.reportIds || [])) measured.add(rid);
        }
        // A compound's output belongs to all its parts: it counts as a run, not as size.
        if (!p.compound) { u.chars += num(p.chars); u.n++; }
        break;
      }
      case 'curation.uncovered':
        for (const id of [].concat(p.shells || [])) { s.uncovered.total++; bump(s.uncovered.byScript, id); }
        break;
      case 'curation.skipped': bump(s.skipped, p.class === 'inline' ? 'inline' : 'exploration'); break;
      case 'metrics.daily':
        if (p.event === 'curation.skipped' && p.byClass) {
          bump(s.skipped, 'inline', num(p.byClass.inline));
          bump(s.skipped, 'exploration', num(p.byClass.exploration));
        } else if (/^shell-escape\.(rewritten|warned|denied)$/.test(p.event || '')) {
          bump(s.shellEscape, p.event.slice('shell-escape.'.length), num(p.count));
        }
        break;
      case 'curation.pending':
        s.pending++;
        if (p.sig) { const b = baseline[p.sig] || (baseline[p.sig] = { chars: 0, n: 0 }); b.chars += num(p.chars); b.n++; }
        break;
      case 'curation.bypass': s.bypass++; break;
      case 'curation.shaped': {
        s.shaped.cuts++;
        const raw = num(p.rawChars); const shown = num(p.shownChars);
        s.shaped.rawChars += raw; s.shaped.shownChars += shown; s.shaped.savedChars += Math.max(0, raw - shown);
        bump(s.shaped.byFamily, p.family || '?');
        cuts.push(cutOf(r, Math.max(0, raw - shown)));
        break;
      }
      case 'curation.flagged':
        s.rawEnteredContext.count++; s.rawEnteredContext.chars += num(p.chars);
        if (p.sig) { const b = baseline[p.sig] || (baseline[p.sig] = { chars: 0, n: 0 }); b.chars += num(p.chars); b.n++; }
        break;
      case 'curation.piped': s.piped.total++; bump(s.piped.byScript, p.shellId || '?'); break;
      case 'error-guard.denied': s.guards.errorGuardDenied++; break;
      case 'graph-guard.fired': s.guards.graphGuardFired++; break;
      case 'curation.stop.blocked': s.stopBlocks.blocked++; break;
      case 'curation.stop.released': s.stopBlocks.released++; break;
      case 'curation.stop.relented': s.stopBlocks.relented++; break;
      case 'shell-escape.rewritten': s.shellEscape.rewritten++; break;
      case 'shell-escape.warned': s.shellEscape.warned++; break;
      case 'shell-escape.denied': s.shellEscape.denied++; break;
      case 'stop.detector.error': bump(s.detectorErrors, p.name || '?'); break;
      default: break;
    }
  }
  for (const [id, u] of Object.entries(used)) {
    s.runs.byScript[id] = { runs: u.runs, avgChars: u.n ? Math.round(u.chars / u.n) : null, successRate: +(u.ok / u.runs).toFixed(2) };
  }
  for (const p of redirects) {
    // Paired by the report id the redirect carried: every part of a compound is covered by its one
    // measured run, and a measured run that was not redirected never cancels another estimate.
    if (p.reportId && measured.has(p.reportId)) { s.redirectSavings.measured++; continue; }
    const b = p.sig && baseline[p.sig];
    const u = used[p.shellId];
    if (b && b.n && u && u.n) {
      s.redirectSavings.withBaseline++;
      s.redirectSavings.estChars += Math.max(0, Math.round(b.chars / b.n - u.chars / u.n));
    } else {
      s.redirectSavings.withoutBaseline++;
    }
  }
  s.neverUsed = shellIds.filter((id) => !used[id] && !s.redirects.byScript[id]);
  s.totals.savedChars = s.shaped.savedChars + s.exact.savedChars + s.redirectSavings.estChars;
  s.totals.savedTokensApprox = Math.round(s.totals.savedChars / CHARS_PER_TOKEN);
  // Redirect savings are per-signature averages without a time/session: always the estimated permanence.
  if (s.redirectSavings.estChars > 0) cuts.push({ chars: s.redirectSavings.estChars, ts: NaN, session_id: null });
  s.economy = summarizeEconomy(cuts, rows, { limitUnitsPerPercent });
  return s;
}

// Read besides CURATION_EVENTS: the economy readings measure permanence and consumption from these.
const ECONOMY_EVENTS = ['cache.turn', 'compaction.run'];

module.exports = { summarizeCuration, CURATION_EVENTS, ECONOMY_EVENTS };
