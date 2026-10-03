#!/usr/bin/env node
/**
 * shape-output.js — C2b (Phase C): bound an EXPLORATION command's output when Token
 * Guard isn't installed (both plugins coexist; with it installed this never runs).
 *
 * The curation-guard appends it to a single exploration command WITHOUT a pipe of its own:
 *   set -o pipefail; { <cmd>; } 2>&1 | node shape-output.js --family "git log"
 * so the command runs exactly as the agent wrote it (pipefail keeps <cmd>'s exit code;
 * a command with its own `| head` is never wrapped — pipefail would turn head's early
 * exit into SIGPIPE 141, a fake failure).
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

// The full-output file is capped: past this the rest is only counted, not stored.
const FILE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * STREAMING: the head is written as it arrives (a `find` that runs long, or one killed by
 * the Bash timeout, still shows its first lines — the first version buffered everything
 * until EOF, and lost it all on a kill); past the limits the rest goes straight to the
 * file (capped). Memory holds at most the head.
 */
async function main() {
  const family = familyArg(process.argv);
  let maxLines = 80; let maxChars = 8000;
  try { const cfg = getCuration(); maxLines = cfg.shapeMaxLines; maxChars = cfg.shapeMaxChars; }
  catch (err) { console.error(`[shape-output] config unreadable (${err.message}) — default limits`); }
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  const head = [];
  let partial = ''; let shownLines = 0; let shownChars = 0; let rawLines = 0; let rawChars = 0;
  let cut = false; let file = null; let fd = null; let fileBytes = 0; let saveErr = '';

  const toFile = (s) => {
    if (fd === null || fileBytes >= FILE_MAX_BYTES) return;
    try { const b = Buffer.from(s, 'utf8'); fs.writeSync(fd, b); fileBytes += b.length; }
    catch (err) { saveErr = err.message; try { fs.closeSync(fd); } catch (e) { void e; } fd = null; }
  };
  const startCut = () => {
    cut = true;
    try { file = saveFull('', family); fd = fs.openSync(file, 'a'); toFile(head.join('')); }
    catch (err) { saveErr = err.message; }
  };
  const onLine = (line) => { // `line` includes its '\n' (the last one may not)
    rawLines++; rawChars += line.length;
    if (!cut && shownLines < maxLines && shownChars + line.length <= maxChars) {
      process.stdout.write(line); head.push(line); shownLines++; shownChars += line.length;
      return;
    }
    if (!cut) startCut();
    toFile(line);
  };

  for await (const chunk of process.stdin) {
    const parts = (partial + decoder.write(chunk)).split('\n');
    partial = parts.pop();
    for (const p of parts) onLine(p + '\n');
  }
  const rest = partial + decoder.end();
  if (rest) onLine(rest);
  if (!cut) return;
  if (fd !== null) { try { fs.closeSync(fd); } catch (err) { saveErr = err.message; } }
  const where = saveErr ? `(não foi possível salvar: ${saveErr})` : `${file}${fileBytes >= FILE_MAX_BYTES ? ` (primeiros ${FILE_MAX_BYTES / 1048576} MB)` : ''}`;
  process.stdout.write(`${shownChars && !head[head.length - 1].endsWith('\n') ? '\n' : ''}[boss] saída cortada: ${shownLines} de ${rawLines} linhas, ${shownChars} de ${rawChars} caracteres. Completa em: ${where} — leia por trecho (Read com offset/limit) em vez de despejar tudo. CCB_RAW=1 na frente do comando desliga este corte.\n`);
  try { await metrics.record('curation.shaped', { family, rawChars, shownChars, rawLines }, { cwd: process.cwd() }); }
  catch (err) { console.error(`[shape-output] metrics: ${err.message}`); }
}

if (require.main === module) {
  main().catch((err) => { console.error(`[shape-output] ${err.message}`); process.exit(0); });
}

module.exports = { shape };
