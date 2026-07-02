#!/usr/bin/env node
/**
 * curation-stop.js — Stop hook (in-loop curation trigger, escalating).
 *
 * DESIGN (in-loop, no subagent): during the turn, curation-detect.js appends
 * lightweight entries to a per-turn state file. At Stop, we read those entries
 * and inject `decision: 'block' + reason` asking the main agent — which already
 * has full turn context — to refine existing curated scripts or create new ones.
 *
 * Naive anti-loop (`stop_hook_active → {}`) is too weak: the LLM can ignore
 * the first block, retry stopping, and the second fire's anti-loop guard lets
 * it escape without ever reading the curated script. We use an escalation
 * pattern:
 *
 *   1. Track per-session state in .runtime/curation-stop-<sid>.json
 *      ({ attempts, blockedSignature, firstBlockedAt }).
 *   2. Detect PROGRESS: if the new turn produces no overlap with previously
 *      blocked scripts/commands, the agent acted → clear state, allow stop.
 *   3. Escalate REASON across retries (each retry more forceful).
 *   4. Safety cap: after `maxAttempts` (default 3) consecutive blocks with NO
 *      progress, relent (log warning, allow stop) — prevents UX deadlock.
 *
 * Docs: https://code.claude.com/docs/en/hooks#stop_hook_active
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { loadCurationConfig } = require('./curation-paths.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');


function loadConfig() {
  return require('./lib/hooks-config.js').getCurationStop();
}

const { readStdin, emitStopBlock } = require('./lib/hook-io.js');
const { sanitizeSessionId } = require('./lib/session-id.js');
const turnJournal = require('./lib/turn-journal.js');

function escalationPath(sessionId) {
  return path.join(RUNTIME_DIR, `curation-stop-${sanitizeSessionId(sessionId)}.json`);
}

function loadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[CURATION-STOP] load failed (${p}): ${err.message}`);
    return null;
  }
}

function saveJson(p, data) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch (err) {
    console.error(`[CURATION-STOP] save failed (${p}): ${err.message}`);
  }
}

function unlinkSafe(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ }
}

function signatureOf(entries) {
  return entries
    .map(e => `${e.command || ''}|${e.curatedScript || ''}`)
    .sort()
    .join('\n');
}

function hasOverlap(prevSig, currEntries) {
  if (!prevSig) return false;
  const prevSet = new Set(prevSig.split('\n').filter(Boolean));
  for (const e of currEntries) {
    const key = `${e.command || ''}|${e.curatedScript || ''}`;
    if (prevSet.has(key)) return true;
  }
  return false;
}

/**
 * Detect "progress via curated-script edit": if any blocked entry referenced a
 * curated script AND that script's mtime is newer than firstBlockedAt, the
 * agent acted on the block (refined the script). Treat as progress — even
 * without a re-run — because the script may legitimately be one-shot.
 * The next time it runs (whenever that happens), PostToolUse will re-validate.
 */
function curatedScriptsTouchedSince(prev, cwd) {
  if (!prev || !prev.firstBlockedAt || !Array.isArray(prev.blockedEntries)) return false;
  const since = new Date(prev.firstBlockedAt).getTime();
  if (!Number.isFinite(since)) return false;
  for (const e of prev.blockedEntries) {
    const rel = e && e.curatedScript;
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs > since) return true;
    } catch { /* missing/unreadable — ignore */ }
  }
  return false;
}

function buildReason(entries, attempt, maxAttempts) {
  const curationCfg = loadCurationConfig();
  const { oneHitMaxRecurrence } = require('./lib/brain-config.js').getCuration();
  const refineEntries = entries.filter(e => e.curatedScript);
  const createEntries = entries.filter(e => !e.curatedScript);

  const sections = [];

  if (attempt === 1) {
    sections.push(`${entries.length} command(s) need curation. See skill \`curation-script-pattern\`.`);
  } else if (attempt < maxAttempts) {
    sections.push(`[RETRY ${attempt}/${maxAttempts}] Still pending — act, don't acknowledge.`);
  } else {
    sections.push(`[FINAL ${attempt}/${maxAttempts}] Last block before hook relents.`);
  }
  sections.push(``);

  if (refineEntries.length > 0) {
    sections.push(`REFINE:`);
    for (const e of refineEntries) {
      sections.push(`  • \`${e.curatedScript}\` — ${e.command} (${e.lines}L/${e.chars}c, ${e.reason})`);
    }
    sections.push(``);
  }

  if (createEntries.length > 0) {
    sections.push(`CREATE a curated script — call \`curation_register_shell({ id, scriptPath, content, aliases })\` to write it into \`${curationCfg.scriptsDir}/\` and register it in \`${curationCfg.shellsConfigPath}\` atomically (avoids the Auto Mode classifier blocking manual Write/Edit) — OR, if genuinely single-use, call \`curation_mark_oneoff({ aliases:[...] })\` to skip it (the \`x/${oneHitMaxRecurrence}\` is how often it recurred; at the ceiling you must curate):`);
    for (const e of createEntries) {
      const parts = [`\`${e.command}\``];
      if (e.sig) parts.push(`sig \`${e.sig}\``);
      if (Number.isInteger(e.recurrence)) parts.push(`${e.recurrence}/${oneHitMaxRecurrence}`);
      parts.push(`${e.lines}L/${e.chars}c`);
      parts.push(e.reason);
      sections.push(`  • ${parts.join(' · ')}`);
    }
  }

  return sections.join('\n').trimEnd();
}

