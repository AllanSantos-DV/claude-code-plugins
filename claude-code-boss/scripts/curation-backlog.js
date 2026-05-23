#!/usr/bin/env node
/**
 * curation-backlog.js — UserPromptSubmit hook
 *
 * Verifica payloads pendentes em detect-curation/ e injeta additionalContext
 * instruindo Claude a invocar o curation-improver via Task tool.
 *
 * Cooldown: não reinjecta enquanto turnsSinceLast < COOLDOWN_TURNS.
 * Orphaned: payloads com mais de ORPHAN_AGE_MS são movidos para processed/orphaned/.
 *
 * Ref: https://code.claude.com/docs/en/hooks (accessed 2026-05-23)
 *   UserPromptSubmit hookSpecificOutput.additionalContext confirmed.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { hookLog } = require('./hook-logger.js');

const DATA_DIR      = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const DETECT_DIR    = path.join(DATA_DIR, 'detect-curation');
const PROCESSED_DIR = path.join(DETECT_DIR, 'processed');
const ORPHANED_DIR  = path.join(PROCESSED_DIR, 'orphaned');
const RUNTIME_DIR   = path.join(DATA_DIR, '.runtime');
const STATE_FILE    = path.join(RUNTIME_DIR, 'curation-backlog-state.json');

const COOLDOWN_TURNS = 5;
const ORPHAN_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── stdin ────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (err) { reject(err); }
    });
    process.stdin.on('error', reject);
  });
}

// ── state ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { turnsSinceLast: COOLDOWN_TURNS };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[CURATION-BACKLOG] Failed to read state: ${err.message}`);
    hookLog('error', 'curation-backlog', `Failed to read state: ${err.message}`);
    return { turnsSinceLast: COOLDOWN_TURNS };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error(`[CURATION-BACKLOG] Failed to save state: ${err.message}`);
    hookLog('error', 'curation-backlog', `Failed to save state: ${err.message}`);
  }
}

// ── orphan cleanup ───────────────────────────────────────────────────────────

function handleOrphaned(files) {
  const now = Date.now();
  const pending = [];

  for (const f of files) {
    const filePath = path.join(DETECT_DIR, f);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.error(`[CURATION-BACKLOG] Failed to read payload ${f}: ${err.message}`);
      hookLog('error', 'curation-backlog', `Failed to read payload ${f}: ${err.message}`);
      continue;
    }

    const age = payload.detectedAt
      ? now - new Date(payload.detectedAt).getTime()
      : ORPHAN_AGE_MS + 1;

    if (age > ORPHAN_AGE_MS) {
      try {
        fs.mkdirSync(ORPHANED_DIR, { recursive: true });
        fs.renameSync(filePath, path.join(ORPHANED_DIR, f));
        console.warn(`[CURATION-BACKLOG] Moved orphaned payload ${f} (age ${Math.round(age / 86400000)}d)`);
        hookLog('warn', 'curation-backlog', `Orphaned payload ${f} moved after ${Math.round(age / 86400000)} days`);
      } catch (err) {
        console.error(`[CURATION-BACKLOG] Failed to move orphaned ${f}: ${err.message}`);
        hookLog('error', 'curation-backlog', `Failed to move orphaned ${f}: ${err.message}`);
      }
    } else {
      pending.push({ file: f, payload });
    }
  }

  return pending;
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const event = await readStdin();

    // Load cooldown state
    const state = loadState();
    if (state.turnsSinceLast < COOLDOWN_TURNS) {
      state.turnsSinceLast += 1;
      saveState(state);
      process.stdout.write('{}');
      return;
    }

    // List pending payload files (root only, exclude subdirs)
    let files = [];
    try {
      if (fs.existsSync(DETECT_DIR)) {
        files = fs.readdirSync(DETECT_DIR).filter(f => f.endsWith('.json'));
      }
    } catch (err) {
      console.error(`[CURATION-BACKLOG] Failed to list detect-curation dir: ${err.message}`);
      hookLog('error', 'curation-backlog', `Failed to list detect-curation: ${err.message}`);
      process.stdout.write('{}');
      return;
    }

    // Handle orphaned payloads; get remaining pending list
    const pending = handleOrphaned(files);

    if (pending.length === 0) {
      process.stdout.write('{}');
      return;
    }

    // Inject context instructing Claude to invoke curation-improver
    const count = pending.length;
    const sample = pending[0].payload;
    const sampleCmd = sample ? sample.command : '(unknown)';

    const additionalContext = [
      `⚙️ ${count} curation payload(s) pendente(s) em detect-curation/.`,
      `Exemplo: \`${sampleCmd}\` produziu saída volumosa sem script curado.`,
      `Invoque o agente curation-improver (Task tool) para criar scripts curados para esses comandos.`,
      `Payloads: ${pending.map(p => p.file).join(', ')}`,
    ].join('\n');

    // Save state: reset cooldown counter
    const newState = {
      lastInjectedAt: new Date().toISOString(),
      lastInjectedTurnId: event.session_id || '',
      turnsSinceLast: 0,
    };
    saveState(newState);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }));
  } catch (err) {
    console.error(`[CURATION-BACKLOG] Unhandled error: ${err.message}`);
    hookLog('error', 'curation-backlog', `Unhandled error: ${err.message}`);
    process.stdout.write('{}');
  }
})();
