#!/usr/bin/env node
/**
 * compat-check.js — does the INSTALLED Claude Code still contain every identifier the plugin depends on?
 *
 *   node scripts/compat-check.js [--bin <claude executable>] [--json]
 *
 * Collects what the plugin reads, writes or registers — engine env-var names, the hook events of
 * hooks/hooks.json, the module API (`$.ns.method`) hooks/compaction.mjs calls, the settings keys and the
 * transcript/hook fields it parses — and looks for each as a literal string in the engine binary.
 *
 * PROVES: the engine still knows the name (it was not dropped or renamed).
 * DOES NOT PROVE: that the name kept its meaning — a name can survive a behaviour change. Behaviour is
 * checked by the real-session smoke (smoke/README) and by the transcript scan against real traffic.
 *
 * Exit 0 = all present · 1 = something missing · 2 = no Claude Code binary found (never reported as a pass).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// The plugin's own CLAUDE_CODE_BOSS_* switches and regex fragments (trailing "_") are not engine names.
const ENV_RE = /\b(CLAUDE_CODE_[A-Z0-9_]*[A-Z0-9]|CLAUDE_AUTOCOMPACT_[A-Z0-9_]*[A-Z0-9]|ENABLE_[A-Z0-9_]*(?:CACHING|TOOL_SEARCH)[A-Z0-9_]*|FORCE_PROMPT_CACHING_[A-Z0-9_]*[A-Z0-9]|DISABLE_PROMPT_CACHING[A-Z0-9_]*|MAX_MCP_OUTPUT_TOKENS|ANTHROPIC_BASE_URL)\b/g;
// Settings keys, hook/transcript fields and engine behaviours the plugin relies on, each with the reason.
const CONTRACT = {
  autoCompactWindow: 'cost-tuning window (settings)', autoCompactEnabled: 'compaction on/off (settings)', idleCompaction: 'engine idle compaction (settings, 2.1.286+)',
  precomputeCompactionEnabled: 'engine background summary (settings)', modelSettings: 'per-model window (/autocompact)', enabledPlugins: 'plugin registry',
  hookSpecificOutput: 'hook reply envelope', updatedInput: 'PreToolUse rewrite', additionalContext: 'hook context injection', permissionDecision: 'PreToolUse decision',
  cache_read_input_tokens: 'transcript usage', cache_creation_input_tokens: 'transcript usage', ephemeral_1h_input_tokens: 'transcript cache split', ephemeral_5m_input_tokens: 'transcript cache split',
  compact_summary: 'PostCompact input', CLAUDE_PLUGIN_ROOT: 'plugin path variable', CLAUDE_PLUGIN_DATA: 'plugin data variable',
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.runtime', 'docs', '__fixtures__']);
function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(js|mjs|cjs|json)$/.test(e.name) && !/(^test-|\.test\.|package-lock)/.test(e.name) && p !== __filename) yield p;
  }
}

/** The Claude Code executable: --bin (exactly that file), else CLAUDE_CODE_EXECPATH (set inside a session), else the npm global install. null = none found. */
function findBinary(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null; // an explicit path is never swapped for another binary
  const candidates = [process.env.CLAUDE_CODE_EXECPATH];
  try {
    const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' }).trim();
    for (const pkg of ['claude-code-win32-x64', 'claude-code-linux-x64', 'claude-code-darwin-arm64', 'claude-code-darwin-x64']) {
      candidates.push(path.join(g, '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', pkg, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    }
  } catch (err) { void err; /* no npm: only the explicit candidates */ }
  return candidates.find((c) => c && fs.existsSync(c) && fs.statSync(c).size > 5e6) || null;
}

/** @returns {Array<{kind:string, name:string, why:string}>} everything the plugin depends on, by kind. */
function dependencies() {
  const env = new Map();
  for (const f of sources(ROOT)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(ENV_RE)) {
      if (m[1].startsWith('CLAUDE_CODE_BOSS_')) continue;
      if (!env.has(m[1])) env.set(m[1], path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }
  const mod = new Map();
  for (const m of fs.readFileSync(path.join(ROOT, 'hooks', 'compaction.mjs'), 'utf8').matchAll(/\$\.([a-z]+)\.([a-zA-Z]+)/g)) mod.set(`${m[1]}.${m[2]}`, 'hooks/compaction.mjs');
  const events = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks);
  return [
    ...[...env].sort().map(([name, why]) => ({ kind: 'env', name, why })),
    ...events.map((name) => ({ kind: 'hook-event', name, why: 'hooks/hooks.json' })),
    ...[...mod].sort().map(([name, why]) => ({ kind: 'mod-api', name, why })),
    ...Object.entries(CONTRACT).map(([name, why]) => ({ kind: 'contract', name, why })),
  ];
}

/** @returns {{version:string|null, rows:Array<{kind:string,name:string,why:string,present:boolean}>}} */
function check(binPath) {
  const bin = fs.readFileSync(binPath);
  const has = (s) => bin.includes(Buffer.from(s, 'utf8')) || bin.includes(Buffer.from(s, 'utf16le'));
  let version = null;
  for (let d = path.dirname(binPath), up = 0; up < 6 && !version; d = path.dirname(d), up++) {
    const pkg = path.join(d, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (/^@anthropic-ai\/claude-code/.test(j.name || '')) version = j.version;
  }
  return { version, rows: dependencies().map((d) => ({ ...d, present: has(d.name) })) };
}

function main() {
  const i = process.argv.indexOf('--bin');
  const bin = findBinary(i > 0 ? process.argv[i + 1] : null);
  if (!bin) { console.error('compat-check: no Claude Code binary found (pass --bin <path> or set CLAUDE_CODE_EXECPATH) — nothing was checked'); process.exit(2); }
  const { version, rows } = check(bin);
  const missing = rows.filter((r) => !r.present);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ version, bin, rows }, null, 2));
  else {
    for (const r of rows) console.log(`${r.present ? 'ok     ' : 'MISSING'} ${r.kind.padEnd(10)} ${r.name}   <- ${r.why}`);
    console.log(`\nclaude ${version || '?'} (${bin}): ${rows.length - missing.length}/${rows.length} present, ${missing.length} missing`);
  }
  process.exit(missing.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { findBinary, dependencies, check };
