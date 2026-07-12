'use strict';
/**
 * profile-impact.js — aggregate `stop.dispatch` rows into a per-profile impact
 * summary. Pure (JS-side, like capture-rate/skill-roi).
 *
 * Answers the question the dashboard could not: "how much did each profile
 * bypass?" — honestly:
 *   - `gated`        = detector firings skipped by the profile (observed fact).
 *   - `wouldBlock`   = sampled shadow passes that WOULD have blocked (estimate).
 *   - `avoidedChars` = Stop-message text NOT injected (estimate of size, NOT
 *                      tokens — the UI must label it as such).
 * Never claims tokens/cost. `blocked`/`enforcedChars` are what actually fired.
 */

function num(v) { return Number.isFinite(v) ? v : 0; }
function round(n) { return Math.round(n * 1000) / 1000; }

/**
 * @param {Array<{payload:object, ts?:number}>} events  stop.dispatch rows
 * @returns {{ profiles: Array<object> }}
 */
function aggregateProfileImpact(events) {
  const byProfile = {};
  for (const e of events || []) {
    const p = (e && e.payload) || {};
    const prof = typeof p.profile === 'string' ? p.profile : 'unknown';
    if (!byProfile[prof]) {
      byProfile[prof] = {
        profile: prof, stops: 0, blocked: 0, gated: 0, shadowSamples: 0,
        wouldBlock: 0, enforcedChars: 0, avoidedChars: 0, totalStopMs: 0,
        gatedByDetector: {},
      };
    }
    const b = byProfile[prof];
    b.stops += 1;
    b.blocked += num(p.blocked);
    b.gated += num(p.gated);
    b.shadowSamples += num(p.shadow);
    b.enforcedChars += num(p.enforcedChars);
    b.avoidedChars += num(p.avoidedChars);

    const dets = Array.isArray(p.detectors) ? p.detectors : [];
    let stopMs = 0;
    for (const d of dets) {
      stopMs += num(d && d.ms);
      const s = d && d.s;
      if (s === 'gated' || s === 'shadow_block' || s === 'shadow_quiet') {
        b.gatedByDetector[d.name] = (b.gatedByDetector[d.name] || 0) + 1;
      }
      if (s === 'shadow_block') b.wouldBlock += 1;
    }
    b.totalStopMs += stopMs;
  }

  const profiles = Object.values(byProfile).map((b) => ({
    profile: b.profile,
    stops: b.stops,
    blocked: b.blocked,
    gated: b.gated,
    shadowSamples: b.shadowSamples,
    wouldBlock: b.wouldBlock,
    enforcedChars: b.enforcedChars,
    avoidedChars: b.avoidedChars,
    avgStopMs: b.stops ? round(b.totalStopMs / b.stops) : 0,
    topGated: Object.entries(b.gatedByDetector)
      .map(([name, count]) => ({ name, count }))
      .sort((a, z) => z.count - a.count)
      .slice(0, 8),
  }));
  profiles.sort((a, z) => z.stops - a.stops);
  return { profiles };
}

module.exports = { aggregateProfileImpact };
