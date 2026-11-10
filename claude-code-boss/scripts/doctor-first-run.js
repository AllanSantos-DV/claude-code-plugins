#!/usr/bin/env node
/**
 * doctor-first-run.js — SessionStart hook: the first session after the plugin is updated (or installed) runs the whole
 * doctor, applies the reversible cost fixes and tells the user what it found and did, once per build.
 *
 * "Once" is an exclusive-create marker file per build key (version + install dir): two sessions starting together race
 * on `wx` and only the winner runs. The marker is written BEFORE the work, so a crash never repeats the audit on
 * every session start; the failure is reported in the notice instead.
 *
 * The audit reads up to 30 days of transcripts and took 17–52 s measured, so it never runs inside SessionStart: the
 * hook claims the marker and starts a hidden detached process (`--audit <key>`), which writes the notice to
 * `.runtime/doctor-first-run-<key>.notice`. The next prompt takes it once (`takeNotice`, UserPromptSubmit).
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

// The history of 30 days can total gigabytes; the transcript, compaction and sub-agent reads share this budget, newest first.
const SCAN_BUDGET_MS = 9000;

// What the user must be told was turned off (the boss's own settings fixes are not "diverted" items).
const TURNED_OFF_LABEL = {
  'plugin-disable': 'plugin disabled',
  'mcp-remove': 'MCP server removed',
  'skill-name-only': 'skill now listed by name only',
};

const { reasonText, userLang } = require('./lib/doctor-reason.js');

function buildKey() {
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version; } catch (err) { console.error(`[doctor-first-run] package.json: ${err.message}`); }
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  return `${version}-${path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function markerPath(key, dir) {
  return path.join(dir || require('../engine/lib/data-dir.js').dataDir(), '.runtime', `doctor-first-run-${key}.done`);
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
function composeNotice({ key, results, fixes, audit, turnedOff = [], lang = userLang(), pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..') }) {
  const L = [`[DOCTOR] First run of build ${key}: full check done.`];
  // Said first and plainly: these were switched off for the user, and why (unused / never authenticated), and how to get each back.
  const off = turnedOff.filter((e) => TURNED_OFF_LABEL[e.kind]);
  if (off.length) {
    L.push(`ATTENTION — ${off.length} item(s) were switched off automatically to cut what every message costs (unused for ${audit && audit.days ? audit.days : 30} days, or never authenticated):`);
    for (const e of off) L.push(`  - ${TURNED_OFF_LABEL[e.kind]}: ${e.target} — ${reasonText(e, lang) || 'no reason recorded'}`);
    L.push('  Need one back? Open the dashboard → Home → "Switched off by the doctor" and press Undo on it (it is never switched off again), or undo everything with `node scripts/doctor.js --undo`. The same card has the switch that stops the doctor from switching things off on its own: the final say is the user\'s.');
    L.push('  INSTRUCTION FOR YOU (the agent): in your first reply, in the user\'s language, tell the user plainly what was switched off and why (the list above), that the doctor acts but the control is theirs (undo one by one, or turn the automatic switch-off off, both in the dashboard), and ASK whether they want to open the dashboard now to see it. If they say yes, run `node "' + path.join(pluginRoot, 'scripts', 'dashboard-open.js') + '"` yourself (do not ask them to type /dashboard) and give them the URL it prints; if it prints ok:false, show the error as it came. If they say no, drop it.');
  }
  if (audit && !audit.error) {
    const t = audit.totals;
    L.push(`Fixed cost per message: ${t.mcpServers} MCP server(s) (${t.mcpUsed} called in ${audit.days}d, ${t.mcpTokens} tok), ${t.skillsTotal} skills (${t.skillsUsed} used, ${t.skillTokens} tok), ${t.pluginsTotal} plugin(s) (${t.pluginsUsed} used), instruction files ${t.instructionTokens} tok. Estimates, ${audit.msgsPerSession} requests per session.`);
  } else if (audit && audit.error) L.push(`Fixed-cost audit failed: ${audit.error}`);
  const ok = fixes.filter((f) => f.ok);
  for (const f of ok) L.push(`Applied (${f.id}): ${f.message}`);
  for (const f of fixes.filter((x) => !x.ok)) L.push(`FIX FAILED (${f.id}): ${f.message}`);
  const fixedIds = new Set(ok.map((f) => f.id));
  const rest = results.filter((r) => r.status !== 'ok' && !r.optional && !fixedIds.has(r.id)); // an optional piece that is simply absent (Smart Tool, rules) is in the full report, not in every session's context
  for (const r of rest) L.push(`${r.status === 'fail' ? 'PROBLEM' : 'Warning'} — ${r.label}: ${r.detail}${r.fix ? ` → ${r.fix}` : ''}`);
  if (ok.length) L.push('Restart Claude Code to load the changes. Undo everything: `node scripts/doctor.js --undo` (in the plugin folder).');
  // Absolute, run from the user's project: the folder checks (memory, code graph) read the folder it runs in.
  L.push('Full report any time: `node "' + path.join(pluginRoot, 'scripts', 'doctor.js') + '" --cost`, run from the project folder.');
  return L.join('\n');
}

/** The whole first-run doctor: checks, the automatic cost fixes, and the notice text. */
async function audit({ key = buildKey(), doctor = require('./doctor.js'), cfg, journal = () => require('./lib/fixed-cost.js').listJournal() } = {}) {
  const c = cfg || require('./lib/hooks-config.js').getFixedCost();
  const startedAt = Date.now();
  const ctx = await doctor.gatherContext({ probe: false, audit: true, scanBudgetMs: SCAN_BUDGET_MS });
  const results = doctor.runChecks(ctx);
  let fixes = [];
  if (c.autoFix) {
    const pick = Object.fromEntries(AUTO_FIXERS.map((k) => [k, doctor.FIXERS[k]]));
    fixes = doctor.applyFixes(results.filter((r) => AUTO_FIXERS.includes(r.autofix)), ctx, pick);
  }
  const turnedOff = c.autoFix ? journal().filter((e) => Date.parse(e.at) >= startedAt) : [];
  return composeNotice({ key, results, fixes, audit: ctx.fixedCost, turnedOff });
}