(async () => {
  try {
    const raw = await readStdin();
    let event = {};
    try { event = JSON.parse(raw || '{}'); } catch { /* fall through */ }

    const cfg = loadConfig();
    if (cfg.enabled === false) { process.stdout.write('{}'); return; }

    const { maxAttempts } = cfg;

    const sessionId = event.session_id || event.sessionId || 'default';
    const entries = turnJournal.readEntries(sessionId);

    const escPath = escalationPath(sessionId);
    const prev = loadJson(escPath);
    const isRetry = !!event.stop_hook_active && !!prev;

    if (isRetry) {
      // Progress detection:
      //   - empty turn-state = agent didn't run any new tool calls this turn
      //     (text-only "noted, moving on" reply) → NO progress, escalate.
      //   - new entries that overlap with previously blocked sig → NO progress.
      //   - new entries with no overlap → agent moved on to different work,
      //     accept as progress and release.
      //   - curated script(s) referenced by blocked entries were edited since
      //     firstBlockedAt → agent acted on the block (refine), accept even if
      //     they didn't re-run (script may be one-shot; PostToolUse re-validates
      //     whenever it next runs).
      const hasNew = entries.length > 0;
      const overlap = hasOverlap(prev.blockedSignature, entries);
      const editedCurated = curatedScriptsTouchedSince(prev, event.cwd || process.cwd());
      const noProgress = (!hasNew || overlap) && !editedCurated;

      if (!noProgress) {
        const why = editedCurated
          ? 'curated script(s) edited since first block'
          : 'new non-overlapping work';
        console.error(`[CURATION-STOP] progress detected (${why}), releasing stop`);
        unlinkSafe(escPath);
        turnJournal.clearEntries(sessionId);
        process.stdout.write('{}');
        return;
      }

      // Safety cap: relent after maxAttempts with no progress.
      if (prev.attempts >= maxAttempts) {
        console.error(`[CURATION-STOP] gave up after ${prev.attempts} attempts (no progress) — relenting`);
        unlinkSafe(escPath);
        turnJournal.clearEntries(sessionId);
        process.stdout.write('{}');
        return;
      }

      // Escalate: reuse prior blocked entries if no new ones this turn so the
      // reason keeps pointing at the same unresolved work.
      const escalateEntries = hasNew ? entries : (prev.blockedEntries || []);
      const nextAttempt = prev.attempts + 1;
      saveJson(escPath, {
        attempts: nextAttempt,
        blockedSignature: prev.blockedSignature,
        blockedEntries: prev.blockedEntries || escalateEntries,
        firstBlockedAt: prev.firstBlockedAt,
      });
      turnJournal.clearEntries(sessionId);
      const reason = buildReason(escalateEntries, nextAttempt, maxAttempts);
      emitStopBlock(reason);
      return;
    }

    // First block (or stale escalation state without retry flag).
    if (entries.length === 0) {
      // Nothing to block on; clear any stale escalation state.
      unlinkSafe(escPath);
      process.stdout.write('{}');
      return;
    }

    saveJson(escPath, {
      attempts: 1,
      blockedSignature: signatureOf(entries),
      blockedEntries: entries,
      firstBlockedAt: new Date().toISOString(),
    });
    turnJournal.clearEntries(sessionId);
    const reason = buildReason(entries, 1, maxAttempts);
    emitStopBlock(reason);
  } catch (err) {
    console.error(`[CURATION-STOP] Error: ${err.message}`);
    process.stdout.write('{}');
  }
})();
