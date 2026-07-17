#!/usr/bin/env node
/**
 * release-audit.mjs — deterministic PRE-RELEASE audit (mechanical layer).
 *
 * Sibling of release-guard.mjs / pages-guard.mjs: pure Node, zero deps, zero
 * model/quota. It catches the *mechanical* class of pre-release defects — the
 * ones a regex/parse can prove without judgment — so they never ship silently.
 * The reasoning-heavy class (credential/auth, privacy/data-egress, concurrency,
 * TOCTOU) is NOT this file's job: that is the adversarial LLM auditor
 * (.github/agents/release-auditor.agent.md), which is advisory and triaged.
 *
 * Why two layers: a deterministic gate would only ever catch ~3 of a real
 * multi-finding audit (docs drift, a missing default, a stray marker). The rest
 * need reading intent vs code — so we don't pretend a regex can, and we don't
 * hard-block a release on a judged opinion (which can be a false positive).
 *
 * Checks (each exact + low false-positive + maps to a real recurring risk):
 *   1. hooks-doc-drift   — every event declared in hooks/hooks.json must be
 *                          documented in claude-code-boss/README.md (the hook
 *                          table drifted: SubagentStart/UserPromptExpansion/
 *                          PostToolUseFailure were undocumented).
 *   2. changelog-current — CHANGELOG.md must have a top entry for the version in
 *                          package.json (no shipping a version with no notes).
 *   3. no-conflict-marks — no tracked source carries an unresolved merge marker
 *                          (`<<<<<<<` / `>>>>>>>`) — a real risk after manual
 *                          conflict resolution during a stacked release.
 *
 * Usage:
 *   node .github/scripts/release-audit.mjs check   # exit 1 if any check fails
 *   node .github/scripts/release-audit.mjs list    # json: per-check result
 *
 * Extending: add a { name, run } to CHECKS. `run()` returns
 * { ok:boolean, details:string[] } and MUST NOT throw (wrap IO in try/catch and
 * turn failures into a failing check with a helpful detail).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .github/scripts -> repo root
const BOSS = path.join(REPO_ROOT, 'claude-code-boss');

function abort(msg) {
  process.stderr.write(`[release-audit] ${msg}\n`);
  process.exit(2);
}

/** Read a UTF-8 file or return null (never throws). */
function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (err) { void err; return null; }
}

// ── Check 1: hooks declared in hooks.json must be documented in the README ────
function hooksDocumented() {
  const hooksRaw = readOrNull(path.join(BOSS, 'hooks', 'hooks.json'));
  const readme = readOrNull(path.join(BOSS, 'README.md'));
  if (hooksRaw == null) return { ok: false, details: ['cannot read claude-code-boss/hooks/hooks.json'] };
  if (readme == null) return { ok: false, details: ['cannot read claude-code-boss/README.md'] };
  let events;
  try {
    const parsed = JSON.parse(hooksRaw);
    events = Object.keys((parsed && parsed.hooks) || {});
  } catch (err) {
    return { ok: false, details: [`hooks.json is not valid JSON: ${err.message}`] };
  }
  if (events.length === 0) return { ok: false, details: ['hooks.json declares no events (unexpected)'] };
  // Each event name must appear verbatim somewhere in the README (the hook table).
  const missing = events.filter((ev) => !readme.includes(ev));
  if (missing.length === 0) {
    return { ok: true, details: [`${events.length} hook event(s) documented`] };
  }
  return {
    ok: false,
    details: [
      `README.md does not document ${missing.length} hook event(s) declared in hooks.json:`,
      ...missing.map((m) => `    - ${m}`),
      '  Add each to the "Hooks Pipeline" table in claude-code-boss/README.md.',
    ],
  };
}

// ── Check 2: CHANGELOG has a top entry for the package.json version ───────────
function changelogCurrent() {
  const pkgRaw = readOrNull(path.join(BOSS, 'package.json'));
  const changelog = readOrNull(path.join(BOSS, 'CHANGELOG.md'));
  if (pkgRaw == null) return { ok: false, details: ['cannot read claude-code-boss/package.json'] };
  if (changelog == null) return { ok: false, details: ['cannot read claude-code-boss/CHANGELOG.md'] };
  let version;
  try { version = JSON.parse(pkgRaw).version; } catch (err) {
    return { ok: false, details: [`package.json is not valid JSON: ${err.message}`] };
  }
  if (!version) return { ok: false, details: ['package.json has no version'] };
  // Accept "## [X.Y.Z]" or "## X.Y.Z" as the heading form (escape dots).
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s*\\[?${esc}\\]?`, 'm');
  if (re.test(changelog)) return { ok: true, details: [`CHANGELOG has an entry for ${version}`] };
  return {
    ok: false,
    details: [
      `CHANGELOG.md has no top-level entry for version ${version}.`,
      `  Add a "## [${version}] - <date>" section describing this release.`,
    ],
  };
}

// ── Check 3: no unresolved merge conflict markers in tracked source ──────────
function noConflictMarkers() {
  // git grep only tracked files; `^<<<<<<<`/`^>>>>>>>` (7 brackets at line start)
  // are essentially never legitimate. We DON'T match `=======` (7 equals) to
  // avoid false positives from decorative banners / markdown rules.
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-E', '^(<<<<<<<|>>>>>>>)', '--', 'claude-code-boss', '.github', 'rf-reviewer'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const hits = out.split(/\r?\n/).filter(Boolean);
    if (hits.length === 0) return { ok: true, details: ['no conflict markers'] };
    return { ok: false, details: ['unresolved merge conflict marker(s):', ...hits.map((h) => `    ${h}`)] };
  } catch (err) {
    // git grep exits 1 when there are NO matches — that's the success case.
    if (err && err.status === 1) return { ok: true, details: ['no conflict markers'] };
    return { ok: false, details: [`cannot run git grep: ${err && err.message}`] };
  }
}

const CHECKS = [
  { name: 'hooks-doc-drift', run: hooksDocumented },
  { name: 'changelog-current', run: changelogCurrent },
  { name: 'no-conflict-marks', run: noConflictMarkers },
];

function runAll() {
  return CHECKS.map((c) => {
    let res;
    try { res = c.run(); } catch (err) { res = { ok: false, details: [`check threw: ${err && err.message}`] }; }
    return { name: c.name, ok: !!(res && res.ok), details: (res && res.details) || [] };
  });
}

function cmdCheck() {
  const results = runAll();
  for (const r of results) {
    process.stdout.write(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}\n`);
    if (!r.ok) for (const d of r.details) process.stdout.write(`         ${d}\n`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    process.stdout.write(`\n[release-audit] OK - ${results.length} deterministic check(s) passed.\n`);
    process.exit(0);
  }
  process.stderr.write(
    `\n[release-audit] BLOQUEADO - ${failed.length}/${results.length} check(s) mecânico(s) falharam.\n` +
    `Corrija acima e rode de novo. (Guard determinístico - não consome cota de modelo.)\n` +
    `Para os riscos de raciocínio (auth/credencial, privacidade, concorrência), rode o\n` +
    `auditor adversarial: .github/agents/release-auditor.agent.md (consultivo, triado).\n`,
  );
  process.exit(1);
}

function cmdList() {
  process.stdout.write(JSON.stringify(runAll(), null, 2) + '\n');
}

const [cmd] = process.argv.slice(2);
switch (cmd || 'check') {
  case 'check': cmdCheck(); break;
  case 'list': cmdList(); break;
  default: abort(`comando desconhecido: ${cmd} (use check|list)`);
}
