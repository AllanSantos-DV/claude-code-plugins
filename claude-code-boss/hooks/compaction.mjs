// Controlled compaction — a Claude Code function-hook module (hooks.json "modules").
//
// WHEN: never on its own, and never with a warm cache. When the person sends a prompt with
// the session idle, if the context is past the threshold (a % of the window the engine
// applies now — 200K and 1M models alike) and the provider cache has already gone cold, the
// prompt is held, the engine's /compact runs, and the same text is sent again as the
// person's. Inputs the gate cannot hold (a peer message, a task notification) are covered by the
// same cold cut done before they arrive: at the end of every turn once the cache goes cold, and
// when a session is reopened over a cold history. If the cache never cools, the engine's own
// auto-compaction runs at its limit — through the same choice. WHAT: our pruning (scripts/lib/compaction-core.mjs: text intact, stale
// tool results truncated) when it cuts >= 85%; else, with a COLD cache and not a person's /compact,
// the model-free brief (user text verbatim, one line per tool call, a 2k verbatim tail); else the
// engine's own summary. FOLDER TTL: every session reports whether it is past the threshold; while
// all live sessions of its launch folder are, the daemon switches that folder's cache TTL to 5m
// (scripts/lib/folder-ttl.js), so the cache cools in 5 min and the cut comes; restored after it.
// RESUME: `--resume`/`-c` reload the ORIGINAL history after a hook compaction (engine
// behavior, measured); the first prompt re-prunes it before anything is sent. A resumed
// session's cache counts as cold (its first request re-writes everything), so past the threshold
// the first prompt is cut instead of re-writing the whole history.
//
// Engine rules this shape follows (Claude Code 2.1.291, measured — BACKLOG Q35):
//   - session.compact is refused inside prompt.submit → hold ({drop}), compact, re-send;
//   - $.session.compact() skips the caller's own session.compact hook → /compact via
//     $.command.run, which raises it for every hook (ours included);
//   - a plugin's own $.prompt.submit skips its own hook → no loop;
//   - interactive: session.measure carries no tokens, usage() does (headless: reverse).
// Observability: every decision and cut goes to the boss metrics store through the
// daemon (POST /hook/compaction-event → tool hook_compaction_event → scripts/compaction-event.js).

import { daemon as sharedDaemon } from '../scripts/lib/module-daemon.mjs';
import { planCompaction, buildBrief, decideTiming, decideTurnEnd, classifyResume, estimateTokens, thresholdFor, fallbackWindow, chooseCompaction, isCacheWarm, isMechanicalCut, resumedAnswerAt, decidePhaseRestart, lastTurnDelivered, phaseRestartNotice, describeFailure, compactResultError, DEFAULTS } from '../scripts/lib/compaction-core.mjs';

// Kept equal to package.json by scripts/sync-version.js. The daemon compares it with the installed plugin: a session
// started before an update keeps running this file, so the person is told to reopen it.
const MODULE_VERSION = '3.13.0';

const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk']);
// Folder TTL (scripts/lib/folder-ttl.js): the daemon drops a session that stops reporting for 5 min; this keeps an
// idle but open session counted.
const FOLDER_HEARTBEAT_MS = 2 * 60000;
// A cut of ours the engine refuses reaches compactFailed right after the hook answers; its run event waits this long for it.
const ACCEPT_WAIT_MS = 2000;

function newCtx() {
  return {
    config: { ...DEFAULTS },
    configLoaded: false,
    daemon: null,           // { base, token } of the brain daemon
    identity: null,         // { host, auth } — never a secret value
    busy: false,
    gated: false,            // a person's prompt went through the gate in the current turn
    interactive: true,       // session.start says; headless (-p/SDK) cannot compact from a plugin
    lastAnswerAt: undefined,
    lastCompactAt: undefined,
    measuredTokens: undefined,
    sessionTtlMs: undefined, // window proved by THIS session's cache writes
    hostTtlMs: undefined,    // window observed for this host across sessions
    transcriptPath: '',
    start: null,             // classic SessionStart: { source, lastTokens, secondsSince }
    resumeChecked: false,
    compactReason: null,     // why the next compaction runs (set by the gate)
    pendingSettle: null,     // a compaction whose effect the next turn measures
    lastMessageId: null,     // newest API call already recorded as cache.turn
    turnEndTimer: 0,         // token of the pending turn-end re-check (a newer one supersedes)
    holding: false,          // this process holds a person's prompt for the cut (its copy on disk is live, not an orphan)
    turnEndWaitTtlMs: 0,     // the TTL the pending turn-end re-check was armed with (0 = none pending)
    folder: null,            // the launch cwd: the folder whose .claude/settings.local.json this session reads
    folderAbove: false,      // past the threshold at the last look (what the folder report says)
    folderTtl: null,         // the daemon's last answer for this folder ({ttl, live, allAbove, action})
    heartbeat: false,        // the folder heartbeat loop is running
    // A compaction ran and no API call has been seen since: every size reading is still the pre-cut one (E2E 14/10:
    // the gate compacted the just-cut session again from it). No new compaction until a real call is observed.
    awaitCallAfterCut: false,
    phaseNotified: false,    // the phase-restart notice was given for the current crossing of its threshold
    model: null,             // the transcript's last call's model (window fallback when the engine reports none)
    tailTokens: undefined,   // the transcript's size reading, same use
    staleWarned: false,      // the "old Boss in this session" notice was given
    resumeAnswer: null,      // { synthetic, real }: lastAnswerAt is aged on resume (resumedAnswerAt); the trail says the real one
    coldLoggedFor: null,     // the lastAnswerAt whose cache expiry is already recorded
    noTranscriptSaid: false, // the heartbeat's no-transcript notice was shown
    coldTimer: 0,            // token of the pending expiry timer (a newer answer supersedes)
    coldWatchTtlMs: 0,       // the TTL that timer was armed with
    compactSeq: 0,
    run: null,               // the current compaction's run event: { id, t0, state, ours, data, emitted }
  };
}

// The daemon's address and local token (scripts/lib/module-daemon.mjs, shared with hooks/boss.mjs).
const daemon = ($, ctx, refresh = false) => sharedDaemon($, ctx, refresh, 'compaction');

