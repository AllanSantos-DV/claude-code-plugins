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
 *   - a tagged version whose plugin code changed after the tag is drift too: the version is
 *     pinned in plugin.json, so Claude Code never delivers that code until the version moves.
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
 * Does a change to this repo path need a release to reach users? (PURE) Docs, notes and
 * tests don't change what the installed plugin does; everything else under the plugin does.
 * @param {string} relPath  repo-relative, forward slashes
 * @returns {boolean}
 */
function shipsBehavior(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  // Notes only. A skill/agent/command .md IS behavior (the agent loads it) — not excluded.
  if (/(^|\/)(README|CHANGELOG|LICENSE|SECURITY|CONTRIBUTING)(\.md)?$/i.test(p)) return false;
  if (/(^|\/)(docs|tests?|__tests__|smoke)\//.test(p)) return false;
  if (/(^|\/)scripts\/test-[^/]+\.js$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p)) return false;
  return true;
}

const PLUGIN_DIRS = { 'claude-code-boss': 'claude-code-boss', 'rf-reviewer': 'rf-reviewer' };

/** Files of the plugin's directory that differ between its release tag and HEAD (impure). */
function changedSinceTag(name, tag) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', tag, 'HEAD', '--', PLUGIN_DIRS[name]], { cwd: REPO_ROOT, encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    fail(`cannot diff ${name} against ${tag}: ${err.message}`);
    return [];
  }
}

/**
 * Classifica UM plugin (PURA — `ageMs` e `graceMs` injetados, sem relógio nem git).
 *
 *   ok         → a tag existe e nada que muda o comportamento mudou depois dela
 *   unreleased → a tag existe, mas código do plugin mudou depois dela sem subir a versão
 *                (`changedSinceTag`: arquivos do plugin entre a tag e o HEAD)
 *   pending → sem tag, mas a versão entrou na main há menos que a janela
 *              (release em andamento; o agendado reavalia depois)
 *   untagged → sem tag e já passou da janela → DRIFT REAL, falha alto
 *   unknown  → não foi possível ler a versão no repo
 *
 * Idade INDETERMINADA (`ageMs == null`) não vira desculpa: sem provar que é
 * recente, assume drift — e diz que não conseguiu medir.
 */
function classify(p, tags, ageMs, graceMs, changedSinceTag = []) {
  if (!p.version) return { ...p, state: 'unknown' };
  if (tags.has(p.tag)) {
    // The plugin PINS its version (plugin.json): Claude Code updates a user only when that
    // string changes. Code changed after the tag under the same version never reaches anyone.
    const code = changedSinceTag.filter(shipsBehavior);
    return code.length ? { ...p, state: 'unreleased', files: code } : { ...p, state: 'ok' };
  }
  if (!Number.isFinite(ageMs)) {
    return { ...p, state: 'untagged', note: 'idade da versão indeterminada (histórico raso?) — assumindo drift' };
  }
  if (ageMs < graceMs) {
    return { ...p, state: 'pending', note: `versão entrou há ${Math.round(ageMs / 60000)}min — release em andamento` };
  }
  return { ...p, state: 'untagged' };
}

/**
 * O commit em que o valor ATUAL da versão entrou no arquivo, via pickaxe do git
 * (`-S`): { sha, ms } (ms = data do commit) ou null (histórico raso, arquivo novo).
 */
function bumpCommit(relFile, version) {
  if (!version) return null;
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%H %cI', `-S${version}`, '--', relFile],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    const [sha, date] = out.split(' ');
    const ms = Date.parse(date);
    return sha && Number.isFinite(ms) ? { sha, ms } : null;
  } catch (err) {
    process.stderr.write(`[release-guard] aviso: não deu p/ datar ${relFile} (${err.message})\n`);
    return null;
  }
}

/**
 * `a` é ancestral de `b`? (git merge-base --is-ancestor). Commit inexistente neste clone
 * conta como "não" — ver abaixo. Outro erro do git propaga.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isAncestor(a, b) {
  if (!b || /^0+$/.test(b)) return false; // criação do branch: nada antes
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err.status === 1) return false; // não é ancestral
    // 128 = commit que não existe neste clone: a atividade da main ainda lista pushes de
    // um histórico reescrito (ex.: 5fd0028, de nenhum branch). Um commit fora do histórico
    // não contém o bump — não é ancestral. Derrubar o guard por isso deixava o cron
    // vermelho a cada 6 h sem drift nenhum.
    if (err.status === 128) {
      process.stderr.write(`[release-guard] aviso: commit fora do histórico (${a} → ${b}) — tratado como não-ancestral\n`);
      return false;
    }
    throw new Error(`git merge-base ${a} ${b}: ${err.message}`);
  }
}

/**
 * Quando o commit do bump CHEGOU na main (PURA — `pushes` e `isAnc` injetados): o
 * push cujo `after` contém o commit e cujo `before` não. O fluxo develop → main é
 * fast-forward, então a data do commit é a de quando foi escrito (horas antes do
 * push) e a janela já tinha passado no push do release (visto na 3.0.0). null
 * quando nenhum push da lista o trouxe.
 */
