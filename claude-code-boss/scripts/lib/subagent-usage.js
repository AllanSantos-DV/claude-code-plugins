'use strict';
/**
 * subagent-usage.js — how big sub-agent contexts get, per agent type, and whether a smaller compaction window
 * would be worth setting. Pure (session records in, numbers out; records come from economy-ledger.sessionRecord).
 *
 * The facts it rests on (Claude Code 2.1.300, measured on this machine's transcripts and read from the docs):
 *   - a sub-agent runs on a 200k window, so the engine compacts it at ~167k (23 compactions seen: 21 at 118–129k —
 *     the old 153k env window — or 167–178k); the boss's own gate only acts on the main session;
 *   - the setting that reaches ONE agent type is `autoCompactWindow` in its frontmatter (100k–1M, Claude Code
 *     2.1.296+); the global env/`/autocompact` would move the main session too, which the owner rejected;
 *   - built-in types (general-purpose, Explore, Plan…) have no file to put it in.
 * So the advice is per agent type, only for a file the user owns, and only when the data shows contexts living above
 * the point where cutting pays: otherwise it says there is nothing to gain — which is today's answer.
 */

const BUILT_IN = Object.freeze(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'claude']);
const MIN_RUNS = 10;            // fewer runs say nothing about a type
const BIG_PEAK = 150000;        // a run that peaks above this spends calls re-reading a large context
const BIG_SHARE = 0.25;         // …and a quarter of the type's runs doing it is a pattern, not an outlier
const SUGGESTED_WINDOW = 150000;

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

/**
 * @param {Array<{agentType?:string, maxContext:number, calls:number, units:number, usd:number, compactions?:number}>} runs  one per sub-agent run
 * @returns {{total:{runs:number, calls:number, units:number}, types:Array<object>}}
 */
function summarizeSubagents(runs) {
  const by = new Map();
  for (const r of runs || []) {
    const t = r.agentType || 'unknown';
    if (!by.has(t)) by.set(t, []);
    by.get(t).push(r);
  }
  const types = [...by.entries()].map(([agentType, rs]) => {
    const peaks = rs.map((r) => r.maxContext);
    const big = rs.filter((r) => r.maxContext > BIG_PEAK);
    const units = rs.reduce((s, r) => s + r.units, 0);
    const builtIn = BUILT_IN.includes(agentType);
    const bigShare = big.length / rs.length;
    let advice;
    if (rs.length < MIN_RUNS) advice = { action: 'none', why: `only ${rs.length} run(s) — fewer than ${MIN_RUNS} say nothing` };
    else if (bigShare < BIG_SHARE) advice = { action: 'none', why: `${(bigShare * 100).toFixed(0)}% of runs peak above ${BIG_PEAK / 1000}k (needs ${BIG_SHARE * 100}%): the engine's own cut at ~167k is enough` };
    else if (builtIn) advice = { action: 'none', why: `${(bigShare * 100).toFixed(0)}% of runs peak above ${BIG_PEAK / 1000}k, but ${agentType} is a built-in type with no file to set autoCompactWindow in` };
    else advice = { action: 'set-autoCompactWindow', window: SUGGESTED_WINDOW, why: `${(bigShare * 100).toFixed(0)}% of ${rs.length} runs peak above ${BIG_PEAK / 1000}k; add autoCompactWindow: ${SUGGESTED_WINDOW} to the ${agentType} agent's frontmatter` };
    return {
      agentType, builtIn, runs: rs.length, calls: rs.reduce((s, r) => s + r.calls, 0), units,
      peak: { p50: q(peaks, 0.5), p90: q(peaks, 0.9), max: Math.max(...peaks) },
      bigRuns: big.length, engineCompactions: rs.reduce((s, r) => s + (r.compactions || 0), 0), advice,
    };
  }).sort((a, b) => b.units - a.units);
  return { total: { runs: (runs || []).length, calls: types.reduce((s, t) => s + t.calls, 0), units: types.reduce((s, t) => s + t.units, 0) }, types };
}

module.exports = { summarizeSubagents, BUILT_IN, MIN_RUNS, BIG_PEAK, BIG_SHARE, SUGGESTED_WINDOW };
