#!/usr/bin/env node
/**
 * version-stamp.mjs — carimba a versão de cada plugin (do seu plugin.json) nas
 * landing pages, de forma DETERMINÍSTICA (sem AI, sem cota). A versão exibida
 * NUNCA é hardcoded na mão: vem sempre de <plugin>/.claude-plugin/plugin.json.
 *
 *   node .github/scripts/version-stamp.mjs stamp   # escreve a versão nas pages
 *   node .github/scripts/version-stamp.mjs check   # exit 1 se alguma page divergiu
 *
 * Carimba: os tiles de pages/index.html (home) e o título/meta/pill de
 * pages/<plugin>/index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Gerencia só o rf-reviewer (o boss tem esquema de versão próprio/ambíguo — fora de escopo).
const PLUGINS = ['rf-reviewer'];

function versionOf(plugin) {
  const pjPath = path.join(ROOT, plugin, '.claude-plugin', 'plugin.json');
  try {
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    if (pj.version) return pj.version;
  } catch { /* noop */ }
  return null;
}

function stampHome(versions, apply) {
  const p = path.join(ROOT, 'pages', 'index.html');
  let html = fs.readFileSync(p, 'utf8');
  let changed = false;
  for (const [plugin, v] of Object.entries(versions)) {
    if (!v) continue;
    const re = new RegExp(`(href="\\./${plugin}/index\\.html"[\\s\\S]{0,400}?<span class="v">v)\\d+\\.\\d+\\.\\d+(</span>)`);
    const next = html.replace(re, `$1${v}$2`);
    if (next !== html) { html = next; changed = true; }
  }
  if (apply && changed) fs.writeFileSync(p, html);
  return changed;
}

function stampPage(plugin, v, apply) {
  const p = path.join(ROOT, 'pages', plugin, 'index.html');
  if (!fs.existsSync(p)) return false;
  const html = fs.readFileSync(p, 'utf8');
  // troca "<plugin> vX.Y.Z" e "Reviewer vX.Y.Z" onde aparecer (title/meta/pill)
  const next = html
    .replace(new RegExp(`(${plugin} v)\\d+\\.\\d+\\.\\d+`, 'gi'), `$1${v}`)
    .replace(/(Reviewer v)\d+\.\d+\.\d+/g, `$1${v}`);
  const changed = next !== html;
  if (apply && changed) fs.writeFileSync(p, next);
  return changed;
}

const mode = process.argv[2] || 'stamp';
const apply = mode === 'stamp';
const versions = Object.fromEntries(PLUGINS.map(p => [p, versionOf(p)]));

let drift = stampHome(versions, apply);
for (const plugin of PLUGINS) if (stampPage(plugin, versions[plugin], apply)) drift = true;

if (mode === 'check') {
  if (drift) {
    console.error('[version-stamp] DRIFT — page com versão fora do plugin.json. Rode: node .github/scripts/version-stamp.mjs stamp');
    process.exit(1);
  }
  console.log('[version-stamp] OK — versões das pages batem com os plugin.json.');
} else {
  console.log('[version-stamp] carimbado: ' + Object.entries(versions).map(([k, v]) => `${k} v${v}`).join(', '));
}
