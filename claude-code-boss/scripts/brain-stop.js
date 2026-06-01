#!/usr/bin/env node
/**
 * brain-stop.js — Stop hook (brain-indexer in-loop trigger, escalating).
 *
 * DESIGN: when pending payloads in brain-pending/ reach `threshold`, emit
 * `decision: 'block' + reason` instructing the main agent to launch the
 * `brain-indexer` agent inline via Task tool.
 *
 * Naive anti-loop (`stop_hook_active → {}`) is too weak: the LLM can ignore
 * the first block, retry stopping, and the second fire's anti-loop guard lets
 * it escape without ever spawning brain-indexer. We instead:
 *
 *   1. Track per-session state in .runtime/brain-stop-<sid>.json
 *      ({ attempts, lastPendingCount, firstBlockedAt }).
 *   2. Detect PROGRESS: if pending count dropped since the last block, the
 *      agent did something useful → clear state, allow stop.
 *   3. Escalate REASON across retries (each retry more forceful).
 *   4. Safety cap: after `maxAttempts` (default 3) consecutive blocks with NO
 *      progress, relent (log warning, allow stop) — prevents UX deadlock if
 *      the agent genuinely can't run the subagent.
 *
 * Docs: https://code.claude.com/docs/en/hooks#stop_hook_active
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const PENDING_DIR = path.join(DATA_DIR, 'brain-pending');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');


function loadConfig() {
  return require('./lib/hooks-config.js').getBrainStop();
}

const { readStdin, emitStopBlock } = require('./lib/hook-io.js');
const { sanitizeSessionId } = require('./lib/session-id.js');

function countPending() {
  if (!fs.existsSync(PENDING_DIR)) return 0;
  try {
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).length;
  } catch (err) {
    console.error(`[BRAIN-STOP] pending count failed: ${err.message}`);
    return 0;
  }
}

function statePath(sessionId) {
  return path.join(RUNTIME_DIR, `brain-stop-${sanitizeSessionId(sessionId)}.json`);
}

function loadState(sessionId) {
  try {
    const p = statePath(sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[BRAIN-STOP] state load failed: ${err.message}`);
    return null;
  }
}

function saveState(sessionId, state) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch (err) {
    console.error(`[BRAIN-STOP] state save failed: ${err.message}`);
  }
}

function clearState(sessionId) {
  try {
    const p = statePath(sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best effort */ }
}

function buildReason(pending, threshold, attempt, maxAttempts) {
  // Escalating: progressively more forceful across retries.
  if (attempt === 1) {
    return [
      `${pending} payload(s) pending in brain-pending/ (threshold: ${threshold}).`,
      `Before stopping, launch the \`brain-indexer\` agent via Task tool to drain the queue.`,
      `Two-phase: Phase 1 triages up to 100 payloads (Step 0 admission only); Phase 2 indexes up to 30 admits (Steps 1-5).`,
    ].join('\n');
  }
  if (attempt < maxAttempts) {
    return [
      `[RETRY ${attempt}/${maxAttempts}] Previous block ignored — pending count unchanged (${pending}).`,
      `You MUST call the Task tool with subagent_type='brain-indexer' before stopping.`,
      `Do NOT respond with text first. Do NOT explain. Call Task tool now.`,
    ].join('\n');
  }
  // Final attempt before safety cap relents.
  return [
    `[FINAL RETRY ${attempt}/${maxAttempts}] Last warning. Pending still at ${pending}.`,
    `Call Task tool: { subagent_type: 'brain-indexer', description: 'drain brain-pending queue', prompt: 'Process the pending payloads in brain-pending/ following your two-phase workflow.' }`,
    `If you ignore this, the hook will relent on the next stop attempt and the queue stays stuck.`,
  ].join('\n');
}

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* fall through */ }

    const cfg = loadConfig();
    if (cfg.enabled === false) { process.stdout.write('{}'); return; }

    const { threshold, maxAttempts } = cfg;

    const sessionId = event.session_id || event.sessionId || 'default';
    const pending = countPending();

    // Below threshold → clear any stale state, allow stop.
    if (pending < threshold) {
      clearState(sessionId);
      process.stdout.write('{}');
      return;
    }

    const prev = loadState(sessionId);
    const isRetry = !!event.stop_hook_active && !!prev;

    if (isRetry) {
      // Progress detection: pending dropped → agent did useful work, release.
      if (pending < prev.lastPendingCount) {
        console.error(`[BRAIN-STOP] progress detected (${prev.lastPendingCount}→${pending}), releasing stop`);
        clearState(sessionId);
        process.stdout.write('{}');
        return;
      }

      // Safety cap: relent after maxAttempts with no progress.
      if (prev.attempts >= maxAttempts) {
        console.error(`[BRAIN-STOP] gave up after ${prev.attempts} attempts (pending=${pending}, no progress) — relenting`);
        clearState(sessionId);
        process.stdout.write('{}');
        return;
      }

      const next = {
        attempts: prev.attempts + 1,
        lastPendingCount: pending,
        firstBlockedAt: prev.firstBlockedAt,
      };
      saveState(sessionId, next);
      const reason = buildReason(pending, threshold, next.attempts, maxAttempts);
      emitStopBlock(reason);
      return;
    }

    // First block in this session.
    const state = {
      attempts: 1,
      lastPendingCount: pending,
      firstBlockedAt: new Date().toISOString(),
    };
    saveState(sessionId, state);
    const reason = buildReason(pending, threshold, 1, maxAttempts);
    emitStopBlock(reason);
  } catch (err) {
    console.error(`[BRAIN-STOP] Error: ${err.message}`);
    process.stdout.write('{}');
  }
})();
