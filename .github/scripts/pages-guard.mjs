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
 * merge blocked.
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
import { fileURLToPath } from 'node:url';

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
  if (!hasPage || !have) state = 'missing';
  else if (have !== want) state = 'stale';
  return { name: p.name, state, want, have };
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
      : `pagina desatualizada (fontes mudaram)`;
    return `  - ${r.name}: ${why}`;
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

const [cmd, arg] = process.argv.slice(2);
switch (cmd || 'check') {
  case 'check': cmdCheck(); break;
  case 'stamp': cmdStamp(arg); break;
  case 'hash': cmdHash(arg); break;
  case 'list': cmdList(); break;
  default: fail(`comando desconhecido: ${cmd} (use check|stamp|hash|list)`);
}
