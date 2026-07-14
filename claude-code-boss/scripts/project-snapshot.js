#!/usr/bin/env node
/**
 * project-snapshot.js — SessionStart hook.
 *
 * Extends Claude Code's native "Branch / Recent commits" SessionStart context
 * with a *living* picture of the working tree: branch age vs main, ahead/behind
 * counts, old dirty files, stash count, and (if `gh` is authed) open PRs +
 * latest CI run + review requests.
 *
 * Always async + heavily gated. Hard timeout 4.5s. Empty output on any failure.
 * 5-minute cache keyed by cwd so quick VSCode reloads pay nothing.
 *
 * Pure formatters and parsers are exported for unit tests.
 */
'use strict';

const fs = require('fs');
const { writeFileAtomic } = require('./lib/atomic-write.js');
const path = require('path');
const { spawn } = require('child_process');

const { readStdin, parsePayload, emitEmpty, emitJson } = require('./lib/hook-io.js');
const hooksConfigLib = require('./lib/hooks-config.js');

const TOTAL_TIMEOUT_MS = 4500;
const CMD_TIMEOUT_MS = 2000;
const HARD_CHAR_LIMIT = 1400;

function loadConfig() {
  const cfg = hooksConfigLib.load();
  const ps = cfg.projectSnapshot || {};
  return {
    enabled: ps.enabled !== false,
    includeGh: ps.includeGh === undefined ? 'auto' : ps.includeGh,
    dirtyAgeThresholdHours: Number.isFinite(ps.dirtyAgeThresholdHours) ? ps.dirtyAgeThresholdHours : 24,
    maxItemsPerSection: Number.isFinite(ps.maxItemsPerSection) ? ps.maxItemsPerSection : 5,
    cacheTtlSeconds: Number.isFinite(ps.cacheTtlSeconds) ? ps.cacheTtlSeconds : 300,
  };
}

function dataDir() {
  return require('./lib/data-dir.js').dataDir();
}

function cachePath(cwd) {
  const dir = path.join(dataDir(), '.runtime');
  fs.mkdirSync(dir, { recursive: true });
  // Hash-ish key — basename is enough for legibility; we also store cwd for assertion.
  const key = Buffer.from(cwd).toString('base64').replace(/[\/+=]/g, '').slice(-32);
  return path.join(dir, `project-snapshot-${key}.json`);
}

function readCache(cwd, ttlSec) {
  const p = cachePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (obj.cwd !== cwd) return null;
    if (typeof obj.ts !== 'number') return null;
    if ((Date.now() - obj.ts) > ttlSec * 1000) return null;
    return obj.md || null;
  } catch { /* unreadable/invalid cache: treat as miss */ return null; }
}

function writeCache(cwd, md) {
  try { writeFileAtomic(cachePath(cwd), JSON.stringify({ cwd, ts: Date.now(), md })); }
  catch { /* nothing actionable */ }
}

// ─── Subprocess wrapper ────────────────────────────────────────────────────

function runCmd(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = '', err = '';
    const finish = (code) => {
      if (done) return; done = true;
      resolve({ code: code ?? null, stdout: out, stderr: err });
    };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {/*ignore*/} finish(null); }, timeoutMs);
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', () => { clearTimeout(t); finish(null); });
    p.on('close', (code) => { clearTimeout(t); finish(code); });
  });
}

// ─── Local git probes ──────────────────────────────────────────────────────

async function gatherLocal(cwd, deadlineFn) {
  const out = { branch: null, branchAgeDays: null, ahead: 0, behind: 0, dirtyOld: [], stashCount: 0 };

  const [branchR, hbR, dirtyR, stashR] = await Promise.all([
    runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 1000),
    runCmd('git', ['rev-list', '--left-right', '--count', 'main...HEAD'], cwd, 1000),
    runCmd('git', ['status', '--porcelain=v1'], cwd, 1500),
    runCmd('git', ['stash', 'list'], cwd, 1000),
  ]);

  if (branchR.code === 0) out.branch = (branchR.stdout || '').trim() || null;

  if (hbR.code === 0) {
    const m = (hbR.stdout || '').trim().match(/^(\d+)\s+(\d+)$/);
    if (m) { out.behind = parseInt(m[1], 10); out.ahead = parseInt(m[2], 10); }
  }

  if (stashR.code === 0) out.stashCount = (stashR.stdout || '').split('\n').filter(Boolean).length;

  // Dirty files older than threshold — bounded at 50 to avoid monorepo death.
  if (dirtyR.code === 0 && !deadlineFn()) {
    const lines = (dirtyR.stdout || '').split('\n').filter(Boolean).slice(0, 50);
    const files = lines.map(l => l.slice(3)).filter(Boolean);
    const thresholdSec = Math.floor(Date.now() / 1000) - 24 * 3600;
    const ageResults = await Promise.all(files.map(async f => {
      const r = await runCmd('git', ['log', '-1', '--format=%ct', '--', f], cwd, 600);
      if (r.code !== 0) return null;
      const ts = parseInt((r.stdout || '').trim(), 10);
      if (!Number.isFinite(ts)) return null;
      if (ts > thresholdSec) return null;
      const ageDays = Math.floor((Date.now() / 1000 - ts) / 86400);
      return { file: f, ageDays };
    }));
    out.dirtyOld = ageResults.filter(Boolean).sort((a, b) => b.ageDays - a.ageDays);
  }

  // Branch age = how stale the current branch tip is vs now (not vs main).
  // Cheaper than computing merge-base + log.
  const tipR = await runCmd('git', ['log', '-1', '--format=%ct'], cwd, 800);
  if (tipR.code === 0) {
    const ts = parseInt((tipR.stdout || '').trim(), 10);
    if (Number.isFinite(ts)) out.branchAgeDays = Math.floor((Date.now() / 1000 - ts) / 86400);
  }

  return out;
}

