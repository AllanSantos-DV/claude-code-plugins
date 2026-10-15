#!/usr/bin/env node
/**
 * doctor-first-run.js — SessionStart hook: the first session after the plugin is updated (or installed) runs the whole
 * doctor, applies the reversible cost fixes and tells the user what it found and did, once per build.
 *
 * "Once" is an exclusive-create marker file per build key (version + install dir): two sessions starting together race
 * on `wx` and only the winner runs. The marker is written BEFORE the work, so a crash never repeats the audit on
 * every session start; the failure is reported in the notice instead.
 *
 * Fixes applied here are only the fixed-cost ones (unused/unauthenticated MCP servers, never-used skills → name only,
 * unused plugins, the boss's own settings) and only when `fixedCost.autoFix` is on (default). Each is journaled and
 * undone with `node scripts/doctor.js --undo`. The daemon lock is left to brain-daemon-ensure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { runTextCli } = require('./lib/hook-io.js');

const AUTO_FIXERS = ['fixed-cost', 'boss-config'];

// What the user must be told was turned off (the boss's own settings fixes are not "diverted" items).
const TURNED_OFF_LABEL = {
  'plugin-disable': 'plugin disabled',
  'mcp-remove': 'MCP server removed',
  'skill-name-only': 'skill now listed by name only',
};

function buildKey() {
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version; } catch (err) { console.error(`[doctor-first-run] package.json: ${err.message}`); }
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  return `${version}-${path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function markerPath(key, dir) {
  return path.join(dir || require('./lib/data-dir.js').dataDir(), '.runtime', `doctor-first-run-${key}.done`);
}

/** Claim this build's first run. True for exactly one caller (exclusive create). */
function claim(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, new Date().toISOString(), { flag: 'wx' }); return true; } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/** The notice: what the doctor found, what it changed, how to undo — compact, one build. */
function composeNotice({ key, results, fixes, audit, turnedOff = [] }) {
  const L = [`[DOCTOR] First run of build ${key}: full check done.`];
  // Said first and plainly: these were switched off for the user, and why (unused / never authenticated), and how to get each back.
  const off = turnedOff.filter((e) => TURNED_OFF_LABEL[e.kind]);
  if (off.length) {
    L.push(`ATTENTION — ${off.length} item(s) were switched off automatically to cut what every message costs (unused for ${audit && audit.days ? audit.days : 30} days, or never authenticated):`);
    for (const e of off) L.push(`  - ${TURNED_OFF_LABEL[e.kind]}: ${e.target} — ${e.why || 'no reason recorded'}`);
    L.push('  Need one back? Open the dashboard → Home → "Switched off by the doctor" and press Undo on it (it is never switched off again), or undo everything with `node scripts/doctor.js --undo`.');
  }
  if (audit && !audit.error) {
    const t = audit.totals;
    L.push(`Fixed cost per message: ${t.mcpServers} MCP server(s) (${t.mcpUsed} called in ${audit.days}d, ${t.mcpTokens} tok), ${t.skillsTotal} skills (${t.skillsUsed} used, ${t.skillTokens} tok), ${t.pluginsTotal} plugin(s) (${t.pluginsUsed} used), instruction files ${t.instructionTokens} tok. Estimates, ${audit.msgsPerSession} requests per session.`);
  } else if (audit && audit.error) L.push(`Fixed-cost audit failed: ${audit.error}`);
  const ok = fixes.filter((f) => f.ok);
  for (const f of ok) L.push(`Applied (${f.id}): ${f.message}`);
  for (const f of fixes.filter((x) => !x.ok)) L.push(`FIX FAILED (${f.id}): ${f.message}`);
  const fixedIds = new Set(ok.map((f) => f.id));
  const rest = results.filter((r) => r.status !== 'ok' && !fixedIds.has(r.id));
  for (const r of rest) L.push(`${r.status === 'fail' ? 'PROBLEM' : 'Warning'} — ${r.label}: ${r.detail}${r.fix ? ` → ${r.fix}` : ''}`);
  if (ok.length) L.push('Restart Claude Code to load the changes. Undo everything: `node scripts/doctor.js --undo` (in the plugin folder).');
  L.push('Full report any time: `node scripts/doctor.js --cost`.');
  return L.join('\n');
}

async function run(_event, { dir, key = buildKey(), doctor = require('./doctor.js'), cfg, journal = () => require('./lib/fixed-cost.js').listJournal() } = {}) {
  const c = cfg || require('./lib/hooks-config.js').getFixedCost();
  if (!c.enabled) return null;
  if (!claim(markerPath(key, dir))) return null;
  const startedAt = Date.now();
  const ctx = await doctor.gatherContext({ probe: false, audit: true });
  const results = doctor.runChecks(ctx);
  let fixes = [];
  if (c.autoFix) {
    const pick = Object.fromEntries(AUTO_FIXERS.map((k) => [k, doctor.FIXERS[k]]));
    fixes = doctor.applyFixes(results.filter((r) => AUTO_FIXERS.includes(r.autofix)), ctx, pick);
  }
  const turnedOff = c.autoFix ? journal().filter((e) => Date.parse(e.at) >= startedAt) : [];
  return composeNotice({ key, results, fixes, audit: ctx.fixedCost, turnedOff });
}

function main() { return runTextCli(run, 'DOCTOR-FIRST-RUN', 'SessionStart'); }

if (require.main === module) {
  main();
}

module.exports = { run, buildKey, markerPath, claim, composeNotice, AUTO_FIXERS };
