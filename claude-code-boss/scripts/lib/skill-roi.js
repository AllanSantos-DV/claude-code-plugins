'use strict';

const WARN_MIN_INVOCATIONS = 10;
const WARN_MAX_SUCCESS_RATE = 0.3;

function aggregateSkillRoi(invocations, outcomes) {
  const byName = new Map();
  const ensure = (n) => {
    if (!byName.has(n)) byName.set(n, { skillName: n, invocations: 0, outcomes_recorded: 0, successes: 0 });
    return byName.get(n);
  };
  for (const ev of invocations || []) {
    const n = ev.payload && ev.payload.skillName;
    if (!n) continue;
    ensure(n).invocations += 1;
  }
  for (const ev of outcomes || []) {
    const n = ev.payload && ev.payload.skillName;
    if (!n) continue;
    const row = ensure(n);
    row.outcomes_recorded += 1;
    if (ev.payload.success === 1 || ev.payload.success === true) row.successes += 1;
  }
  const rows = [...byName.values()].map(r => {
    const success_rate = r.outcomes_recorded > 0 ? r.successes / r.outcomes_recorded : null;
    const warn = r.invocations >= WARN_MIN_INVOCATIONS
      && success_rate !== null
      && success_rate < WARN_MAX_SUCCESS_RATE;
    return { ...r, success_rate, warn };
  });
  rows.sort((a, b) => b.invocations - a.invocations);
  return rows;
}

module.exports = { aggregateSkillRoi, WARN_MIN_INVOCATIONS, WARN_MAX_SUCCESS_RATE };
