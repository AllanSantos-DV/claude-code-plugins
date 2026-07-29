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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// Janela de acomodação entre o merge e a tag. O fluxo é merge → tag, então nesse
// intervalo a main SEMPRE tem versão sem tag: acusar drift ali é um alarme que
// acende sozinho toda release (aconteceu em v2.19.0, v2.19.1 e v2.20.0 — 3 de 3),
// e alarme que sempre acende ensina a ignorar o alarme.
const GRACE_MS = 45 * 60 * 1000;

/**
 * Classifica UM plugin (PURA — `ageMs` e `graceMs` injetados, sem relógio nem git).
 *
 *   ok       → a tag existe
 *   pending  → sem tag, mas a versão entrou na main há menos que a janela
 *              (release em andamento; o agendado reavalia depois)
 *   untagged → sem tag e já passou da janela → DRIFT REAL, falha alto
 *   unknown  → não foi possível ler a versão no repo
 *
 * Idade INDETERMINADA (`ageMs == null`) não vira desculpa: sem provar que é
 * recente, assume drift — e diz que não conseguiu medir.
 */
function classify(p, tags, ageMs, graceMs) {
  if (!p.version) return { ...p, state: 'unknown' };
  if (tags.has(p.tag)) return { ...p, state: 'ok' };
  if (!Number.isFinite(ageMs)) {
    return { ...p, state: 'untagged', note: 'idade da versão indeterminada (histórico raso?) — assumindo drift' };
  }
  if (ageMs < graceMs) {
    return { ...p, state: 'pending', note: `versão entrou há ${Math.round(ageMs / 60000)}min — release em andamento` };
  }
  return { ...p, state: 'untagged' };
}

/**
 * Há quanto tempo o valor ATUAL da versão entrou no arquivo (ms), via pickaxe do
 * git (`-S`): o commit em que a contagem daquela string mudou. Isso responde "há
 * quanto tempo esta versão está na main", que é o que define drift — e não o
 * timestamp do HEAD, que qualquer push desloca. `null` quando não dá para medir
 * (histórico raso, arquivo novo): o chamador trata como drift, nunca como OK.
 */
function versionAgeMs(relFile, version, nowMs) {
  if (!version) return null;
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', `-S${version}`, '--', relFile],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? nowMs - t : null;
  } catch (err) {
    process.stderr.write(`[release-guard] aviso: não deu p/ datar ${relFile} (${err.message})\n`);
    return null;
  }
}

const VERSION_FILES = {
  'claude-code-boss': 'claude-code-boss/package.json',
  'rf-reviewer': 'rf-reviewer/servers/rf-engine/rf_engine/__init__.py',
};

/** Resultado completo (impuro: lê git). */
function evaluate(nowMs) {
  const tags = allTags();
  return plugins().map((p) => {
    const age = versionAgeMs(VERSION_FILES[p.name], p.version, nowMs);
    return classify(p, tags, age, GRACE_MS);
  });
}

function cmdCheck() {
  const results = evaluate(Date.now());
  for (const r of results.filter((x) => x.state === 'pending')) {
    process.stdout.write(`[release-guard] ${r.name} ${r.version}: ${r.note} — aguardando a tag ${r.tag}.\n`);
  }
  const bad = results.filter((r) => r.state !== 'ok' && r.state !== 'pending');
  if (bad.length === 0) {
    const pend = results.filter((r) => r.state === 'pending').length;
    process.stdout.write(
      `[release-guard] OK - ${results.length} plugin(s) sem drift`
      + (pend ? ` (${pend} em janela de release).\n` : '.\n'),
    );
    process.exit(0);
  }
  const lines = bad.map((r) => r.state === 'unknown'
    ? `  - ${r.name}: versão não encontrada no repo`
    : `  - ${r.name}: versão ${r.version} sem a tag ${r.tag}${r.note ? ` [${r.note}]` : ''}`);
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
  process.stdout.write(JSON.stringify(evaluate(Date.now()), null, 2) + '\n');
}

export { classify, versionAgeMs, evaluate, statusOf, plugins, GRACE_MS, VERSION_FILES };

// CLI só quando executado DIRETAMENTE. Sem esta guarda, um `import` do módulo
// (por um teste, por exemplo) roda o check e chama process.exit, derrubando o
// processo de quem importou.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [cmd] = process.argv.slice(2);
  switch (cmd || 'check') {
    case 'check': cmdCheck(); break;
    case 'list': cmdList(); break;
    default: fail(`comando desconhecido: ${cmd} (use check|list)`);
  }
}
