#!/usr/bin/env node
/**
 * pages-guard.mjs — deterministic freshness gate for the plugin landing pages.
 *
 * Single source of truth for "is each plugin's page up to date?", shared by:
 *   - the local git hooks (.githooks/pre-commit, pre-merge-commit)
 *   - the CI check (.github/workflows/pages-guard.yml)
 * so the block is identical no matter which agent/runtime (Copilot, Claude,
 * Hermes) or human drives the merge. Pure Node, zero deps, zero AI — it never
 * spends model quota; it only compares hashes and, when stale, points at the
 * `vitrine` agent to redraw the page.
 *
 * Contract: for every plugin in `.claude-plugin/marketplace.json`, the page at
 * `pages/<name>/index.html` must exist and carry a `pages/<name>/.source-hash`
 * equal to the hash of that plugin's page SOURCES (README + CHANGELOG +
 * plugin.json). Edit the sources without redrawing the page → hash drifts →
 * merge blocked. The page must also keep the layer rule: no changelog on the
 * presentation (see presentationViolations) → state `layers`, merge blocked.
 *
 * Usage:
 *   node .github/scripts/pages-guard.mjs check          # gate: exit 1 if any stale/missing
 *   node .github/scripts/pages-guard.mjs stamp <name>   # record the current hash (vitrine calls this)
 *   node .github/scripts/pages-guard.mjs hash <name>    # print the current source hash
 *   node .github/scripts/pages-guard.mjs list           # list plugins + status (json)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .github/scripts -> repo root
const MARKETPLACE = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const PAGES_DIR = path.join(REPO_ROOT, 'pages');
const AGENT_REF = '.github/agents/vitrine.agent.md';

// Files (relative to a plugin dir) whose content the page is derived from.
// Order is fixed so the hash is stable. Missing files are simply skipped.
const SOURCE_FILES = ['.claude-plugin/plugin.json', 'README.md', 'CHANGELOG.md'];

function fail(msg) {
  process.stderr.write(`[pages-guard] ${msg}\n`);
  process.exit(2);
}

/** Plugins declared in the marketplace: [{ name, dir(abs) }]. */
function readPlugins() {
  let mk;
  try { mk = JSON.parse(fs.readFileSync(MARKETPLACE, 'utf8')); }
  catch (err) { fail(`cannot read marketplace.json: ${err.message}`); }
  const list = Array.isArray(mk.plugins) ? mk.plugins : [];
  return list.map((p) => {
    const rel = (p.source && p.source.path) || p.name;
    return { name: p.name, dir: path.join(REPO_ROOT, rel) };
  }).filter((p) => p.name);
}

/** sha256 over the plugin's page sources (stable: fixed order, path-tagged). */
function sourceHash(pluginDir) {
  const h = crypto.createHash('sha256');
  for (const rel of SOURCE_FILES) {
    const f = path.join(pluginDir, rel);
    let buf = null;
    try { buf = fs.readFileSync(f); } catch (err) { void err; /* absent -> skip */ }
    if (buf === null) continue;
    // Normalize line endings before hashing so the digest is identical on
    // Windows (CRLF working copy) and Linux/CI (LF) regardless of git's
    // autocrlf. Without this, EOL translation alone would flip the hash and
    // CI would report a page as "stale" even though its sources are unchanged.
    const norm = Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
    // Tag with the path + normalized length so reordering/renaming can't collide.
    h.update(`\u0000${rel}\u0000${norm.length}\u0000`);
    h.update(norm);
  }
  return h.digest('hex');
}

/**
 * Layer rule (Allan, 2026-10-15): the presentation page (`index.html`) is for
 * people meeting the product — value proposition and features only. Version
 * history lives on its own page (`changelog.html` or the GitHub CHANGELOG.md),
 * linked discreetly; architecture lives on the technical page (`tech.html`).
 * The boss page drifted into a wall of "Na 3.1.1, … Na 3.2.0, …" paragraphs
 * under a feature section, so this is checked, not trusted.
 *
 * Returns a list of violations (empty = clean). Allowed on the presentation:
 * the version tag in the brand/nav (`<small>v1.2.3</small>`, `class="ver"`),
 * anything inside <footer>, and links whose href points at the changelog.
 */
