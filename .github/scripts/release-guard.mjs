#!/usr/bin/env node
/**
 * release-guard.mjs — deterministic release-drift detector.
 *
 * Each plugin's in-repo version must have a matching git tag, or the published
 * release channel silently drifts behind main (exactly what happened when main
 * reached claude-code-boss 1.29.0 while the latest release was still v1.23.0).
 * This guard makes that drift LOUD and mechanical — pure Node, zero deps, zero
 * model/quota, like pages-guard. It only compares versions to tags; it never
 * publishes. Cutting the tag (which triggers release.yml) stays a human/agent
 * action so the AGENTS.md smoke gate is preserved.
 *
 * Contract (tag scheme):
 *   - claude-code-boss  version V  → tag `v<V>`      (e.g. v1.29.0)
 *   - rf-reviewer       version V  → tag `rf-v<V>`   (e.g. rf-v0.1.1)
 *
 * Usage:
 *   node .github/scripts/release-guard.mjs check   # exit 1 if any plugin untagged
 *   node .github/scripts/release-guard.mjs list    # json: version + tag + state
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .github/scripts -> repo root

function fail(msg) {
  process.stderr.write(`[release-guard] ${msg}\n`);
  process.exit(2);
}

/** All tags in the repo (once), as a Set for O(1) existence checks. */
function allTags() {
  try {
    const out = execFileSync('git', ['tag', '--list'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    fail(`cannot list git tags: ${err.message}`);
    return new Set();
  }
}

/** Read claude-code-boss version from its package.json. */
function bossVersion() {
  const p = path.join(REPO_ROOT, 'claude-code-boss', 'package.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; }
  catch (err) { fail(`cannot read boss package.json: ${err.message}`); return null; }
}

/** Read rf-reviewer version from rf_engine/__init__.py (__version__ = "x.y.z"). */
function rfVersion() {
  const p = path.join(REPO_ROOT, 'rf-reviewer', 'servers', 'rf-engine', 'rf_engine', '__init__.py');
  try {
    const m = fs.readFileSync(p, 'utf8').match(/__version__\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  } catch (err) { fail(`cannot read rf __init__.py: ${err.message}`); return null; }
}

/** Plugins to guard: [{ name, version, tag }]. */
function plugins() {
  return [
    { name: 'claude-code-boss', version: bossVersion(), tagFor: (v) => `v${v}` },
    { name: 'rf-reviewer', version: rfVersion(), tagFor: (v) => `rf-v${v}` },
  ].map((p) => ({ name: p.name, version: p.version, tag: p.version ? p.tagFor(p.version) : null }));
}

function statusOf(p, tags) {
  if (!p.version) return { ...p, state: 'unknown' };
  return { ...p, state: tags.has(p.tag) ? 'ok' : 'untagged' };
}

function cmdCheck() {
  const tags = allTags();
  const results = plugins().map((p) => statusOf(p, tags));
  const bad = results.filter((r) => r.state !== 'ok');
  if (bad.length === 0) {
    process.stdout.write(`[release-guard] OK - ${results.length} plugin(s) tagged.\n`);
    process.exit(0);
  }
  const lines = bad.map((r) => r.state === 'unknown'
    ? `  - ${r.name}: versão não encontrada no repo`
    : `  - ${r.name}: versão ${r.version} sem a tag ${r.tag}`);
  process.stderr.write(
    `\n[release-guard] RELEASE DRIFT - ${bad.length} plugin(s) na main sem tag publicada:\n` +
    lines.join('\n') +
    `\n\nCorte a release de cada um (mantém o smoke gate do AGENTS.md):\n` +
    `  claude-code-boss → git tag -a v<versão> -m "..." && git push origin v<versão>\n` +
    `  rf-reviewer      → git tag -a rf-v<versão> -m "..." && git push origin rf-v<versão>\n` +
    `O push da tag dispara .github/workflows/release.yml (empacota + publica).\n`,
  );
  process.exit(1);
}

function cmdList() {
  const tags = allTags();
  process.stdout.write(JSON.stringify(plugins().map((p) => statusOf(p, tags)), null, 2) + '\n');
}

const [cmd] = process.argv.slice(2);
switch (cmd || 'check') {
  case 'check': cmdCheck(); break;
  case 'list': cmdList(); break;
  default: fail(`comando desconhecido: ${cmd} (use check|list)`);
}