// ─── gh probes ─────────────────────────────────────────────────────────────

function parseGhJson(stdout) {
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { /* non-JSON gh output: treat as null */ return null; }
}

async function ghAvailable(cwd) {
  const r = await runCmd('gh', ['auth', 'status'], cwd, 1500);
  return r.code === 0;
}

async function gatherGh(cwd, deadlineFn) {
  if (deadlineFn()) return null;
  const [openR, ciR, reviewR] = await Promise.all([
    runCmd('gh', ['pr', 'list', '--author', '@me', '--limit', '5', '--json', 'number,title,isDraft'], cwd, CMD_TIMEOUT_MS),
    runCmd('gh', ['run', 'list', '-L', '1', '--json', 'status,conclusion,workflowName,createdAt,headBranch'], cwd, CMD_TIMEOUT_MS),
    runCmd('gh', ['pr', 'list', '--search', 'review-requested:@me', '--limit', '5', '--json', 'number,title'], cwd, CMD_TIMEOUT_MS),
  ]);
  return {
    openPRs: openR.code === 0 ? (parseGhJson(openR.stdout) || []) : null,
    lastCi: ciR.code === 0 ? ((parseGhJson(ciR.stdout) || [])[0] || null) : null,
    reviewRequests: reviewR.code === 0 ? (parseGhJson(reviewR.stdout) || []) : null,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

function relTime(iso) {
  if (!iso) return '?';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '?';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatSnapshot({ local, gh, max = 5 }) {
  const lines = ['## Project snapshot'];

  if (local) {
    if (local.branch) {
      const age = local.branchAgeDays == null ? '?' : `${local.branchAgeDays}d`;
      lines.push(`- **Branch:** ${local.branch} (tip ${age} old)`);
    }
    if (local.ahead || local.behind) {
      lines.push(`- **vs main:** ${local.ahead} ahead, ${local.behind} behind`);
    }
    if (local.dirtyOld && local.dirtyOld.length) {
      const shown = local.dirtyOld.slice(0, max).map(d => `${d.file} (${d.ageDays}d)`).join(', ');
      const more = local.dirtyOld.length > max ? ` (+${local.dirtyOld.length - max} more)` : '';
      lines.push(`- **Dirty >24h:** ${shown}${more}`);
    }
    if (local.stashCount > 0) lines.push(`- **Stashes:** ${local.stashCount}`);
  }

  if (gh) {
    if (gh.lastCi) {
      const ci = gh.lastCi;
      const icon = ci.conclusion === 'success' ? '✓'
        : ci.conclusion === 'failure' || ci.conclusion === 'cancelled' ? '✗'
        : ci.status === 'in_progress' || ci.status === 'queued' ? '⏳'
        : '·';
      lines.push(`- **Last CI:** ${icon} ${ci.workflowName || 'run'} on ${ci.headBranch || '?'} ${relTime(ci.createdAt)}`);
    }
    if (Array.isArray(gh.openPRs) && gh.openPRs.length) {
      const shown = gh.openPRs.slice(0, max).map(p => `#${p.number}${p.isDraft ? '(draft)' : ''} ${p.title}`).join(' · ');
      const more = gh.openPRs.length > max ? ` (+${gh.openPRs.length - max})` : '';
      lines.push(`- **Open PRs (yours):** ${shown}${more}`);
    }
    if (Array.isArray(gh.reviewRequests) && gh.reviewRequests.length) {
      const shown = gh.reviewRequests.slice(0, max).map(p => `#${p.number} ${p.title}`).join(' · ');
      lines.push(`- **Reviews requested:** ${shown}`);
    }
  }

  if (lines.length === 1) return ''; // header only → omit entirely
  let md = lines.join('\n');
  if (md.length > HARD_CHAR_LIMIT) md = md.slice(0, HARD_CHAR_LIMIT - 13) + '\n…[truncated]';
  return md;
}

function emitContext(md, eventName) {
  if (!md) return emitEmpty();
  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: md,
    },
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) return emitEmpty();

  const raw = await readStdin();
  const event = parsePayload(raw) || {};
  const eventName = event.hook_event_name || 'SessionStart';
  const cwd = event.cwd || process.cwd();

  // Only act when we're in a git repo — else native block isn't there anyway.
  const inRepo = await runCmd('git', ['rev-parse', '--is-inside-work-tree'], cwd, 800);
  if (inRepo.code !== 0 || (inRepo.stdout || '').trim() !== 'true') return emitEmpty();

  const cached = readCache(cwd, cfg.cacheTtlSeconds);
  if (cached) return emitContext(cached, eventName);

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const deadlineFn = () => Date.now() > deadline;

  const local = await gatherLocal(cwd, deadlineFn);

  let gh = null;
  if (cfg.includeGh !== false && !deadlineFn()) {
    const wantGh = cfg.includeGh === true || (cfg.includeGh === 'auto' && await ghAvailable(cwd));
    if (wantGh && !deadlineFn()) gh = await gatherGh(cwd, deadlineFn);
  }

  const md = formatSnapshot({ local, gh, max: cfg.maxItemsPerSection });
  if (md) writeCache(cwd, md);
  emitContext(md, eventName);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[project-snapshot] crashed: ${err.message}`);
    emitEmpty();
  });
}

// Exports for unit tests.
module.exports = { formatSnapshot, parseGhJson, relTime, loadConfig };
