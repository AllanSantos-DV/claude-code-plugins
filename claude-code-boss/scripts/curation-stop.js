#!/usr/bin/env node
/**
 * curation-stop.js — Stop hook (in-loop curation trigger).
 *
 * DESIGN (in-loop, no subagent): during the turn, curation-detect.js appends
 * lightweight entries to a per-turn state file. At Stop, we read those entries,
 * filter the actionable ones, and (if any) inject a `decision: 'block' + reason`
 * that asks the main agent — which already has full turn context — to create
 * or refine curated `.mjs` scripts.
 *
 * Mirrors the brain in-loop pattern (commit bff3e40): kill the token-burning
 * subagent, lean on the loop that already has context.
 *
 * Anti-loop: honors `stop_hook_active` per
 * https://code.claude.com/docs/en/hooks#stop_hook_active
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'hooks-config.json'), 'utf-8'));
    return cfg.curationStop || {};
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => resolve(d));
  });
}

function turnStatePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(RUNTIME_DIR, `curation-turn-${safe}.json`);
}

function loadTurnState(sessionId) {
  try {
    const p = turnStatePath(sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function clearTurnState(sessionId) {
  try {
    const p = turnStatePath(sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best effort */ }
}

function buildReason(entries) {
  const lines = entries.map(e => {
    const tag = e.reason || 'unknown';
    const target = e.curatedScript ? ` → script atual: \`${e.curatedScript}\`` : ' → sem script curado';
    return `  • \`${e.command}\` — ${e.lines} linhas, ${e.chars} chars${target} (${tag})`;
  });

  return [
    `Antes de terminar, este turn registrou ${entries.length} comando(s) com output volumoso ou script curado vazando.`,
    `Crie/refine os scripts \`.mjs\` em \`.vscode/scripts/\` e atualize \`.vscode/shells.json\` antes de parar.`,
    ``,
    `Comandos do turn:`,
    ...lines,
    ``,
    `Padrão (output contract OK/FAIL, shells.json schema, outputFilter cheatsheet):`,
    `leia a skill \`curation-script-pattern\` em \`skills/curation-script-pattern/SKILL.md\` do plugin.`,
    `Se algum comando for one-shot/raro, basta anotar e seguir.`,
  ].join('\n');
}

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* fall through */ }

    // Anti-loop guard: if Claude already retried this hook, allow stop.
    if (event.stop_hook_active) { process.stdout.write('{}'); return; }

    const cfg = loadConfig();
    if (cfg.enabled === false) { process.stdout.write('{}'); return; }

    const sessionId = event.session_id || event.sessionId || 'default';
    const state = loadTurnState(sessionId);

    if (!state || !Array.isArray(state.entries) || state.entries.length === 0) {
      process.stdout.write('{}');
      return;
    }

    // All recorded entries are actionable (detect already filtered via classifier).
    // We just emit them. Clear state regardless (turn ended).
    const entries = state.entries;
    clearTurnState(sessionId);

    if (entries.length === 0) { process.stdout.write('{}'); return; }

    const reason = buildReason(entries);
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } catch (err) {
    console.error(`[CURATION-STOP] Error: ${err.message}`);
    process.stdout.write('{}');
  }
})();