function pushArrival(bumpSha, pushes, isAnc) {
  for (const p of pushes || []) {
    if (isAnc(bumpSha, p.after) && !isAnc(bumpSha, p.before)) {
      const t = Date.parse(p.timestamp);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/**
 * Pushes recentes na main (API de atividade do GitHub; o CI passa GITHUB_TOKEN e
 * GITHUB_REPOSITORY). null sem token (uso local) ou em erro — dito no stderr; o
 * chamador então data pelo commit, que só pode acusar drift CEDO, nunca esconder.
 */
async function fetchMainPushes() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/activity?ref=refs/heads/main&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    return list.filter((a) => a && a.after && a.timestamp && a.activity_type !== 'branch_deletion');
  } catch (err) {
    process.stderr.write(`[release-guard] aviso: atividade da main indisponível (${err.message}) — datando pelo commit do bump\n`);
    return null;
  }
}

/**
 * Há quanto tempo a versão ATUAL está na main: { ageMs, note? }. Pela chegada do
 * bump na main quando os pushes são conhecidos; senão pela data do commit (dito na
 * nota). ageMs null quando não dá para medir — o chamador trata como drift.
 */
function versionAge(relFile, version, nowMs, pushes, isAnc = isAncestor) {
  const bump = bumpCommit(relFile, version);
  if (!bump) return { ageMs: null };
  if (pushes) {
    const t = pushArrival(bump.sha, pushes, isAnc);
    if (t != null) return { ageMs: nowMs - t };
    return { ageMs: nowMs - bump.ms, note: 'push de chegada fora da atividade listada — datado pelo commit do bump' };
  }
  return { ageMs: nowMs - bump.ms, note: 'sem atividade da main (GITHUB_TOKEN) — datado pelo commit do bump' };
}

const VERSION_FILES = {
  'claude-code-boss': 'claude-code-boss/package.json',
  'rf-reviewer': 'rf-reviewer/servers/rf-engine/rf_engine/__init__.py',
};

/** Resultado completo (impuro: lê git e a atividade da main). */
async function evaluate(nowMs) {
  const tags = allTags();
  const pushes = await fetchMainPushes();
  return plugins().map((p) => {
    const { ageMs, note } = versionAge(VERSION_FILES[p.name], p.version, nowMs, pushes);
    const changed = p.version && tags.has(p.tag) ? changedSinceTag(p.name, p.tag) : [];
    const r = classify(p, tags, ageMs, GRACE_MS, changed);
    return note && r.state !== 'ok' ? { ...r, note: r.note ? `${r.note}; ${note}` : note } : r;
  });
}

/** CLI `check`: prints the per-plugin verdict; exits 1 on drift (untagged / unreleased / unknown). */
async function cmdCheck() {
  const results = await evaluate(Date.now());
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
  const lines = bad.map((r) => {
    if (r.state === 'unknown') return `  - ${r.name}: versão não encontrada no repo`;
    if (r.state === 'unreleased') {
      return `  - ${r.name}: código mudou depois da tag ${r.tag} SEM subir a versão — quem está na ${r.version} nunca recebe `
        + `(o Claude Code só atualiza quando a versão do plugin.json muda): ${r.files.slice(0, 5).join(', ')}${r.files.length > 5 ? ` … +${r.files.length - 5}` : ''}`;
    }
    return `  - ${r.name}: versão ${r.version} sem a tag ${r.tag}${r.note ? ` [${r.note}]` : ''}`;
  });
  process.stderr.write(
    `\n[release-guard] RELEASE DRIFT - ${bad.length} plugin(s) com a main fora da release publicada:\n` +
    lines.join('\n') +
    `\n\nCorte a release de cada um (mantém o smoke gate do AGENTS.md):\n` +
    `  claude-code-boss → git tag -a v<versão> -m "..." && git push origin v<versão>\n` +
    `  rf-reviewer      → git tag -a rf-v<versão> -m "..." && git push origin rf-v<versão>\n` +
    `O push da tag dispara .github/workflows/release.yml (empacota + publica).\n`,
  );
  process.exit(1);
}

async function cmdList() {
  process.stdout.write(JSON.stringify(await evaluate(Date.now()), null, 2) + '\n');
}

export { classify, shipsBehavior, pushArrival, versionAge, evaluate, statusOf, plugins, isAncestor, GRACE_MS, VERSION_FILES };

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
