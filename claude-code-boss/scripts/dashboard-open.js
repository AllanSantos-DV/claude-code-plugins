#!/usr/bin/env node
/**
 * dashboard-open.js — bring the dashboard up (idempotent) and open it in the user's default browser on the Home tab.
 *
 * What the agent runs when the user says "yes, open it" after the doctor's notice: the same result as the user typing
 * `/dashboard`, without the slash command. Prints one JSON line: {"ok":true,"url":…,"status":…,"opened":…} or
 * {"ok":false,"error":…} (exit 1) — never a silent failure.
 */
'use strict';

/**
 * @param {{ensure?:Function, open?:Function}} [deps] test seams
 * @returns {Promise<{ok:boolean, url?:string, status?:string, opened?:boolean, error?:string}>}
 */
async function run(deps = {}) {
  const ensure = deps.ensure || require('./dashboard-start.js').ensureDashboard;
  const open = deps.open || require('./dashboard-command.js').openBrowser;
  const r = await ensure();
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'the dashboard did not start (unknown error)' };
  const url = `${String(r.url).replace(/\/+$/, '')}/#home`;
  return { ok: true, url, status: r.status, opened: open(url) === true };
}

if (require.main === module) {
  run().then((out) => {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (!out.ok) process.exitCode = 1;
  }).catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
