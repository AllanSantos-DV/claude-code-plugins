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

const { loadCurationConfig, getShellsConfigPath } = require('./curation-paths.js');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');


function loadConfig() {
  return require('./lib/hooks-config.js').getCurationStop();
}

const { runStopDetectorCli } = require('./lib/hook-io.js');
const { sanitizeSessionId } = require('./lib/session-id.js');
const turnJournal = require('./lib/turn-journal.js');
const oneoff = require('./lib/oneoff-store.js');
const { reconcileEntries } = require('./lib/curation-reconcile.js');
const { findProjectRoot, loadShellsConfig, matchCuratedShell } = require('./shells-config.js');

/**
 * Drop entries the agent already resolved via the MCP tools the block itself
 * asks for (`curation_mark_oneoff` / `curation_register_shell`). Those calls
 * produce no Bash PostToolUse entry, so signature-overlap alone can't see them —
 * reconcile against the one-hit store + shells.json instead.
 *
 * shells.json is only consulted when it changed AFTER `shellsSinceMs` (i.e. the
 * agent registered a curated script mid-turn). Pre-existing entries were already
 * visible to curation-detect at classification time and must not release the
 * block. Default Infinity = skip the shells check (first-block path).
 */
function filterUnresolved(entries, cwd, { shellsSinceMs = Infinity } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { pending: [], resolved: [] };
  const { oneHitMaxRecurrence, oneHitWindowDays } = require('./lib/brain-config.js').getCuration();
  const store = oneoff.load(DATA_DIR, oneoff.resolveProjectKey(cwd));
  let matchShell = () => null;
  try {
    const projectRoot = findProjectRoot(cwd);
    const shellsPath = projectRoot && getShellsConfigPath(projectRoot);
    if (shellsPath && fs.statSync(shellsPath).mtimeMs > shellsSinceMs) {
      const { shells } = loadShellsConfig(projectRoot);
      matchShell = (cmd) => matchCuratedShell(cmd, shells);
    }
  } catch { /* no shells.json (or unreadable) — one-hit check only */ }
  return reconcileEntries(entries, {
    store,
    matchShell,
    windowDays: oneHitWindowDays,
    maxRecurrence: oneHitMaxRecurrence,
  });
}

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
    sections.push(`CREATE a curated script — call \`curation_register_shell({ id, scriptPath, content, aliases })\` to write it into \`${curationCfg.scriptsDir}/\` and register it in \`${curationCfg.shellsConfigPath}\` atomically (avoids the Auto Mode classifier blocking manual Write/Edit) — OR, if genuinely single-use, call \`curation_mark_oneoff({ sigs:[...] })\` passing each \`sig\` below VERBATIM to skip it (the \`x/${oneHitMaxRecurrence}\` is how often it recurred; at the ceiling you must curate):`);
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

