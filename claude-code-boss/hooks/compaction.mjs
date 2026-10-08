// Controlled compaction — a Claude Code function-hook module (hooks.json "modules").
//
// WHEN: never on its own, and never with a warm cache. When the person sends a prompt with
// the session idle, if the context is past the threshold (a % of the window the engine
// applies now — 200K and 1M models alike) and the provider cache has already gone cold, the
// prompt is held, the engine's /compact runs, and the same text is sent again as the
// person's. If the cache never cools, the engine's own auto-compaction runs at its limit —
// through our pruning too. WHAT: our pruning (scripts/lib/compaction-core.mjs)
// answers every compaction (manual, the engine's auto threshold, ours): text intact,
// stale tool results truncated; too little to cut → the engine's own summary.
// RESUME: `--resume`/`-c` reload the ORIGINAL history after a hook compaction (engine
// behavior, measured); the first prompt re-prunes it before anything is sent.
//
// Engine rules this shape follows (Claude Code 2.1.291, measured — BACKLOG Q35):
//   - session.compact is refused inside prompt.submit → hold ({drop}), compact, re-send;
//   - $.session.compact() skips the caller's own session.compact hook → /compact via
//     $.command.run, which raises it for every hook (ours included);
//   - a plugin's own $.prompt.submit skips its own hook → no loop;
//   - interactive: session.measure carries no tokens, usage() does (headless: reverse).
// Observability: every decision and cut goes to the boss metrics store through the
// daemon (POST /hook/compaction-event → tool hook_compaction_event → scripts/compaction-event.js).

import { planCompaction, decideTiming, classifyResume, estimateTokens, thresholdFor, DEFAULTS } from '../scripts/lib/compaction-core.mjs';

const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk']);

function newCtx() {
  return {
    config: { ...DEFAULTS },
    configLoaded: false,
    daemon: null,           // { base, token } of the brain daemon
    identity: null,         // { host, auth } — never a secret value
    busy: false,
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
  };
}

// The daemon's address and local token. The hook_* tools are unlisted (never the model's), and
// a module's $.mcp.call only reaches listed tools — so the module POSTs to the daemon's
// /hook/compaction-event route, behind the same token gate as /mcp. /health is open (the
// supervisor's probe) and names the data dir that holds the token file.
async function daemon($, ctx, refresh = false) {
  if (ctx.daemon && !refresh) return ctx.daemon;
  const port = Number(await $.env.get('BRAIN_HTTP_PORT')) || 38217;
  const base = `http://127.0.0.1:${port}`;
  const h = await $.http.fetch(`${base}/health`);
  if (!h.ok) throw new Error(`brain daemon /health answered ${h.status} on port ${port}`);
  const { dataDir } = JSON.parse(h.text);
  if (!dataDir) throw new Error('brain daemon /health has no dataDir');
  const token = (await $.fs.read(`${String(dataDir).replace(/[\\/]+$/, '')}/brain-http.token`)).trim();
  ctx.daemon = { base, token };
  return ctx.daemon;
}

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

function applyTtl(ctx, reply) {
  if (reply && reply.ttl && Number(reply.ttl.observedMs) > 0) ctx.hostTtlMs = Number(reply.ttl.observedMs);
  const seen = reply && reply.observed && Number(reply.observed.ttlMs);
  if (seen > 0) ctx.sessionTtlMs = Math.max(ctx.sessionTtlMs || 0, seen);
}

function ttlInUse(ctx) {
  if (ctx.sessionTtlMs) return { ttlMs: ctx.sessionTtlMs, ttlSource: 'session' };
  if (ctx.hostTtlMs) return { ttlMs: ctx.hostTtlMs, ttlSource: 'host' };
  return { ttlMs: ctx.config.unknownTtlMs, ttlSource: 'unknown-assumed-longest' };
}

async function hello($, ctx) {
  const id = await identity($, ctx);
  const reply = await send($, ctx, 'hello', { ...id, source: ctx.start ? ctx.start.source : null });
  if (reply.config) {
    ctx.config = { ...DEFAULTS, ...reply.config };
    ctx.configLoaded = true;
  }
  applyTtl(ctx, reply);
}

async function ensureConfig($, ctx) {
  if (ctx.configLoaded) return;
  try { await hello($, ctx); } catch (err) {
    $.ui.log(`compaction: boss config unreachable, running with defaults: ${String(err && err.message ? err.message : err)}`);
  }
}