async function identity($, ctx) {
  if (ctx.identity) return ctx.identity;
  // "0" is set and OFF (seen live: all three = "0" behind a gateway) — only 1/true/yes turn one on.
  const on = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());
  const provider = on(await $.env.get('CLAUDE_CODE_USE_BEDROCK')) ? 'bedrock'
    : on(await $.env.get('CLAUDE_CODE_USE_VERTEX')) ? 'vertex'
      : on(await $.env.get('CLAUDE_CODE_USE_FOUNDRY')) ? 'foundry' : null;
  let host = provider;
  if (!host) {
    const base = await $.env.get('ANTHROPIC_BASE_URL');
    try { host = base ? new URL(base).host : 'api.anthropic.com'; } catch (err) { host = `invalid-base-url(${String(err).slice(0, 40)})`; }
  }
  const cred = await $.session.authorize();
  ctx.identity = { host, auth: cred ? cred.kind : 'none' };
  return ctx.identity;
}

// One event to the daemon. Replies the parsed JSON; a degraded daemon reply throws.
async function send($, ctx, kind, data) {
  const args = {
    session_id: await $.session.id(),
    cwd: await $.session.cwd(),
    project_dir: await $.session.root(),
    transcript_path: ctx.transcriptPath || '',
    payload: JSON.stringify({ kind, ...data }),
  };
  const post = async (d) => $.http.fetch(`${d.base}/hook/compaction-event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` }, body: JSON.stringify(args),
  });
  let r = await post(await daemon($, ctx));
  if (r.status === 401) r = await post(await daemon($, ctx, true)); // the daemon restarted with a new token
  if (!r.ok) throw new Error(`hook_compaction_event ${kind}: daemon answered ${r.status} ${String(r.text).slice(0, 200)}`);
  const out = r.text ? JSON.parse(r.text) : {};
  if (out.systemMessage) throw new Error(out.systemMessage); // the hook degraded in the daemon (visible)
  return out;
}

// Trail events never block the session; a failure is said, never swallowed.
function emit($, ctx, kind, data) {
  send($, ctx, kind, data).catch((err) => $.ui.log(`compaction: ${kind} event not recorded: ${String(err && err.message ? err.message : err)}`));
}

function noteVersion($, ctx, reply) {
  const installed = reply && reply.installedVersion;
  if (!installed || installed === MODULE_VERSION || ctx.staleWarned) return;
  ctx.staleWarned = true;
  const text = `Boss: this session runs an old Boss (${MODULE_VERSION}) and ${installed} is installed — reopen the session to activate the fixes`;
  $.ui.toast(text);
  $.ui.log(`compaction: ${text}`);
}

function applyTtl(ctx, reply) {
  if (reply && reply.ttl && Number(reply.ttl.observedMs) > 0) ctx.hostTtlMs = Number(reply.ttl.observedMs);
  const seen = reply && reply.observed && Number(reply.observed.ttlMs);
  // The LATEST call's window, not the longest seen: the folder TTL switches 1h → 5m mid-session, and the cache
  // a call just wrote lives by that call's window (a max kept judging it by 1h and never cut at 5 min).
  if (seen > 0) ctx.sessionTtlMs = seen;
}

/**
 * Tell the daemon whether this session is past the threshold, for its launch folder's shared TTL
 * (scripts/lib/folder-ttl.js). Interactive sessions only (headless ones cannot compact from a plugin).
 * @param {object} $  the module's ops
 * @param {object} ctx  per-session state
 * @param {{end?: boolean}} [opts]  end = the session is closing (leaves the folder)
 */
async function reportFolder($, ctx, { end = false } = {}) {
  if (!ctx.folder || !ctx.interactive || !ctx.configLoaded) return;
  if (ctx.config.folderTtl === false) {
    // The feature was turned off: a folder left at 5m by the time it was on would stay there for good, because no session
    // reports any more (and the daemon sweeps only on a report). Leave the folder once, so the daemon restores what is ours.
    if (ctx.folderOffReleased) return;
    ctx.folderOffReleased = true;
    end = true;
  }
  const reply = await send($, ctx, end ? 'folder-end' : 'folder', { folder: ctx.folder, above: ctx.folderAbove });
  ctx.folderTtl = reply.folderTtl || null;
  if (ctx.folderTtl && ctx.folderTtl.action === 'error') $.ui.log(`compaction: folder TTL not managed: ${ctx.folderTtl.detail}`);
}

/**
 * Update "past the threshold" from the calls an observation just recorded. The size is the LAST REAL API call
 * (input + cache read + cache write), not usage(): a prompt the gate held closes a turn with no call, and usage()
 * then still says the pre-cut size (E2E 14/10: a cut session re-claimed "above" and kept its folder at 5m). No new
 * call → the last verdict stands. A real call also ends the post-cut wait (awaitCallAfterCut).
 */
async function folderFromReply($, ctx, reply) {
  if (!reply || !(reply.recorded > 0)) return;
  ctx.awaitCallAfterCut = false; // a real call after the cut: readings are fresh
  const o = reply.observed;
  if (!o || !ctx.folder || ctx.config.folderTtl === false) return;
  try {
    const { thr } = await currentWindow($, ctx);
    const tokens = (Number(o.input) || 0) + (Number(o.read) || 0) + (Number(o.write) || 0);
    ctx.folderAbove = thr.thresholdTokens != null && tokens >= thr.thresholdTokens;
  } catch (err) { $.ui.log(`compaction: folder threshold check failed: ${String(err && err.message ? err.message : err)}`); }
}

// Every 2 min: pick up the calls that landed in the transcript after their turn ended (interactive: the answer's
// row arrives after turn.complete, so the turn-end look often sees nothing new — E2E 14/10: the switch waited a turn),
// then report — which also keeps an idle, open session counted in its folder.
function startHeartbeat($, ctx) {
  if (ctx.heartbeat || !ctx.interactive || ctx.config.folderTtl === false) return;
  ctx.heartbeat = true;
  const beat = () => $.clock.after(FOLDER_HEARTBEAT_MS, () => {
    (async () => {
      if (ctx.transcriptPath) { const { reply } = await observeCalls($, ctx); await folderFromReply($, ctx, reply); }
      else if (!ctx.noTranscriptSaid) { // once per session: the same sentence every 2 min is noise, the first one is the signal
        ctx.noTranscriptSaid = true;
        $.ui.log('compaction: folder heartbeat has no transcript path (classic SessionStart not seen) — calls not observed');
      }
      if (ctx.coldWatchTtlMs && ttlInUse(ctx).ttlMs !== ctx.coldWatchTtlMs) await watchCold($, ctx);
      await reportFolder($, ctx);
      // A turn-end re-check armed by the 1h window while the turn's 5m writes had not landed yet would wait the hour
      // and the next message would re-write a cold cache: re-judge it now by the shorter window.
      if (ctx.turnEndWaitTtlMs && ttlInUse(ctx).ttlMs < ctx.turnEndWaitTtlMs) await turnEnd($, ctx);
    })().catch((err) => $.ui.log(`compaction: folder heartbeat failed: ${String(err && err.message ? err.message : err)}`)).finally(beat);
  });
  beat();
}

