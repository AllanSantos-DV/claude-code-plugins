#!/usr/bin/env node
/**
 * shape-output.js — C2b (Phase C): bound an EXPLORATION command's output when Token
 * Guard isn't installed (both plugins coexist; with it installed this never runs).
 *
 * The curation-guard appends it to a single exploration command:
 *   set -o pipefail; { <cmd>; } 2>&1 | node shape-output.js --family "git log"
 * so the command runs exactly as the agent wrote it (pipefail keeps its exit code).
 * Within the limits the output passes through untouched; beyond them the head is shown
 * and the FULL output saved to a file the agent can read by slice. Every cut is
 * measured (`curation.shaped`: raw vs shown chars) — the real saving, not a guess.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { getCuration } = require('./lib/brain-config.js');
const { dataDir } = require('./lib/data-dir.js');
const metrics = require('./lib/metrics.js');

const KEEP_MS = 24 * 60 * 60 * 1000;

function familyArg(argv) {
  const i = argv.indexOf('--family');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).slice(0, 60) : 'exploration';
}

/** Pure: decide what to show. @returns {{cut:boolean, shown:string, shownLines:number, rawLines:number}} */
function shape(text, { maxLines, maxChars }) {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (lines.length <= maxLines && text.length <= maxChars) return { cut: false, shown: text, shownLines: lines.length, rawLines: lines.length };
  const out = []; let chars = 0;
  for (const l of lines) {
    if (out.length >= maxLines || chars + l.length + 1 > maxChars) break;
    out.push(l); chars += l.length + 1;
  }
  return { cut: true, shown: out.join('\n'), shownLines: out.length, rawLines: lines.length };
}

function saveFull(text, family) {
  const dir = path.join(dataDir(), '.runtime', 'shaped');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > KEEP_MS) fs.rmSync(path.join(dir, f), { force: true }); }
    catch (err) { console.error(`[shape-output] prune ${f}: ${err.message}`); }
  }
  const file = path.join(dir, `${now}-${family.replace(/[^\w.-]+/g, '_')}.txt`);
  fs.writeFileSync(file, text);
  return file.replace(/\\/g, '/');
}

async function main() {
  const family = familyArg(process.argv);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let r;
  try {
    const cfg = getCuration();
    r = shape(text, { maxLines: cfg.shapeMaxLines, maxChars: cfg.shapeMaxChars });
  } catch (err) {
    // Never swallow the command's output: on any failure, pass it through raw, said loud.
    process.stdout.write(`${text}\n[boss] shape-output falhou (${err.message}) — saída crua acima.\n`);
    return;
  }
  if (!r.cut) { process.stdout.write(text); return; }
  let where = '';
  try { where = saveFull(text, family); }
  catch (err) { where = `(não foi possível salvar: ${err.message})`; }
  process.stdout.write(`${r.shown}\n[boss] saída cortada: ${r.shownLines} de ${r.rawLines} linhas, ${r.shown.length} de ${text.length} caracteres. Completa em: ${where} — leia por trecho (Read com offset/limit) em vez de despejar tudo. CCB_RAW=1 na frente do comando desliga este corte.\n`);
  try { await metrics.record('curation.shaped', { family, rawChars: text.length, shownChars: r.shown.length, rawLines: r.rawLines }, { cwd: process.cwd() }); }
  catch (err) { console.error(`[shape-output] metrics: ${err.message}`); }
}

if (require.main === module) {
  main().catch((err) => { console.error(`[shape-output] ${err.message}`); process.exit(0); });
}

module.exports = { shape };