// Records every API call the transcript holds since the last one seen (cache.turn, per call).
async function observeCalls($, ctx) {
  const id = await identity($, ctx);
  const reply = await send($, ctx, 'turn', { ...id, sinceMessageId: ctx.lastMessageId });
  if (reply.lastMessageId) ctx.lastMessageId = reply.lastMessageId;
  if (reply.config) { ctx.config = { ...DEFAULTS, ...reply.config }; ctx.configLoaded = true; } // slider changes, live
  applyTtl(ctx, reply);
  return { id, reply };
}

async function afterTurn($, ctx) {
  try {
    const settle = ctx.pendingSettle;
    ctx.pendingSettle = null;
    const { id } = await observeCalls($, ctx);
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
  try {
    // Not $.session.compact(): it skips our own session.compact hook (the engine's summary would run).
    await $.command.run({ command: 'compact' });
    ctx.lastCompactAt = await $.clock.now();
  } catch (err) {
    $.ui.log(`compaction: compacting before the prompt failed, sending it anyway: ${String(err && err.message ? err.message : err)}`);
    emit($, ctx, 'error', { where: 'command.run compact', reason, error: String(err && err.message ? err.message : err) });
  }
  ctx.compactReason = null;
  await $.prompt.submit({ text, asUser: true }); // never lose the person's prompt
}

function scheduleCompactThenResend($, ctx, text, reason) {
  compactThenResend($, ctx, text, reason).catch((err) => $.ui.log(`compaction: re-send failed: ${String(err && err.message ? err.message : err)}`));
}

async function gate($, ctx, e, next) {
  if (e.turnId || !PERSON_ORIGINS.has(e.origin && e.origin.kind)) return next(e);
  // Headless (-p/SDK): the engine refuses a plugin's compaction ("not available in a headless
  // session yet") — holding the prompt there would only delay it. Manual /compact and the
  // engine's auto threshold still go through our pruning (session.compact below).
  if (!ctx.interactive) return next(e);
  await ensureConfig($, ctx);
  if (!ctx.config.enabled) return next(e);

  const now = await $.clock.now();
  // The window the engine applies NOW (the model's limit or a smaller compaction window) and
  // its own auto-compact point — a local estimate, no API call. The model window as fallback.
  const { context } = await $.session.usage({ breakdown: 'summary' });
  const bd = context.breakdown || {};
  const windowTokens = Number(bd.rawMaxTokens) > 0 ? Number(bd.rawMaxTokens) : context.window;
  const windowSource = Number(bd.rawMaxTokens) > 0 ? (bd.autocompactSource || null) : 'model-window';
  const engineAutoCompactAt = bd.isAutoCompactEnabled === false ? null : (Number(bd.autoCompactThreshold) > 0 ? Number(bd.autoCompactThreshold) : null);
  const thr = thresholdFor({ window: windowTokens, engineAutoCompactAt }, ctx.config);
  let tokens = context.tokens ?? ctx.measuredTokens;
  const { ttlMs, ttlSource } = ttlInUse(ctx);
  let d;
  if (ctx.start && ctx.start.source === 'resume' && !ctx.resumeChecked) {
    ctx.resumeChecked = true;
    const reloadedMsgs = await $.session.messages();
    tokens = tokens ?? estimateTokens(reloadedMsgs);
    const r = classifyResume({ messages: reloadedMsgs, lastTokens: ctx.start.lastTokens });
    emit($, ctx, 'resume', { ...r, messages: reloadedMsgs.length, secondsSince: ctx.start.secondsSince ?? null });
    d = r.reexpanded ? { action: 'compact', reason: 'resume-reexpanded' } : null;
  }
  if (!d) d = decideTiming({ tokens, now, lastAnswerAt: ctx.lastAnswerAt, lastCompactAt: ctx.lastCompactAt, busy: false, ttlMs }, { ...ctx.config, thresholdTokens: thr.thresholdTokens });
  const idleMs = ctx.lastAnswerAt == null ? null : now - ctx.lastAnswerAt;
  emit($, ctx, 'gate', {
    action: d.action, reason: d.reason, dueInMs: d.dueInMs ?? null, tokens: tokens ?? null, idleMs, ttlMs, ttlSource,
    thresholdPercent: thr.percent, thresholdTokens: thr.thresholdTokens, windowTokens: windowTokens ?? null, windowSource,
    engineAutoCompactAt, thresholdAboveEngine: thr.aboveEngine,
  });

  if (d.action !== 'compact') return next(e);
  if (e.attachments && e.attachments.length) {
    emit($, ctx, 'gate', { action: 'pass', reason: 'attachments-would-be-lost', tokens: tokens ?? null, idleMs, ttlMs, ttlSource });
    return next(e);
  }
  // Resumed + re-expanded: the bloated request never happens (we prevent it), so there is no
  // measured 'before' in tokens — the run's chars say how much was cut.
  ctx.pendingSettle = d.reason === 'resume-reexpanded'
    ? { reason: d.reason, trigger: 'prompt-gate', tokensBefore: null, prevented: true }
    : { reason: d.reason, trigger: 'prompt-gate', tokensBefore: tokens ?? null };
  const text = e.text;
  $.clock.after(1, () => scheduleCompactThenResend($, ctx, text, d.reason));
  return { drop: 'compacting first: the cache went cold and the context is past the threshold — your prompt follows right after' };
}

async function gateFailed($, e, next) {
  $.ui.log(`compaction: prompt gate failed, the prompt goes on uncompacted: ${String(next.error)}`);
  return next(e); // replay-safe: if our next() already ran, this replays its result
}

async function compact($, ctx, e, next) {
  if (e.agentId || e.trigger === 'precompute') return next(e);
  await ensureConfig($, ctx);
  if (!ctx.config.enabled) return next(e);
  const t0 = await $.clock.now();
  const plan = planCompaction(e.messages, ctx.config);
  // Dropping the engine's duplicate copies is reason enough on its own (the resumed request would
  // otherwise carry them), whatever the ratio.
  const ours = (plan.ratio >= ctx.config.minReductionRatio || plan.duplicatesDropped > 0) && plan.verbatimTextIntact;
  const byReason = {};
  for (const p of plan.pruned) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
  const { context } = await $.session.usage();
  const tokensBefore = context.tokens ?? ctx.measuredTokens ?? null;
  const reason = ctx.compactReason || e.trigger;
  if (!ctx.pendingSettle) ctx.pendingSettle = { reason, trigger: e.trigger, tokensBefore };
  emit($, ctx, 'run', {
    trigger: e.trigger, reason, outcome: ours ? 'pruned' : 'native-summary',
    messages: e.messages.length, charsBefore: plan.charsBefore, charsAfter: ours ? plan.charsAfter : null,
    charsCut: ours ? plan.charsBefore - plan.charsAfter : 0, ratio: Number(plan.ratio.toFixed(3)),
    prunedResults: plan.pruned.length, byReason, duplicatesDropped: plan.duplicatesDropped, verbatimTextIntact: plan.verbatimTextIntact,
    tokensBefore, durationMs: (await $.clock.now()) - t0,
  });
  if (!ours) return next(e);
  $.ui.toast(`compaction: every message kept, ${plan.pruned.length} stale tool results pruned (${Math.round(plan.ratio * 100)}% smaller), no summary`);
  return { messages: plan.messages };
}

async function compactFailed($, e, next) {
  $.ui.log(`compaction: pruning failed, the engine's own compaction runs: ${String(next.error)}`);
  return next(e); // never a broken transcript
}

export const register = (on) => {
  const ctx = newCtx();

  // The settings-hook SessionStart: it alone tells startup from resume/continue, and
  // carries the size the last response had (= the pruned size after our compaction).
  on('classic.SessionStart', async ($, e, next) => {
    ctx.transcriptPath = e.transcript_path || '';
    ctx.start = { source: e.source, lastTokens: e.context_tokens, secondsSince: e.seconds_since_last_response };
    if (e.source === 'resume') ctx.resumeChecked = false;
    if (e.seconds_since_last_response != null) ctx.lastAnswerAt = (await $.clock.now()) - e.seconds_since_last_response * 1000;
    return next(e);
  });

  on('session.start', async ($, e, next) => {
    ctx.interactive = e.isInteractive !== false;
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
    if (ctx.interactive) $.clock.after(1, () => { void afterTurn($, ctx); });
    else await afterTurn($, ctx);
    return r;
  });

  on('session.compact', async ($, e, next) => compact($, ctx, e, next)).catch(compactFailed);

  // The session's last API call often lands in the transcript after its turn.complete
  // (interactive): one more observation at the end, inside session.end's short budget.
  on('session.end', async ($, e, next) => {
    if (ctx.config.enabled && ctx.transcriptPath) {
      try { await observeCalls($, ctx); } catch (err) { $.ui.log(`compaction: end-of-session observation failed: ${String(err && err.message ? err.message : err)}`); }
    }
    return next(e);
  });
};