function ttlInUse(ctx) {
  if (ctx.sessionTtlMs) return { ttlMs: ctx.sessionTtlMs, ttlSource: 'session' };
  if (ctx.hostTtlMs) return { ttlMs: ctx.hostTtlMs, ttlSource: 'host' };
  return { ttlMs: ctx.config.unknownTtlMs, ttlSource: 'unknown-assumed-longest' };
}

/**
 * The prompt cache at `now` as the compaction rules judge it: warm while a turn runs (its own calls keep it) or within the
 * TTL of the last answer; 'unknown' without an answer time (the rules then assume warm — isCacheWarm). The age is the real
 * one: after a resume the rules age lastAnswerAt on purpose (`resumed: true`), the trail does not.
 */
function cacheState(ctx, now) {
  const { ttlMs, ttlSource } = ttlInUse(ctx);
  const known = ctx.lastAnswerAt != null;
  const resumed = known && ctx.resumeAnswer != null && ctx.resumeAnswer.synthetic === ctx.lastAnswerAt;
  const answerAt = resumed ? ctx.resumeAnswer.real : known ? ctx.lastAnswerAt : null;
  const cache = ctx.busy ? 'warm' : !known ? 'unknown' : isCacheWarm({ now, lastAnswerAt: ctx.lastAnswerAt, ttlMs }) ? 'warm' : 'cold';
  return {
    cache, warmBy: ctx.busy ? 'mid-turn' : cache === 'warm' ? 'ttl' : null, resumed,
    lastAnswerAt: answerAt, idleMs: answerAt == null ? null : now - answerAt, ttlMs, ttlSource,
  };
}

/**
 * One `compaction.cold` per answer whose cache expired, said by whoever sees it first: the timer armed after the turn
 * (it dies with the process), the next input of any origin, the reopen of the session, or a compaction. A reopened
 * process can say again an expiry its previous run already said: the report counts one per session and answer.
 */
async function noteCold($, ctx, detectedBy, extra = {}) {
  try {
    if (!ctx.configLoaded || !ctx.config.enabled || ctx.busy || ctx.lastAnswerAt == null || ctx.coldLoggedFor === ctx.lastAnswerAt) return;
    const now = await $.clock.now();
    const s = cacheState(ctx, now);
    if (s.cache !== 'cold') return;
    ctx.coldLoggedFor = ctx.lastAnswerAt;
    const { context } = await $.session.usage();
    const tokens = context.tokens ?? ctx.measuredTokens ?? ctx.tailTokens ?? (ctx.start && ctx.start.lastTokens > 0 ? ctx.start.lastTokens : null);
    const tokensSource = context.tokens != null ? 'session' : ctx.measuredTokens != null ? 'measure' : ctx.tailTokens != null ? 'transcript' : tokens != null ? 'session-start' : null;
    emit($, ctx, 'cold', {
      detectedBy, answerAt: s.lastAnswerAt, coldAt: s.lastAnswerAt == null ? null : s.lastAnswerAt + s.ttlMs, idleMs: s.idleMs,
      ttlMs: s.ttlMs, ttlSource: s.ttlSource, resumed: s.resumed, tokens, tokensSource, ...extra,
    });
  } catch (err) { $.ui.log(`compaction: cache-cold event not recorded: ${String(err && err.message ? err.message : err)}`); }
}

// The expiry timer of the current answer (re-armed by a newer answer or a changed TTL).
async function watchCold($, ctx) {
  if (!ctx.interactive || ctx.lastAnswerAt == null || ctx.coldLoggedFor === ctx.lastAnswerAt) return;
  const { ttlMs } = ttlInUse(ctx);
  const token = ++ctx.coldTimer;
  const answerAt = ctx.lastAnswerAt;
  ctx.coldWatchTtlMs = ttlMs;
  const dueIn = Math.max(0, answerAt + ttlMs - (await $.clock.now()));
  $.clock.after(dueIn + 1000, () => { if (token === ctx.coldTimer && answerAt === ctx.lastAnswerAt) void noteCold($, ctx, 'timer'); });
}

async function hello($, ctx) {
  const id = await identity($, ctx);
  const reply = await send($, ctx, 'hello', { ...id, source: ctx.start ? ctx.start.source : null, moduleVersion: MODULE_VERSION });
  noteVersion($, ctx, reply);
  if (reply.config) {
    ctx.config = { ...DEFAULTS, ...reply.config };
    ctx.configLoaded = true;
  }
  applyTtl(ctx, reply);
}

async function ensureConfig($, ctx) {
  if (ctx.configLoaded) return;
  try { await hello($, ctx); } catch (err) {
    // Never act on defaults: the user may have switched compaction off (slider, free profile).
    $.ui.log(`compaction: boss config unreachable — not acting this time: ${String(err && err.message ? err.message : err)}`);
  }
}

// Records every API call the transcript holds since the last one seen (cache.turn, per call).
async function observeCalls($, ctx) {
  const id = await identity($, ctx);
  const reply = await send($, ctx, 'turn', { ...id, sinceMessageId: ctx.lastMessageId });
  if (reply.lastMessageId) ctx.lastMessageId = reply.lastMessageId;
  if (reply.config) { ctx.config = { ...DEFAULTS, ...reply.config }; ctx.configLoaded = true; } // slider changes, live
  noteVersion($, ctx, reply);
  applyTtl(ctx, reply);
  return { id, reply };
}

