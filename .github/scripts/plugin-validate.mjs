#!/usr/bin/env node
/**
 * plugin-validate.mjs — runs Claude Code's own `claude plugin validate --json` on the
 * marketplace and on every plugin it lists, and fails on any error or warning it reports.
 *
 * Warnings fail too: an unknown hook type is only a warning ("entry ignored at runtime"),
 * which is a hook that silently never runs. The one tolerated error is the reserved-name
 * rule on a plugin `name` ("claude-code-boss" starts with "claude-"): renaming the plugin
 * is the owner's decision, pending. A run that yields no JSON fails (a missing or broken
 * CLI is not a pass).
 * No login is needed: the validator reads files only.
 *
 * Usage: node .github/scripts/plugin-validate.mjs [check]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const RESERVED_NAME = /(^|\.)name$/;

/** True for the reserved-name error on a plugin `name` field, the only error tolerated. */
function isTolerated(err) {
  return RESERVED_NAME.test(String(err.path || '')) && /is reserved/.test(String(err.message || ''));
}

/**
 * Classifies one `claude plugin validate --json` result.
 * @param {object|null} result parsed JSON, or null when the CLI produced none
 * @returns {{ok:boolean, failures:string[], tolerated:string[]}}
 */
function classify(result) {
  if (!result || typeof result !== 'object' || !('success' in result)) {
    return { ok: false, failures: ['the validator produced no result'], tolerated: [] };
  }
  const failures = [];
  const tolerated = [];
  const files = [result.manifest, ...(Array.isArray(result.contents) ? result.contents : [])].filter(Boolean);
  const lineOf = (f, e, kind) => `${f.file}: ${kind}: ${e.path ? e.path + ': ' : ''}${e.message}`;
  for (const f of files) {
    for (const e of f.errors || []) (isTolerated(e) ? tolerated : failures).push(lineOf(f, e, 'error'));
    for (const w of f.warnings || []) failures.push(lineOf(f, w, 'warning'));
  }
  if (!result.success && failures.length === 0 && tolerated.length === 0) {
    failures.push('the validator reported failure without naming an error');
  }
  return { ok: failures.length === 0, failures, tolerated };
}

/** Directories to validate: the marketplace root, then each plugin it lists from this repo. */
function targets() {
  const mp = JSON.parse(readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const dirs = ['.'];
  for (const p of mp.plugins || []) {
    const sub = typeof p.source === 'string' ? p.source : p.source && p.source.path;
    if (!sub) throw new Error(`marketplace.json: plugin "${p.name}" has no local path to validate`);
    dirs.push(sub.replace(/^\.\//, ''));
  }
  return dirs;
}

/** Runs the CLI on `dir`; the validator exits 1 on errors, so its stdout is read either way. */
function runValidate(dir) {
  if (!/^[\w./-]+$/.test(dir)) throw new Error(`refusing to validate an unexpected path: ${dir}`);
  let out;
  try {
    // Through a shell: the npm install on Windows is a .cmd shim, which only a shell can start.
    out = execSync(`claude plugin validate "${dir}" --json`, {
      cwd: REPO, encoding: 'utf8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
  } catch (err) {
    if (typeof err.stdout !== 'string' || !err.stdout.trim()) {
      throw new Error(`claude plugin validate ${dir} did not run: ${err.message}${err.stderr ? `\n${err.stderr}` : ''}`);
    }
    out = err.stdout;
  }
  try { return JSON.parse(out); } catch (err) {
    throw new Error(`claude plugin validate ${dir} printed no JSON (${err.message}): ${out.slice(0, 300)}`);
  }
}

function cmdCheck() {
  let bad = 0;
  for (const dir of targets()) {
    const r = classify(runValidate(dir));
    for (const t of r.tolerated) console.log(`  ~ ${dir}: tolerated (owner decision pending): ${t}`);
    for (const f of r.failures) console.error(`  ✗ ${dir}: ${f}`);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${dir}`);
    if (!r.ok) bad++;
  }
  if (bad) { console.error(`plugin-validate: ${bad} target(s) failed`); process.exit(1); }
  console.log('plugin-validate: OK');
}

export { classify, isTolerated, targets };

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [cmd] = process.argv.slice(2);
  if ((cmd || 'check') !== 'check') { console.error(`unknown command: ${cmd} (use check)`); process.exit(2); }
  try { cmdCheck(); } catch (err) { console.error(`plugin-validate: ${err.message}`); process.exit(1); }
}