export function presentationViolations(html) {
  const out = [];
  if (!/href="[^"]*(changelog\.html|CHANGELOG\.md)[^"]*"/i.test(html)) {
    out.push('sem link para o changelog (changelog.html ou CHANGELOG.md) - o historico precisa de uma pagina propria, linkada no rodape ou menu');
  }
  if (/\b(id|class)="[^"]*\b(changelog|versoes|versions|release-notes)\b[^"]*"/i.test(html)) {
    out.push('bloco de changelog/versoes (id/class) na apresentacao');
  }
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<a\b[^>]*href="[^"]*(changelog\.html|CHANGELOG\.md)[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<a\b[^>]*class="[^"]*\bver\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<small>\s*v?\d+\.\d+\.\d+\s*<\/small>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const semver = text.match(/\bv?\d+\.\d+\.\d+\b/g);
  if (semver) out.push(`numero de versao no texto da apresentacao: ${[...new Set(semver)].slice(0, 5).join(', ')}`);
  const phrase = text.match(/\b(novo na \d|novidades? d[ao] \d|na \d+\.\d+\b|changelog|release notes|what's new)/i);
  if (phrase) out.push(`texto de changelog na apresentacao: "${phrase[0]}"`);
  return out;
}

function stampPath(name) { return path.join(PAGES_DIR, name, '.source-hash'); }
function pagePath(name) { return path.join(PAGES_DIR, name, 'index.html'); }

function readStamp(name) {
  try { return fs.readFileSync(stampPath(name), 'utf8').trim(); }
  catch (err) { void err; return ''; }
}

/** Status for one plugin: { name, state: 'ok'|'missing'|'stale', want, have }. */
function statusOf(p) {
  const want = sourceHash(p.dir);
  const hasPage = fs.existsSync(pagePath(p.name));
  const have = readStamp(p.name);
  let state = 'ok';
  let layers = [];
  if (!hasPage || !have) state = 'missing';
  else if (have !== want) state = 'stale';
  if (hasPage) {
    layers = presentationViolations(fs.readFileSync(pagePath(p.name), 'utf8'));
    if (state === 'ok' && layers.length) state = 'layers';
  }
  return { name: p.name, state, want, have, layers };
}

function cmdCheck() {
  const plugins = readPlugins();
  const results = plugins.map(statusOf);
  const bad = results.filter((r) => r.state !== 'ok');
  if (bad.length === 0) {
    process.stdout.write(`[pages-guard] OK - ${results.length} page(s) up to date.\n`);
    process.exit(0);
  }
  const lines = bad.map((r) => {
    const why = r.state === 'missing'
      ? `pagina ausente (pages/${r.name}/index.html)`
      : r.state === 'stale'
        ? `pagina desatualizada (fontes mudaram)`
        : `apresentacao com changelog (mova para changelog.html): ${r.layers.join('; ')}`;
    const extra = r.state !== 'layers' && r.layers.length ? `\n      e: ${r.layers.join('; ')}` : '';
    return `  - ${r.name}: ${why}${extra}`;
  });
  process.stderr.write(
    `\n[pages-guard] MERGE BLOQUEADO - a pagina de ${bad.length} plugin(s) precisa ser desenhada/atualizada:\n` +
    lines.join('\n') +
    `\n\nRode o agente de vitrine para (re)desenhar a pagina de cada plugin acima:\n` +
    `  -> agente: ${AGENT_REF}\n` +
    `  -> ele atualiza pages/<plugin>/index.html e roda:\n` +
    `      node .github/scripts/pages-guard.mjs stamp <plugin>\n` +
    `Depois refaca o commit/merge. (Guard deterministico - nao consome cota de modelo.)\n`,
  );
  process.exit(1);
}

function cmdStamp(name) {
  if (!name) fail('stamp requer <plugin>');
  const plugins = readPlugins();
  const p = plugins.find((x) => x.name === name);
  if (!p) fail(`plugin desconhecido: ${name}. Disponiveis: ${plugins.map((x) => x.name).join(', ')}`);
  if (!fs.existsSync(pagePath(name))) {
    fail(`pages/${name}/index.html nao existe ainda - desenhe a pagina antes de fazer o stamp`);
  }
  const dir = path.join(PAGES_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stampPath(name), sourceHash(p.dir) + '\n', 'utf8');
  process.stdout.write(`[pages-guard] stamped ${name}\n`);
}

function cmdHash(name) {
  if (!name) fail('hash requer <plugin>');
  const plugins = readPlugins();
  const p = plugins.find((x) => x.name === name);
  if (!p) fail(`plugin desconhecido: ${name}`);
  process.stdout.write(sourceHash(p.dir) + '\n');
}

function cmdList() {
  const plugins = readPlugins();
  process.stdout.write(JSON.stringify(plugins.map(statusOf), null, 2) + '\n');
}

// CLI only when run directly, so tests can import presentationViolations.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd || 'check') {
    case 'check': cmdCheck(); break;
    case 'stamp': cmdStamp(arg); break;
    case 'hash': cmdHash(arg); break;
    case 'list': cmdList(); break;
    default: fail(`comando desconhecido: ${cmd} (use check|stamp|hash|list)`);
  }
}