async function afterTurn($, ctx) {
  try {
    const settle = ctx.pendingSettle;
    ctx.pendingSettle = null;
    const { id, reply } = await observeCalls($, ctx);
    await folderFromReply($, ctx, reply);
    if (ctx.interactive && ctx.config.folderTtl !== false && ctx.folder) {
      try { await reportFolder($, ctx); } catch (err) {
        $.ui.log(`compaction: folder TTL report failed: ${String(err && err.message ? err.message : err)}`);
      }
      startHeartbeat($, ctx);
    }
    await watchCold($, ctx); // after the observation: the TTL is the one this turn's writes proved
    if (settle) {
      const { context } = await $.session.usage();
      const after = context.tokens ?? ctx.measuredTokens ?? null;
      // The cache price of the first call after the compaction is in cache.turn (afterCompaction,
      // marked from the transcript) — its row may land after this turn.complete (interactive).
      emit($, ctx, 'settled', {
        reason: settle.reason, trigger: settle.trigger, prevented: settle.prevented === true, tokensBefore: settle.tokensBefore, tokensAfter: after,
        tokensCut: settle.tokensBefore != null && after != null ? settle.tokensBefore - after : null,
        host: id.host, auth: id.auth,
      });
    }
  } catch (err) {
    $.ui.log(`compaction: turn observation failed: ${String(err && err.message ? err.message : err)}`);
  }
}

async function compactThenResend($, ctx, text, reason) {
  ctx.compactReason = reason;
  try { await cutAndResend($, ctx, text, reason); } finally { ctx.holding = false; }
}

async function cutAndResend($, ctx, text, reason) {
  try {
    // Not $.session.compact(): it skips our own session.compact hook (the engine's summary would run).
    await $.command.run({ command: 'compact' });
    ctx.lastCompactAt = await $.clock.now();
  } catch (err) {
    $.ui.log(`compaction: compacting before the prompt failed, sending it anyway: ${String(err && err.message ? err.message : err)}`);
    emit($, ctx, 'error', { where: 'command.run compact', reason, error: String(err && err.message ? err.message : err) });
  }
  ctx.compactReason = null;
  try {
    await $.prompt.submit({ text, asUser: true }); // never lose the person's prompt
    // Sent: the copy kept for a session that dies during the cut is no longer needed. Kept on a failure to clear.
    await send($, ctx, 'held-clear', {}).catch((err) => $.ui.log(`compaction: held prompt copy not removed: ${String(err && err.message ? err.message : err)}`));
  } catch (err) {
    // The original was already dropped: hand the text back in the log so nothing is lost.
    $.ui.log(`compaction: could not re-send your prompt (${String(err && err.message ? err.message : err)}) — here it is:
${text}`);
    emit($, ctx, 'error', { where: 'prompt.submit resend', reason, error: String(err && err.message ? err.message : err), chars: text.length });
  }
}

function scheduleCompactThenResend($, ctx, text, reason) {
  compactThenResend($, ctx, text, reason).catch((err) => $.ui.log(`compaction: re-send failed: ${String(err && err.message ? err.message : err)}`));
}

// The window the engine applies NOW and the threshold it gives (shared by the prompt gate and the turn-end rule).
async function currentWindow($, ctx) {
  const { context } = await $.session.usage({ breakdown: 'summary' });
  const bd = context.breakdown || {};
  let windowTokens = Number(bd.rawMaxTokens) > 0 ? Number(bd.rawMaxTokens) : context.window;
  let windowSource = Number(bd.rawMaxTokens) > 0 ? (bd.autocompactSource || null) : 'model-window';
  if (!(Number(windowTokens) > 0)) {
    ({ window: windowTokens, source: windowSource } = fallbackWindow({
      model: ctx.model, tokens: context.tokens ?? ctx.measuredTokens ?? ctx.tailTokens ?? (ctx.start && ctx.start.lastTokens > 0 ? ctx.start.lastTokens : null),
    }));
  }
  const engineAutoCompactAt = bd.isAutoCompactEnabled === false ? null : (Number(bd.autoCompactThreshold) > 0 ? Number(bd.autoCompactThreshold) : null);
  const thr = thresholdFor({ window: windowTokens, engineAutoCompactAt }, ctx.config);
  return { context, windowTokens, windowSource, engineAutoCompactAt, thr };
}

// End of every turn (and the reopen of a session): past the threshold, compact once the cache is COLD (waiting for it,
// never compacting a warm one), so the cut is done before whatever comes next — a peer message, a task notification or a
// queued command is never seen by the prompt gate (it cannot be held and re-sent with its sender). Nothing is held or
// re-sent. `trigger` 'reopen' only names the cut in the trail.
async function turnEnd($, ctx, trigger = 'turn-end') {
  ctx.turnEndWaitTtlMs = 0;
  try {
    if (!ctx.interactive || !ctx.configLoaded || !ctx.config.enabled) return;
    if (ctx.awaitCallAfterCut) return; // just compacted: the size reading is the pre-cut one
    const now = await $.clock.now();
    const { context, windowTokens, windowSource, engineAutoCompactAt, thr } = await currentWindow($, ctx);
    const tokens = context.tokens ?? ctx.measuredTokens ?? ctx.tailTokens ?? (ctx.start && ctx.start.lastTokens > 0 ? ctx.start.lastTokens : undefined);
    const { ttlMs, ttlSource } = ttlInUse(ctx);
    const d = decideTurnEnd({ tokens, now, lastAnswerAt: ctx.lastAnswerAt, lastCompactAt: ctx.lastCompactAt, busy: ctx.busy, gated: false, ttlMs }, { ...ctx.config, thresholdTokens: thr.thresholdTokens });
    if (d.action === 'compact' && trigger === 'reopen') d.reason = 'reopen-cache-cold';
    if (d.action === 'wait') {
      // Over the threshold with a warm cache: never compact it. Re-check when the cache is due
      // to be cold (a newer turn moves lastAnswerAt, so the re-check then waits again or stands down).
      const token = ++ctx.turnEndTimer;
      ctx.turnEndWaitTtlMs = ttlMs;
      emit($, ctx, 'gate', {
        action: d.action, reason: d.reason, dueInMs: d.dueInMs, tokens: tokens ?? null, idleMs: now - ctx.lastAnswerAt, ttlMs, ttlSource,
        thresholdPercent: thr.percent, thresholdTokens: thr.thresholdTokens, windowTokens: windowTokens ?? null, windowSource,
        engineAutoCompactAt, thresholdAboveEngine: thr.aboveEngine,
      });
      $.clock.after(d.dueInMs + 1000, () => { if (token === ctx.turnEndTimer) void turnEnd($, ctx); });
      return;
    }
    if (d.action !== 'compact') return;
    ctx.turnEndTimer++; // a compaction supersedes any pending re-check
    emit($, ctx, 'gate', {
      action: d.action, reason: d.reason, dueInMs: null, tokens: tokens ?? null, idleMs: ctx.lastAnswerAt == null ? null : now - ctx.lastAnswerAt, ttlMs, ttlSource,
      thresholdPercent: thr.percent, thresholdTokens: thr.thresholdTokens, windowTokens: windowTokens ?? null, windowSource,
      engineAutoCompactAt, thresholdAboveEngine: thr.aboveEngine,
    });
    ctx.pendingSettle = { reason: d.reason, trigger, tokensBefore: tokens ?? null };
    ctx.compactReason = d.reason;
    ctx.resumeChecked = true; // the resumed history is the one being cut: the gate must not cut it again
    try {
      await $.command.run({ command: 'compact' });
      ctx.lastCompactAt = await $.clock.now();
    } finally { ctx.compactReason = null; }
  } catch (err) {
    $.ui.log(`compaction: turn-end compaction failed: ${String(err && err.message ? err.message : err)}`);
    emit($, ctx, 'error', { where: 'turn-end compact', error: String(err && err.message ? err.message : err) });
  }
}

