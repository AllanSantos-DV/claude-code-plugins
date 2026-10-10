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
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bump = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

/**
 * @param {Array<{eventName?:string,event_name?:string,payload?:object|string}>} rows
 * @param {{shellIds?:string[]}} [opts]  ids of the curated scripts that exist (for neverUsed)
 */
function summarizeCuration(rows, { shellIds = [] } = {}) {
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
    neverUsed: [],
    totals: { savedChars: 0, savedTokensApprox: 0 },
  };
  const baseline = {}; // sig → {chars, n} from raw noisy runs (flagged / pending)
  const used = {};     // scriptId → {chars, n, ok}
  const redirects = [];
  const measured = {}; // scriptId → runs with an exact raw size (their redirects are not estimated)
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
          measured[id] = (measured[id] || 0) + 1;
        }
        // A compound's output belongs to all its parts: it counts as a run, not as size.
        if (!p.compound) { u.chars += num(p.chars); u.n++; }
        break;
      }
      case 'curation.uncovered':
        for (const id of [].concat(p.shells || [])) { s.uncovered.total++; bump(s.uncovered.byScript, id); }
        break;
      case 'curation.skipped': bump(s.skipped, p.class === 'inline' ? 'inline' : 'exploration'); break;
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
        break;
      }
      case 'curation.flagged':
        s.rawEnteredContext.count++; s.rawEnteredContext.chars += num(p.chars);
        if (p.sig) { const b = baseline[p.sig] || (baseline[p.sig] = { chars: 0, n: 0 }); b.chars += num(p.chars); b.n++; }
        break;
      case 'curation.piped': s.piped.total++; bump(s.piped.byScript, p.shellId || '?'); break;
      case 'error-guard.denied': s.guards.errorGuardDenied++; break;
      case 'graph-guard.fired': s.guards.graphGuardFired++; break;
      default: break;
    }
  }
  for (const [id, u] of Object.entries(used)) {
    s.runs.byScript[id] = { runs: u.runs, avgChars: u.n ? Math.round(u.chars / u.n) : null, successRate: +(u.ok / u.runs).toFixed(2) };
  }
  for (const p of redirects) {
    if (measured[p.shellId] > 0) { measured[p.shellId]--; s.redirectSavings.measured++; continue; } // already exact
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
  s.totals.savedTokensApprox = Math.round(s.totals.savedChars / 4);
  return s;
}

module.exports = { summarizeCuration, CURATION_EVENTS };
