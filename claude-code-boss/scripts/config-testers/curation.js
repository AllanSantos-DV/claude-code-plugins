'use strict';
/**
 * config-testers/curation.js — validates curation paths (scripts dir + shells.json).
 * Input:  { cwd?, scriptsDir?, shellsConfigPath?, scriptsDirSearch?, shellsConfigSearch? }
 *   - cwd defaults to process.cwd()
 *   - Either explicit paths OR search arrays. Search wins if both provided.
 * Output: { ok, details: {resolvedScriptsDir, resolvedShellsConfig, scriptCount, shellCount}, error?, ms }
 */
const fs = require('fs');
const path = require('path');

function resolveFirstExisting(cwd, candidates) {
  for (const cand of candidates || []) {
    if (!cand) continue;
    const full = path.isAbsolute(cand) ? cand : path.resolve(cwd, cand);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

async function test(input) {
  const t0 = Date.now();
  const cwd = (input && input.cwd) || process.cwd();
  const scriptsSearch = (input && input.scriptsDirSearch) || (input && input.scriptsDir ? [input.scriptsDir] : []);
  const shellsSearch = (input && input.shellsConfigSearch) || (input && input.shellsConfigPath ? [input.shellsConfigPath] : []);

  const scriptsDir = resolveFirstExisting(cwd, scriptsSearch);
  const shellsCfg = resolveFirstExisting(cwd, shellsSearch);

  const details = {
    cwd,
    resolvedScriptsDir: scriptsDir,
    resolvedShellsConfig: shellsCfg,
    scriptCount: 0,
    shellCount: 0,
  };

  if (!scriptsDir && !shellsCfg) {
    return { ok: false, error: 'Neither scriptsDir nor shellsConfigPath found in search paths.', details, ms: Date.now() - t0 };
  }

  if (scriptsDir) {
    try {
      const entries = fs.readdirSync(scriptsDir).filter(f => /\.(mjs|js|sh|ps1|cmd)$/.test(f));
      details.scriptCount = entries.length;
    } catch (err) {
      return { ok: false, error: `scriptsDir unreadable: ${err.message}`, details, ms: Date.now() - t0 };
    }
  }

  if (shellsCfg) {
    let raw;
    try { raw = fs.readFileSync(shellsCfg, 'utf-8'); }
    catch (err) { return { ok: false, error: `shells config unreadable: ${err.message}`, details, ms: Date.now() - t0 }; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { return { ok: false, error: `shells config invalid JSON: ${err.message}`, details, ms: Date.now() - t0 }; }
    const shells = Array.isArray(parsed?.shells) ? parsed.shells : null;
    if (!shells) return { ok: false, error: 'shells config missing "shells" array', details, ms: Date.now() - t0 };
    details.shellCount = shells.length;
    // Optional shape check: every entry should have either `command` or `script`.
    const bad = shells.filter(s => !s.command && !s.script);
    if (bad.length) {
      return { ok: false, error: `${bad.length} shell entr(ies) missing "command"/"script" field`, details, ms: Date.now() - t0 };
    }
  }

  return { ok: true, details, ms: Date.now() - t0 };
}

module.exports = { domain: 'curation', test };