// A session the module has seen no turn of (reopened after hours, resumed, SessionStart never delivered) has no
// answer time and may have no live size: the transcript knows both (the daemon reads it; records nothing).
async function transcriptTail($, ctx) {
  try { return (await send($, ctx, 'tail', {})).tail || null; } catch (err) {
    $.ui.log(`compaction: transcript reading failed, the gate has no age/size for this session: ${String(err && err.message ? err.message : err)}`);
    return null;
  }
}

// A session opened over an existing history (resume, or a startup on an old transcript) is judged right away, before any
// input: its first input is often a peer message, which the gate lets through — the whole cold history re-written.
// The look comes first so the folder join already carries the session's real side of the threshold (a warm reopen is
// above it); a cold one is about to be cut, so it does not claim "above" for the seconds the cut takes.
async function reopenLook($, ctx) {
  if (!ctx.interactive || !ctx.configLoaded || !ctx.config.enabled) return null;
  if (ctx.start && ctx.start.source === 'compact') return null;
  const tail = await transcriptTail($, ctx);
  if (!tail) return null; // no call yet: a new session, nothing to cut
  if (tail.model) ctx.model = tail.model;
  if (tail.tokens != null) ctx.tailTokens = tail.tokens;
  if (ctx.lastAnswerAt == null && tail.at != null) ctx.lastAnswerAt = tail.at;
  try {
    const { context, thr } = await currentWindow($, ctx);
    const tokens = context.tokens ?? ctx.measuredTokens ?? tail.tokens;
    const warm = isCacheWarm({ now: await $.clock.now(), lastAnswerAt: ctx.lastAnswerAt, ttlMs: ttlInUse(ctx).ttlMs });
    ctx.folderAbove = thr.thresholdTokens != null && tokens != null && tokens >= thr.thresholdTokens && warm;
  } catch (err) { $.ui.log(`compaction: folder threshold at reopen failed: ${String(err && err.message ? err.message : err)}`); }
  return tail;
}

// Join the folder (below or at its real side of the threshold): a folder switched to 5m by the others goes back to 1h.
async function joinFolder($, ctx) {
  if (!ctx.folder) return;
  try { await reportFolder($, ctx); startHeartbeat($, ctx); } catch (err) { $.ui.log(`compaction: folder join failed: ${String(err && err.message ? err.message : err)}`); }
}

// The prompt a previous run of this session held for the cut and never re-sent (the session closed during the /compact).
async function recoverHeld($, ctx) {
  if (!ctx.configLoaded || ctx.holding) return;
  const { held } = await send($, ctx, 'held-recover', {});
  if (!held || !held.text) return;
  $.ui.toast('Boss: your last prompt was held for a cut when this session closed and never sent — it is in the log, copy it back if you still want it');
  $.ui.log(`compaction: your last prompt never went out (the session closed during the cut) — here it is:\n${held.text}`);
}