async function run(event) {
  event = event || {};
  try {
    const cfg = loadConfig();
    if (cfg.enabled === false) return {};

    const { maxAttempts } = cfg;

    const sessionId = event.session_id || event.sessionId || 'default';
    const entries = turnJournal.readEntries(sessionId);

    const escPath = escalationPath(sessionId);
    const prev = loadJson(escPath);
    const isRetry = !!event.stop_hook_active && !!prev;

    if (isRetry) {
      const cwd = event.cwd || process.cwd();
      const sinceMs = new Date(prev.firstBlockedAt).getTime();
      // Reconcile FIRST: entries resolved via the MCP tools the block asks for
      // (curation_mark_oneoff / curation_register_shell) leave no Bash trace —
      // drop them from both the previously blocked set and this turn's journal.
      const prevBlocked = prev.blockedEntries || [];
      const { pending: prevPending } = filterUnresolved(prevBlocked, cwd, { shellsSinceMs: sinceMs });
      const { pending: currPending } = filterUnresolved(entries, cwd, { shellsSinceMs: sinceMs });
      // Guard on prevBlocked.length: legacy escalation state without
      // blockedEntries must fall through to signature-overlap detection, not
      // read as "everything resolved".
      const resolvedSome = prevBlocked.length > 0 && prevPending.length < prevBlocked.length;

      // Progress detection:
      //   - every previously blocked entry is now resolved → release.
      //   - SOME were resolved (one-hit marked / curated) → the agent acted on
      //     the block; release rather than nag — survivors re-surface via
      //     PostToolUse whenever they actually recur.
      //   - a one-hit marking landed after firstBlockedAt (even if its sig
      //     didn't match) → good-faith action, release (anti-deadlock).
      //   - new entries with no overlap → agent moved on to different work,
      //     accept as progress and release.
      //   - curated script(s) referenced by blocked entries were edited since
      //     firstBlockedAt → agent acted on the block (refine), accept even if
      //     they didn't re-run (script may be one-shot; PostToolUse re-validates
      //     whenever it next runs).
      //   - empty turn-state + none of the above = text-only "noted, moving on"
      //     reply → NO progress, escalate.
      const hasNew = currPending.length > 0;
      const overlap = hasOverlap(prev.blockedSignature, currPending);
      const editedCurated = curatedScriptsTouchedSince(prev, cwd);
      const markedRecently = oneoff.markedSince(
        oneoff.load(DATA_DIR, oneoff.resolveProjectKey(cwd)), sinceMs);
      const noProgress = !resolvedSome && !markedRecently && !editedCurated
        && (!hasNew || overlap);

      if (!noProgress) {
        const why = resolvedSome && prevPending.length === 0 ? 'all blocked entries resolved'
          : resolvedSome ? 'blocked entries resolved via one-hit/curation'
          : markedRecently ? 'one-hit marking since first block'
          : editedCurated ? 'curated script(s) edited since first block'
          : 'new non-overlapping work';
        console.error(`[CURATION-STOP] progress detected (${why}), releasing stop`);
        unlinkSafe(escPath);
        turnJournal.clearEntries(sessionId);
        return {};
      }

      // Safety cap: relent after maxAttempts with no progress.
      if (prev.attempts >= maxAttempts) {
        console.error(`[CURATION-STOP] gave up after ${prev.attempts} attempts (no progress) — relenting`);
        unlinkSafe(escPath);
        turnJournal.clearEntries(sessionId);
        return {};
      }

      // Escalate: reuse prior blocked entries if no new ones this turn so the
      // reason keeps pointing at the same unresolved work.
      const escalateEntries = hasNew ? currPending : prevPending;
      const nextAttempt = prev.attempts + 1;
      saveJson(escPath, {
        attempts: nextAttempt,
        blockedSignature: prev.blockedSignature,
        blockedEntries: prevPending.length ? prevPending : escalateEntries,
        firstBlockedAt: prev.firstBlockedAt,
      });
      turnJournal.clearEntries(sessionId);
      const reason = buildReason(escalateEntries, nextAttempt, maxAttempts);
      return { block: true, reason };
    }

    // First block (or stale escalation state without retry flag). Reconcile
    // before blocking: entries the agent already resolved mid-turn (one-hit
    // marked / curated after the command ran) must not trigger a block.
    const { pending } = filterUnresolved(entries, event.cwd || process.cwd());
    if (pending.length === 0) {
      // Nothing to block on; clear any stale escalation state.
      unlinkSafe(escPath);
      turnJournal.clearEntries(sessionId);
      return {};
    }

    saveJson(escPath, {
      attempts: 1,
      blockedSignature: signatureOf(pending),
      blockedEntries: pending,
      firstBlockedAt: new Date().toISOString(),
    });
    turnJournal.clearEntries(sessionId);
    const reason = buildReason(pending, 1, maxAttempts);
    return { block: true, reason };
  } catch (err) {
    console.error(`[CURATION-STOP] Error: ${err.message}`);
    return {};
  }
}

if (require.main === module) {
  runStopDetectorCli(run, 'curation-stop');
}

module.exports = { run };