function runtimeDir(dir) {
  return path.join(dir || require('../engine/lib/data-dir.js').dataDir(), '.runtime');
}

function noticePath(key, dir) {
  return path.join(runtimeDir(dir), `doctor-first-run-${key}.notice`);
}

/** Writes the notice whole (temp + rename), so a prompt never takes half of it. */
function writeNotice(key, text, dir) {
  const file = noticePath(key, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/** Starts the audit in a hidden detached process; its output goes to `.runtime/doctor-first-run.log`. */
function detachAudit(key, { dir, cwd } = {}) {
  const logFile = path.join(runtimeDir(dir), 'doctor-first-run.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  try {
    const child = require('child_process').spawn(process.execPath, [__filename, '--audit', key], {
      cwd: cwd || process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.unref();
  } finally { fs.closeSync(log); }
}

/**
 * SessionStart: claims this build's first run and starts the audit off the hook's path. Returns null (nothing to
 * say yet); the result reaches the next prompt.
 */
async function run(event, { dir, key = buildKey(), cfg, detach = detachAudit } = {}) {
  const c = cfg || require('./lib/hooks-config.js').getFixedCost();
  if (!c.enabled) return null;
  if (!claim(markerPath(key, dir))) return null;
  detach(key, { dir, cwd: event && event.cwd });
  return null;
}

/** The background side: runs the audit and leaves the notice, or the failure, for the next prompt. */
async function auditToNotice(key, { dir, ...opts } = {}) {
  let text;
  try { text = await audit({ key, ...opts }); } catch (err) {
    console.error(`[doctor-first-run] audit failed: ${err && err.stack ? err.stack : err}`);
    text = `[DOCTOR] First run of build ${key} could not finish: ${err && err.message ? err.message : err}. Run \`node "${path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'), 'scripts', 'doctor.js')}" --cost\` from the project folder to see the report.`;
  }
  writeNotice(key, text, dir);
  return text;
}

/**
 * UserPromptSubmit: the first-run notices that are ready, each delivered once. A rename claims each file, so two
 * prompts at the same moment never both show it.
 * @returns {string|null}
 */
function takeNotice({ dir } = {}) {
  const rt = runtimeDir(dir);
  let names;
  try { names = fs.readdirSync(rt); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const texts = [];
  for (const name of names.filter((n) => /^doctor-first-run-.+\.notice$/.test(n))) {
    const taken = path.join(rt, `${name}.taken-${process.pid}`);
    try { fs.renameSync(path.join(rt, name), taken); } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    texts.push(fs.readFileSync(taken, 'utf8'));
    fs.rmSync(taken, { force: true });
  }
  return texts.length ? texts.join('\n\n') : null;
}

function main() { return runTextCli(run, 'DOCTOR-FIRST-RUN', 'SessionStart'); }

if (require.main === module) {
  const i = process.argv.indexOf('--audit');
  // Explicit exit: a handle the doctor leaves open must not keep a hidden process alive after the notice is written.
  if (i >= 0) auditToNotice(process.argv[i + 1]).then(() => process.exit(0), (err) => { console.error(`[doctor-first-run] ${err && err.stack ? err.stack : err}`); process.exit(1); });
  else main();
}

module.exports = { run, audit, auditToNotice, takeNotice, noticePath, buildKey, markerPath, claim, composeNotice, AUTO_FIXERS };