async function gate($, ctx, e, next) {
  if (!e.turnId) await noteCold($, ctx, 'next-input', { input: (e.origin && e.origin.kind) || null });
  if (e.turnId || !PERSON_ORIGINS.has(e.origin && e.origin.kind)) return next(e);
  // Headless (-p/SDK): the engine refuses a plugin's compaction ("not available in a headless
  // session yet") — holding the prompt there would only delay it. Manual /compact and the
  // engine's auto threshold still go through session.compact below (pruning, or the engine's
  // summary when the cache is warm).
  if (!ctx.interactive) return next(e);
  ctx.gated = true; // this turn is a person's: the gate judges it, the turn-end rule stays out
  await ensureConfig($, ctx);
  // No config from the boss = don't act (pre-release audit 3.1.0: defaults said "on" even when
  // the user had switched it off and the daemon was just not up yet).
  if (!ctx.configLoaded || !ctx.config.enabled) return next(e);

  const now = await $.clock.now();
  // The window the engine applies NOW (the model's limit or a smaller compaction window) and
  // its own auto-compact point — a local estimate, no API call. The model window as fallback.
  let { context, windowTokens, windowSource, engineAutoCompactAt, thr } = await currentWindow($, ctx);
  let tokens = context.tokens ?? ctx.measuredTokens ?? (ctx.start && ctx.start.lastTokens > 0 ? ctx.start.lastTokens : undefined);
  let tokensSource = context.tokens != null ? 'session' : ctx.measuredTokens != null ? 'measure' : tokens != null ? 'session-start' : null;
  let ageSource = ctx.lastAnswerAt == null ? null : 'session';
  if (tokens == null || ctx.lastAnswerAt == null) {
    const tail = await transcriptTail($, ctx);
    if (tail) {
      if (tail.model) ctx.model = tail.model;
      if (tail.tokens != null) ctx.tailTokens = tail.tokens;
      // The engine gave no window: the transcript's model and size sharpen the fallback guess.
      if (String(windowSource).startsWith('fallback')) ({ windowTokens, windowSource, engineAutoCompactAt, thr } = await currentWindow($, ctx));
      if (ctx.lastAnswerAt == null && tail.at != null) { ctx.lastAnswerAt = tail.at; ageSource = 'transcript'; }
      if (tokens == null && tail.tokens != null) { tokens = tail.tokens; tokensSource = 'transcript'; }
    }
  }
  const { ttlMs, ttlSource } = ttlInUse(ctx);
  let d;
  if (ctx.start && ctx.start.source === 'resume' && !ctx.resumeChecked) {
    ctx.resumeChecked = true;
    const reloadedMsgs = await $.session.messages();
    if (tokens == null) { tokens = estimateTokens(reloadedMsgs); tokensSource = 'reloaded-history'; }
    const r = classifyResume({ messages: reloadedMsgs, lastTokens: ctx.start.lastTokens });
    emit($, ctx, 'resume', { ...r, messages: reloadedMsgs.length, secondsSince: ctx.start.secondsSince ?? null });
    d = r.reexpanded ? { action: 'compact', reason: 'resume-reexpanded' } : null;
  }
  if (!d && ctx.awaitCallAfterCut) d = { action: 'none', reason: 'just-compacted' }; // the reading is the pre-cut size
  if (!d) d = decideTiming({ tokens, now, lastAnswerAt: ctx.lastAnswerAt, lastCompactAt: ctx.lastCompactAt, busy: false, ttlMs }, { ...ctx.config, thresholdTokens: thr.thresholdTokens });
  const idleMs = ctx.lastAnswerAt == null ? null : now - ctx.lastAnswerAt;
  emit($, ctx, 'gate', {
    action: d.action, reason: d.reason, dueInMs: d.dueInMs ?? null, tokens: tokens ?? null, tokensSource, ageSource, idleMs, ttlMs, ttlSource,
    thresholdPercent: thr.percent, thresholdTokens: thr.thresholdTokens, windowTokens: windowTokens ?? null, windowSource,
    engineAutoCompactAt, thresholdAboveEngine: thr.aboveEngine,
  });

  if (d.action !== 'compact') return phaseRestart($, ctx, e, next, { tokens, now, ttlMs });
  if (e.attachments && e.attachments.length) {
    emit($, ctx, 'gate', { action: 'pass', reason: 'attachments-would-be-lost', tokens: tokens ?? null, idleMs, ttlMs, ttlSource });
    // Said, not silent: the engine cannot re-send attachments, so this prompt goes on over the cold history; the turn-end
    // rule (this turn is not 'held') cuts as soon as the cache is cold again.
    $.ui.toast('Boss: this prompt has attachments, so it cannot wait for the cold cut — it goes as is and the context is cut right after the turn');
    return next(e);
  }
  // Resumed + re-expanded: the bloated request never happens (we prevent it), so there is no
  // measured 'before' in tokens — the run's chars say how much was cut.
  ctx.pendingSettle = d.reason === 'resume-reexpanded'
    ? { reason: d.reason, trigger: 'prompt-gate', tokensBefore: null, prevented: true }
    : { reason: d.reason, trigger: 'prompt-gate', tokensBefore: tokens ?? null };
  const text = e.text;
  // The held text lives in this process only: kept on disk until it is re-sent, so a session closed during the cut does not
  // lose it (shown again at the next open). If it cannot be kept, the prompt goes on uncut rather than risk losing it.
  try { await send($, ctx, 'held', { text, reason: d.reason }); } catch (err) {
    $.ui.log(`compaction: could not keep your prompt safe during the cut, sending it on uncut: ${String(err && err.message ? err.message : err)}`);
    return next(e);
  }
  ctx.holding = true;
  ctx.gated = 'held'; // this turn closes with the cut under way: the turn-end rule stays out of it
  $.clock.after(1, () => scheduleCompactThenResend($, ctx, text, d.reason));
  return { drop: 'compacting first: the cache went cold and the context is past the threshold — your prompt follows right after' };
}

/**
 * Phase restart (opt-in, `phaseRestart` in the compaction config): past its threshold, with a warm cache, on the first
 * person prompt after a turn that committed, the model gets one ≤ 80-token block suggesting a handoff + new session,
 * and the person a toast. Once per crossing: said again only after the context went below the threshold.
 */
async function phaseRestart($, ctx, e, next, { tokens, now, ttlMs }) {
  if (ctx.config.phaseRestart !== true) return next(e);
  const warm = isCacheWarm({ now, lastAnswerAt: ctx.lastAnswerAt, ttlMs });
  const s = { tokens: tokens ?? null, warm, notified: ctx.phaseNotified, delivered: true };
  let d = decidePhaseRestart(s, ctx.config);
  if (d.reason === 'below-threshold') ctx.phaseNotified = false;
  if (!d.notify) return next(e);
  d = decidePhaseRestart({ ...s, delivered: lastTurnDelivered(await $.session.messages()) }, ctx.config);
  if (!d.notify) return next(e);
  ctx.phaseNotified = true;
  emit($, ctx, 'gate', { action: 'phase-restart-notice', reason: d.reason, tokens: tokens ?? null, thresholdTokens: ctx.config.phaseRestartTokens ?? null });
  $.ui.toast(`Boss: context at ~${Math.round(tokens / 1000)}k tokens after a committed task — a new session from a short handoff is cheaper for the next phase`);
  return next({ ...e, context: [...(e.context || []), phaseRestartNotice(tokens)] });
}

async function gateFailed($, e, next) {
  $.ui.log(`compaction: prompt gate failed, the prompt goes on uncompacted: ${describeFailure(next.error)}`);
  return next(e); // replay-safe: if our next() already ran, this replays its result
}

