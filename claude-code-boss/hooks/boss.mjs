// Boss band + /boss — a Claude Code function-hook module (hooks.json "modules").
//
// WHAT: one dim line above the prompt (the AbovePrompt band) — the session's cost, what the
// Token Guard saved in this session and over 30 days, whether the Brain is up — and the slash
// command /boss with the same numbers as a table. Where the native statusLine is not drawn
// (Claude Code Desktop), this is the boss's status line.
// WHERE THE NUMBERS COME FROM: the cost from the session itself ($.session.usage()); the rest
// from the brain daemon, GET /hook/boss-summary (token-gated, read-only; tool hook_boss_summary
// → scripts/boss-summary.js). Polled every POLL_MS from each interactive session; the daemon
// caches its answer, so N open sessions cost one computation.
// FAILURES are shown, not hidden: a daemon that does not answer puts its reason in the band and
// in /boss instead of stale numbers. A reply of {} means hook_boss_summary was switched off in
// the dashboard: no band at all.
// The engine turns every module off under disableAllHooks (and allowManagedModsOnly).

import { daemon } from '../scripts/lib/module-daemon.mjs';
import { bandLine, bossMarkdown } from '../scripts/lib/boss-band.mjs';

// At least 5 s between reads of one session; the daemon reuses its answer for 30 s.
export const POLL_MS = 10_000;
const ROUTE = '/hook/boss-summary';
const msg = (err) => String(err && err.message ? err.message : err);

function newCtx() {
  return {
    daemon: null,     // { base, token } of the brain daemon (scripts/lib/module-daemon.mjs)
    sessionId: '',
    summary: null,    // the daemon's last reply
    error: null,      // the last failure to read it (drawn until a read succeeds)
    loggedError: '',  // the failure already written to the log (one line per new failure, not per poll)
    disabled: false,  // hook_boss_summary switched off in the dashboard
    costUsd: null,
    line: '',         // what the band draws now ('' = nothing)
    timer: null,
  };
}

async function readSummary($, ctx) {
  const get = async (d) => $.http.fetch(`${d.base}${ROUTE}?session=${encodeURIComponent(ctx.sessionId)}`, {
    headers: { Authorization: `Bearer ${d.token}` },
  });
  let r = await get(await daemon($, ctx, false, 'boss'));
  if (r.status === 401) r = await get(await daemon($, ctx, true, 'boss')); // the daemon restarted with a new token
  if (!r.ok) throw new Error(`GET ${ROUTE} answered ${r.status}: ${String(r.text).slice(0, 200)}`);
  return JSON.parse(r.text);
}

/** One read: the cost from the session, the rest from the daemon; redraws only when the line changed. */
export async function refresh($, ctx) {
  try {
    const usage = await $.session.usage();
    ctx.costUsd = usage && usage.cost ? usage.cost.usd : null;
  } catch (err) {
    $.ui.log(`boss: session cost unreadable: ${msg(err)}`);
  }
  try {
    const s = await readSummary($, ctx);
    ctx.disabled = !s || Object.keys(s).length === 0;
    ctx.summary = ctx.disabled ? null : s;
    ctx.error = null;
    ctx.loggedError = '';
  } catch (err) {
    ctx.error = msg(err);
    ctx.daemon = null; // the next read checks /health again (a restarted daemon, another install on the port)
    if (ctx.error !== ctx.loggedError) {
      ctx.loggedError = ctx.error;
      $.ui.log(`boss: ${ctx.error}`);
    }
  }
  const line = ctx.disabled ? '' : bandLine(ctx);
  if (line !== ctx.line) {
    ctx.line = line;
    $.ui.invalidate('ui.render');
  }
}

export const register = (on) => {
  const ctx = newCtx();

  // Interactive sessions only (a matcher: compaction.mjs holds the plugin's one unmatched session.start).
  // Headless (-p, SDK) draws nothing, so it polls nothing. Fires again after /clear and on a reload.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({
      name: 'boss',
      description: 'Claude Code Boss: custo da sessão, economia do Token Guard e estado do Brain',
      immediate: true,
    });
    ctx.sessionId = await $.session.id();
    $.clock.after(1, () => { void refresh($, ctx); });
    if (ctx.timer) ctx.timer.cancel();
    ctx.timer = $.clock.every(POLL_MS, () => { void refresh($, ctx); });
    return next(e);
  });

  on('command.run', { command: 'boss' }, async ($) => {
    await refresh($, ctx);
    return { text: ctx.disabled ? 'O resumo do Boss está desligado no dashboard (hook_boss_summary).' : bossMarkdown(ctx) };
  });

  // One line, and what the plugins after this one draw kept under it (the band is shared).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !ctx.line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const below = await next(e);
    return h(Box, { flexDirection: 'column' }, h(Text, { dimColor: true }, ctx.line), below);
  });
};
