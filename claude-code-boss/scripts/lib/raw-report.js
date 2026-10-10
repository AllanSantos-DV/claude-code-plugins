'use strict';
/**
 * raw-report.js — EXACT savings of a curated script run.
 *
 * Only the curated script ever sees the command's raw output (it captures it and prints the
 * summary), so only it can say how big that output was. Before this, the dashboard could only
 * ESTIMATE a redirect's savings from an old raw run of the same signature — 4 of 25 redirects had
 * one in a week, and direct script runs counted nothing, so the shown total was far below the real
 * one (one test-suite run alone cuts ~12k chars).
 *
 * Contract:
 *   1. curation-guard, when it rewrites a command to a curated script, adds
 *      `CCB_RAW_REPORT="<data>/.runtime/raw-report/<id>.jsonl"` to the script's environment.
 *   2. the script appends one JSON line per run: {"rawChars": N, "rawLines": M} (templates in the
 *      curation-script-pattern skill). A script that does not report just keeps the estimate.
 *   3. curation-detect (PostToolUse) reads the file named in the executed command — only inside
 *      the report dir — adds rawChars to `curation.used`, and deletes it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./data-dir.js');

const STALE_MS = 24 * 3600_000;
const REPORT_RE = /CCB_RAW_REPORT="([^"]+)"/g;

/** @returns {string} the dir every report file lives in */
function reportDir() {
  return path.join(dataDir(), '.runtime', 'raw-report');
}

/** A fresh report file path (the file is created by the script, not here). */
function newReportPath() {
  return path.join(reportDir(), `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}.jsonl`);
}

/**
 * Put `CCB_RAW_REPORT` in front of every curated-script invocation of a rewritten command (each one
 * carries the CCB_PROJECT_ROOT prefix curation-redirect.invocationFor writes). Refuses a path that
 * could break the quoting. Pure.
 * @param {string} rewritten
 * @param {string} reportPath
 * @returns {string}
 */
function withReport(rewritten, reportPath) {
  const p = String(reportPath || '').replace(/\\/g, '/');
  if (!p || /["$`\n\r]/.test(p)) return rewritten;
  return String(rewritten).split('CCB_PROJECT_ROOT="').join(`CCB_RAW_REPORT="${p}" CCB_PROJECT_ROOT="`);
}

/**
 * Read (and delete) the reports a run left: the files named in `command`, only inside reportDir().
 * @param {string} command the EXECUTED command (PostToolUse tool_input)
 * @returns {{rawChars:number, rawLines:number, runs:number}|null} null when nothing was reported
 */
function takeReport(command) {
  const dir = path.resolve(reportDir());
  let rawChars = 0; let rawLines = 0; let runs = 0;
  for (const m of String(command || '').matchAll(REPORT_RE)) {
    const file = path.resolve(m[1]);
    const rel = path.relative(dir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // never read/delete outside our dir
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[raw-report] ${file}: ${err.message}`);
      continue; // the script does not report (yet): the estimate stays
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const c = Number(j.rawChars);
        if (Number.isFinite(c) && c >= 0) { rawChars += c; rawLines += Number(j.rawLines) || 0; runs++; }
      } catch (err) { console.error(`[raw-report] bad line in ${path.basename(file)}: ${err.message}`); }
    }
    try { fs.rmSync(file, { force: true }); } catch (err) { console.error(`[raw-report] could not delete ${file}: ${err.message}`); }
  }
  sweepStale();
  return runs ? { rawChars, rawLines, runs } : null;
}

/** Drop report files nobody read (a run that never reached PostToolUse). */
function sweepStale(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(reportDir()); } catch (err) { void err; return; }
  for (const n of names) {
    const f = path.join(reportDir(), n);
    try { if (now - fs.statSync(f).mtimeMs > STALE_MS) fs.rmSync(f, { force: true }); } catch (err) { void err; }
  }
}

module.exports = { reportDir, newReportPath, withReport, takeReport, sweepStale };