async function compact($, ctx, e, next) {
  if (e.agentId || e.trigger === 'precompute') return next(e);
  await ensureConfig($, ctx);
  // No config from the boss = don't act (pre-release audit 3.1.0: defaults said "on" even when
  // the user had switched it off and the daemon was just not up yet).
  if (!ctx.configLoaded || !ctx.config.enabled) return next(e);
  const t0 = await $.clock.now();
  const run = ctx.run = { id: `${t0}-${++ctx.compactSeq}`, t0, state: cacheState(ctx, t0), ours: false, data: null, emitted: false };
  if (run.state.cache === 'cold') await noteCold($, ctx, 'compaction');
  const plan = planCompaction(e.messages, ctx.config);
  // Pruning vs the engine's summary (compaction-core.chooseCompaction): the summary unless pruning
  // cuts >= 85% — warm or cold. `warm` is still recorded on the run event.
  // Mid-turn (busy) the turn's own calls keep the cache warm, whatever the previous answer's age:
  // judging it by the last answer alone pruned a warm cache after a long turn (audit 3.2.2).
  const warm = ctx.busy || isCacheWarm({ now: t0, lastAnswerAt: ctx.lastAnswerAt, ttlMs: ttlInUse(ctx).ttlMs });
  const mechanical = isMechanicalCut({ warm, trigger: e.trigger, reason: ctx.compactReason });
  const choice = chooseCompaction({ plan, trigger: e.trigger, warm, mechanical }, ctx.config);
  if (choice.kind === 'brief') return briefCut($, ctx, e, next, { plan, warm, mechanical, t0, why: choice.why });
  // A pruned list the engine would refuse is never handed back: recorded as what really runs (its summary).
  const invalid = choice.ours ? compactResultError(plan.messages) : null;
  if (invalid) $.ui.log(`compaction: the pruned history breaks the engine's contract (${invalid}); the engine's summary runs`);
  const ours = choice.ours && !invalid;
  const byReason = {};
  for (const p of plan.pruned) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
  const { context } = await $.session.usage();
  const tokensBefore = context.tokens ?? ctx.measuredTokens ?? null;
  const reason = ctx.compactReason || e.trigger;
  if (!ctx.pendingSettle) ctx.pendingSettle = { reason, trigger: e.trigger, tokensBefore };
  // Proactive compaction, phase 1 (shadow): size the model-free brief the summary could be replaced
  // by. Recorded only; the engine's summary still runs. A failure here must not stop the compaction.
  let brief = null;
  if (!ours) {
    try {
      const b = buildBrief(e.messages, ctx.config);
      brief = { briefChars: b.briefChars, charsAfter: b.charsAfter, cutMessages: b.cutMessages, userTextIntact: b.userTextIntact };
    } catch (err) { $.ui.log(`compaction: brief shadow failed: ${String(err)}`); }
  }
  run.data = {
    trigger: e.trigger, reason, outcome: ours ? 'pruned' : 'native-summary', why: invalid ? `result-invalid: ${invalid}` : choice.why, cacheWarm: warm,
    // what chose the cut: without these, "the brief never fires" and "no cold mechanical cut happened yet" read the same
    mechanical, mechanicalCut: ctx.config.mechanicalCut !== false,
    messages: e.messages.length, charsBefore: plan.charsBefore, charsAfter: ours ? plan.charsAfter : null,
    charsCut: ours ? plan.charsBefore - plan.charsAfter : 0, ratio: Number(plan.ratio.toFixed(3)),
    prunedResults: plan.pruned.length, byReason, duplicatesDropped: plan.duplicatesDropped, verbatimTextIntact: plan.verbatimTextIntact,
    tokensBefore, brief, durationMs: (await $.clock.now()) - t0,
  };
  if (!ours) {
    const r = await engineRuns($, ctx, run, e, next); // the engine's summary: far below any threshold afterwards
    await leaveAbove($, ctx);
    return r;
  }
  await leaveAbove($, ctx);
  oursRuns($, ctx, run, plan.messages);
  $.ui.toast(`compaction: every message kept, ${plan.pruned.length} stale tool results pruned (${Math.round(plan.ratio * 100)}% smaller), no summary`);
  return { messages: plan.messages };
}

const sizeOf = (r) => (r && Array.isArray(r.messages) ? estimateTokens(r.messages) : null);

// The run event: the cache state at the compaction's start next to both sizes (after = chars/4 of the history handed on).
function sayRun($, ctx, run, extra) {
  run.emitted = true;
  emit($, ctx, 'run', { compactionId: run.id, ...run.state, ...run.data, tokensAfterSource: 'estimate', ...extra });
}

// The engine's own summary runs; the event follows it, with its size and how long the engine took (a model call).
async function engineRuns($, ctx, run, e, next) {
  const t1 = await $.clock.now();
  let r;
  try {
    r = await next(e);
    return r;
  } finally {
    sayRun($, ctx, run, { ranBy: 'engine', engineAccepted: null, tokensAfter: sizeOf(r), engineMs: (await $.clock.now()) - t1 });
  }
}

// Our cut is handed back: said as accepted unless compactFailed hears the engine refuse it first.
function oursRuns($, ctx, run, messages) {
  run.ours = true;
  run.data = { ...run.data, ranBy: 'boss', tokensAfter: estimateTokens(messages) };
  $.clock.after(ACCEPT_WAIT_MS, () => { if (!run.emitted) sayRun($, ctx, run, { engineAccepted: true }); });
}

/** After any compaction the session is below the threshold: say so now, so the folder TTL is restored at once. */
async function leaveAbove($, ctx) {
  ctx.folderAbove = false;
  ctx.awaitCallAfterCut = true;
  try { await reportFolder($, ctx); } catch (err) { $.ui.log(`compaction: folder TTL restore after the cut failed: ${String(err && err.message ? err.message : err)}`); }
}

/**
 * The cold-cache cut without a model call: the brief (every user message verbatim, one line per tool call, a
 * `briefTailTokens` verbatim tail) replaces the history. Before handing it back, the folder report says this
 * session is below the threshold again, so the folder TTL is restored before the next request. A brief that
 * cuts nothing or would lose user text falls back to the engine's summary.
 */
async function briefCut($, ctx, e, next, { plan, warm, mechanical, t0, why }) {
  const run = ctx.run;
  const b = buildBrief(e.messages, ctx.config);
  const { context } = await $.session.usage();
  const tokensBefore = context.tokens ?? ctx.measuredTokens ?? null;
  const reason = ctx.compactReason || e.trigger;
  const base = { trigger: e.trigger, reason, why, cacheWarm: warm, mechanical, mechanicalCut: ctx.config.mechanicalCut !== false, messages: e.messages.length, charsBefore: b.charsBefore, tokensBefore };
  // Checked BEFORE the run event: a brief the engine refuses is not a brief, it is the engine's summary.
  const invalid = b.cutMessages && b.userTextIntact ? compactResultError(b.messages) : null;
  if (!b.cutMessages || !b.userTextIntact || invalid) {
    if (invalid) $.ui.log(`compaction: the brief breaks the engine's contract (${invalid}); the engine's summary runs`);
    run.data = { ...base, outcome: 'native-summary', why: invalid ? `result-invalid: ${invalid}` : !b.cutMessages ? 'brief-cuts-nothing' : 'brief-user-text-not-intact', ratio: Number(plan.ratio.toFixed(3)), durationMs: (await $.clock.now()) - t0 };
    return engineRuns($, ctx, run, e, next);
  }
  if (!ctx.pendingSettle) ctx.pendingSettle = { reason, trigger: e.trigger, tokensBefore };
  await leaveAbove($, ctx);
  run.data = {
    ...base, outcome: 'brief', charsAfter: b.charsAfter, charsCut: b.charsBefore - b.charsAfter, ratio: Number((1 - b.charsAfter / Math.max(1, b.charsBefore)).toFixed(3)),
    cutMessages: b.cutMessages, briefChars: b.briefChars, verbatimTextIntact: b.userTextIntact, folderTtl: ctx.folderTtl ? ctx.folderTtl.ttl : null,
    durationMs: (await $.clock.now()) - t0,
  };
  oursRuns($, ctx, run, b.messages);
  $.ui.toast(`compaction: cold cache — ${b.cutMessages} older messages condensed without a model call (user text kept verbatim), recent ones kept`);
  return { messages: b.messages };
}

async function compactFailed($, ctx, e, next) {
  const run = ctx.run;
  const unsaid = run && !run.emitted;
  if (unsaid) run.emitted = true; // first, before any await: the acceptance timer must not say this cut was taken
  const cause = describeFailure(next.error);
  $.ui.log(`compaction: pruning failed, the engine's own compaction runs: ${cause}`);
  if (!ctx.configLoaded) return next(e); // never a broken transcript
  emit($, ctx, 'error', { stage: 'session.compact', outcome: 'native-summary', cause, trigger: e && e.trigger, compactionId: run ? run.id : null });
  if (!unsaid) return next(e);
  // What really ran is the engine's summary: a refused cut of ours, or a hook that failed before answering.
  run.data = run.ours
    ? { ...run.data, outcome: 'native-summary', refusedOutcome: run.data.outcome, why: `engine-refused: ${cause}` }
    : { trigger: e && e.trigger, reason: ctx.compactReason || (e && e.trigger), ...run.data, outcome: 'native-summary', why: `hook-failed: ${cause}` };
  const t1 = await $.clock.now();
  let r;
  try {
    r = await next(e);
    return r;
  } finally {
    sayRun($, ctx, run, { ranBy: 'engine', engineAccepted: run.ours ? false : null, tokensAfter: sizeOf(r), engineMs: (await $.clock.now()) - t1 });
  }
}

export const register = (on) => {
  const ctx = newCtx();

  // The settings-hook SessionStart: it alone tells startup from resume/continue, and
  // carries the size the last response had (= the pruned size after our compaction).
  on('classic.SessionStart', async ($, e, next) => {
    ctx.transcriptPath = e.transcript_path || '';
    ctx.start = { source: e.source, lastTokens: e.context_tokens, secondsSince: e.seconds_since_last_response };
    if (e.source === 'resume') ctx.resumeChecked = false;
    if (e.source === 'resume') {
      const now = await $.clock.now();
      ctx.lastAnswerAt = resumedAnswerAt(now, e.seconds_since_last_response);
      ctx.resumeAnswer = { synthetic: ctx.lastAnswerAt, real: e.seconds_since_last_response == null ? null : now - e.seconds_since_last_response * 1000 };
    }
    else if (e.seconds_since_last_response != null) ctx.lastAnswerAt = (await $.clock.now()) - e.seconds_since_last_response * 1000;
    return next(e);
  });

  on('session.start', async ($, e, next) => {
    ctx.interactive = e.isInteractive !== false;
    // The launch cwd is the folder whose settings.local.json this session reads (measured: a subfolder session
    // reads its own, not the git root's) — captured before anything can move the working directory.
    try { ctx.folder = await $.session.cwd(); } catch (err) { $.ui.log(`compaction: launch folder unknown, folder TTL off: ${String(err && err.message ? err.message : err)}`); }
    if (ctx.interactive) {
      $.clock.after(1, () => {
        void (async () => {
          await ensureConfig($, ctx);
          const tail = await reopenLook($, ctx);
          if (tail) await noteCold($, ctx, 'reopen');
          await joinFolder($, ctx);
          try { await recoverHeld($, ctx); } catch (err) { $.ui.log(`compaction: held prompt recovery failed: ${String(err && err.message ? err.message : err)}`); }
          if (tail) await turnEnd($, ctx, 'reopen');
        })().catch((err) => $.ui.log(`compaction: session start check failed: ${String(err && err.message ? err.message : err)}`));
      });
    }
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => gate($, ctx, e, next)).catch(gateFailed);

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) ctx.busy = true;
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens != null) ctx.measuredTokens = e.context.tokens; // a null never erases a reading
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (e.agentId) return r;
    ctx.busy = false;
    ctx.lastAnswerAt = await $.clock.now();
    if (!ctx.config.enabled) return r;
    // Interactive: off the turn's path (the next prompt is not delayed). Headless: the
    // process ends right after the turn, so a deferred observation would never run.
    // After a person's turn too: the next input may be a peer message the gate never judges.
    const held = ctx.gated === 'held';
    ctx.gated = false;
    if (ctx.interactive) {
      $.clock.after(1, () => { void afterTurn($, ctx).then(() => (held ? null : turnEnd($, ctx))); });
    } else await afterTurn($, ctx);
    return r;
  });

  on('session.compact', async ($, e, next) => compact($, ctx, e, next)).catch(($, e, next) => compactFailed($, ctx, e, next));

  // The session's last API call often lands in the transcript after its turn.complete
  // (interactive): one more observation at the end, inside session.end's short budget.
  on('session.end', async ($, e, next) => {
    // Leave the folder FIRST (session.end's budget is short): if this session held its TTL at 5m, it goes back now.
    // E2E 14/10: after the transcript read below, the leave never reached the daemon. A crash is swept by the next
    // report of any session (and the next session start).
    try { await reportFolder($, ctx, { end: true }); } catch (err) { $.ui.log(`compaction: folder leave failed: ${String(err && err.message ? err.message : err)}`); }
    if (ctx.config.enabled && ctx.transcriptPath) {
      try { await observeCalls($, ctx); } catch (err) { $.ui.log(`compaction: end-of-session observation failed: ${String(err && err.message ? err.message : err)}`); }
    }
    if (ctx.run && ctx.run.ours && !ctx.run.emitted) sayRun($, ctx, ctx.run, { engineAccepted: null, acceptance: 'session-ended-before-confirmation' });
    return next(e);
  });
};
