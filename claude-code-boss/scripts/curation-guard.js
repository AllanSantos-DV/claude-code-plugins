#!/usr/bin/env node
/**
 * Curation Guard — PreToolUse hook for Bash tool calls.
 *
 * Single responsibility: decide whether a Bash command should be redirected
 * to a curated script. The hook does NOT classify commands itself (no
 * hardcoded "trivial" / "build tool" lists). Project-level discovery does that:
 *
 *   shells.json     — declares curated scripts + project whitelist
 *   curation-detect — PostToolUse: classifies bulky/noisy output
 *   curation-stop   — Stop: blocks turn until uncurated bulk gets a curated script
 *
 * Cascade:
 *   0. Windows: a heredoc / long `node -e` / `python -c` the Bash tool would corrupt
 *      → payload moved to a file, command rewritten (lib/shell-escape.js); what
 *      can't be fixed safely → warning (or deny with shellEscapeGuard.block)
 *   1. Bash + command matches curated entry (path or alias)
 *      a. invoking the curated script               → abstain
 *      b. invoking the curated script with a pipe   → abstain + `curation.piped` metric
 *      c. a TASK part matching an alias             → rewrite (updatedInput; allow in
 *         bypassPermissions, ask otherwise)
 *   2. command matches project whitelist → abstain (exempt from denyUnknown)
 *   3. denyUnknown=true → deny (paranoid mode)
 *   3b. exploration without Token Guard, bypassPermissions only → shaper rewrite
 *   4. default → abstain (`{}` — the user's permission flow decides; PostToolUse/Stop
 *      discovery handles bulky output)
 */
const { hookLog } = require('./hook-logger.js');
const { getShellsConfigPath } = require('./curation-paths.js');
const { runPreToolUseCli, preToolUseDecision } = require('./lib/hook-io.js');
const { findProjectRoot, loadShellsConfig, matchCuratedShell, _pathMatches, _tokenize } = require('./shells-config.js');
const { planRedirect, planShaping } = require('./lib/curation-redirect.js');
const { canonicalSig } = require('../engine/lib/command-signature.js');
const metrics = require('../engine/lib/metrics.js');

const hooksConfig = require('./lib/hooks-config.js');

/**
 * Case-insensitive prefix match with word boundary for project whitelist.
 */
function isWhitelisted(command, whitelist) {
  if (!whitelist || whitelist.length === 0) return false;
  const trimmed = command.trim().toLowerCase();
  for (const prefix of whitelist) {
    const p = prefix.trim().toLowerCase();
    if (trimmed === p || trimmed.startsWith(p + ' ')) return true;
  }
  return false;
}

/**
 * True if the command has a real pipe (`|`) — not the logical OR `||`.
 * Used to flag post-processing of a curated script's output.
 */
function hasPipe(command) {
  return /(?<!\|)\|(?!\|)/.test(command);
}

/**
 * True when a segment that INVOKES `scriptPath` pipes its output. The pipe must
 * belong to that segment: `run-tests.mjs && audit check | tail` pipes the audit,
 * not the curated script — judging the whole command denied it by mistake.
 */
// The curated script must be the PROGRAM being run (`node x.mjs …`, `./x.sh`), not
// an argument of another program: `grep -n foo x.mjs | head` READS the script and was
// denied as "curated script invoked with a pipe" (seen live, 2026-10-02).
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'pwsh', 'powershell', 'deno', 'bun']);
const NON_RUN_FLAGS = new Set(['--check', '-c', '--syntax-check']);
function invokesScript(tokens, scriptPath) {
  if (!tokens.length) return false;
  if (_pathMatches(tokens[0], scriptPath)) return true;
  const prog = String(tokens[0]).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  if (!INTERPRETERS.has(prog)) return false;
  // Interpreter flags may take values (`powershell -ExecutionPolicy Bypass -File x`),
  // so the script counts anywhere in its args — unless a flag means "don't run it".
  const args = tokens.slice(1);
  if (args.some(t => NON_RUN_FLAGS.has(t))) return false;
  return args.some(t => _pathMatches(t, scriptPath));
}

function pipesCuratedScript(command, scriptPath) {
  return pipeFilterOf(command, scriptPath) !== null;
}

/**
 * The filter the agent applied to the curated script's output (`tail -3`, `grep -E x`)
 * — what follows the first pipe of the segment that RUNS the script, whitespace
 * collapsed — or null when it isn't piped. Feeds the piped→refine nudge.
 */
function pipeFilterOf(command, scriptPath) {
  const segments = String(command || '').split(/\s*(?:&&|\|\||;|\r?\n)\s*/).filter(Boolean);
  for (const seg of segments) {
    if (!hasPipe(seg)) continue;
    const stages = seg.split(/(?<!\|)\|(?!\|)/);
    if (!invokesScript(_tokenize(stages[0]), scriptPath)) continue;
    return stages.slice(1).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' | ');
  }
  return null;
}

const decision = preToolUseDecision; // lib/hook-io

// "Nothing to do" is an ABSTENTION, never `allow`: a PreToolUse `allow` bypasses Claude
// Code's permission system, so answering it for every Bash command auto-approved
// everything for users NOT in bypassPermissions (pre-release audit; it dated from 1.x).
// Only the rewrites (redirect / shaper) decide, and they follow the session's posture.
const PASS = {};

/**
 * Step 0 — Windows shell-escape fix (lib/shell-escape.js). Lives here because only
 * ONE hook on this matcher may emit `updatedInput` (see error-guard.js INVARIANT).
 * Writes the moved payloads to the plugin's runtime dir (swept after a day).
 * @returns {null | {command:string|null, ctx:string|null, deny:object|null}}
 */
// The inline-scripts sweep (readdir + stat of each file) ran on EVERY rewrite on the
// daemon's fast lane: 18–24 ms with 399 files. Files live 24 h, so once per 10 min is plenty.
const INLINE_SWEEP_EVERY_MS = 10 * 60e3;
const _inlineSwept = new Map(); // dir -> last sweep ms

function sweepInlineScripts(dir, now = Date.now()) {
  if (now - (_inlineSwept.get(dir) || 0) < INLINE_SWEEP_EVERY_MS) return false;
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > 24 * 3600e3) fs.rmSync(f, { force: true }); } catch (err) { void err; }
  }
  _inlineSwept.set(dir, now);
  return true;
}

function escapeFix(event) {
  try {
    const cfg = hooksConfig.getShellEscapeGuard();
    if (!cfg.enabled || !cfg.platforms.includes(process.platform)) return null;
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(require('../engine/lib/data-dir.js').dataDir(), '.runtime', 'inline-scripts');
    const plan = require('../engine/lib/shell-escape.js').planEscapeFix(event.tool_input.command, {
      dir: dir.replace(/\\/g, '/'), inlineMaxChars: cfg.inlineMaxChars, mode: cfg.mode,
    });
    if (!plan) return null;
    const mctx = { sessionId: event.session_id, cwd: event.cwd };
    if (plan.command) {
      if (!sweepInlineScripts(dir)) fs.mkdirSync(dir, { recursive: true });
      for (const f of plan.files) fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8');
      metrics.fire('shell-escape.rewritten', { kinds: plan.kinds }, mctx);
    }
    if (plan.warn && cfg.block) {
      metrics.fire('shell-escape.denied', {}, mctx);
      return { command: null, ctx: null, deny: decision('deny', { additionalContext: plan.warn, permissionDecisionReason: plan.warn }) };
    }
    if (plan.warn) metrics.fire('shell-escape.warned', {}, mctx);
    const done = plan.command
      ? `[boss] Bash no Windows: o conteúdo de ${[...new Set(plan.kinds)].join('/')} foi movido para arquivo e o comando reescrito (o Bash tool do Claude Code corrompe \\\\ e aspas nesse caminho — bug aberto). Ele roda igual ao que você escreveu: se este comando falhar, a causa NÃO é o heredoc/aspas — leia o erro dele. Para script longo, prefira Write + rodar o arquivo.`
      : null;
    const ctx = [done, plan.warn, plan.note].filter(Boolean).join(' ') || null;
    return { command: plan.command, ctx, deny: null };
  } catch (err) {
    hookLog('error', 'curation-guard', `shell-escape fix failed (fail-open): ${err.message}`);
    return null;
  }
}

/**
 * Step 0b — PowerShell via Bash (lib/powershell-compat.js): escape the `$`/backtick bash
 * would eat inside `powershell -Command "…"` (exact rewrite) and warn about 5.1×7 syntax.
 * Runs on the already shell-escape-fixed command.
 * @returns {null | {command:string|null, ctx:string}}
 */
function powershellFix(event, command) {
  try {
    const cfg = hooksConfig.getPowershellGuard();
    if (!cfg.enabled || !cfg.platforms.includes(process.platform)) return null;
    const compat = require('../engine/lib/powershell-compat.js');
    const mctx = { sessionId: event.session_id, cwd: event.cwd };
    const fixed = cfg.advisory ? null : compat.fixBashCommand(command);
    const warn = compat.renderWarning(compat.lintBash(fixed ? fixed.command : command));
    if (fixed) metrics.fire('powershell.rewritten', { escapes: fixed.escapes, chains: fixed.chains, stderr: fixed.stderr }, mctx);
    if (warn) metrics.fire('powershell.warned', {}, mctx);
    if (!fixed && !warn) return null;
    // Informational only: the agent needs no action — the command already does what it wrote.
    const note = fixed ? `[boss] PowerShell via Bash: comando ajustado automaticamente (${[fixed.escapes && `${fixed.escapes} $/crase escapados`, fixed.chains && `${fixed.chains} &&/|| → if ($?)`, fixed.stderr && '2>&1 movido para o bash'].filter(Boolean).join(', ')}).` : null;
    return { command: fixed ? fixed.command : null, ctx: [note, warn].filter(Boolean).join(' ') };
  } catch (err) {
    hookLog('error', 'curation-guard', `powershell fix failed (fail-open): ${err.message}`);
    return null;
  }
}

/** escapeFix + powershellFix as one fix (command/ctx merged; a deny stands alone). */
function allFixes(event) {
  const a = escapeFix(event);
  if (a && a.deny) return a;
  const ps = powershellFix(event, (a && a.command) || event.tool_input.command);
  if (!ps) return a;
  return {
    command: ps.command || (a && a.command) || null,
    ctx: [a && a.ctx, ps.ctx].filter(Boolean).join(' ') || null,
    deny: null,
  };
}

/**
 * Pure detector entry point — never abstains, always returns a decision
 * object. Shared by the standalone CLI (below) and
 * `pretooluse-bash-dispatcher.js`.
 * @param {object} event  PreToolUse payload
 * @returns {Promise<object>}
 */
async function run(event) {
  if (hooksConfig.getCurationGuard().enabled === false) return PASS;
  const fix = event && event.tool_name === 'Bash' && event.tool_input?.command ? allFixes(event) : null;
  if (!fix) return cascade(event);
  if (fix.deny) return fix.deny;
  const ev = fix.command ? { ...event, tool_input: { ...event.tool_input, command: fix.command } } : event;
  const out = await cascade(ev);
  const hso = out && out.hookSpecificOutput;
  if (hso && hso.permissionDecision === 'deny') return out;
  if (hso) {
    // The cascade rewrote the (already fixed) command: keep its decision, add our note.
    hso.additionalContext = [hso.additionalContext, fix.ctx].filter(Boolean).join(' ');
    return out;
  }
  if (fix.command) {
    const mode = event.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
    return decision(mode, { updatedInput: ev.tool_input, additionalContext: fix.ctx, ...(mode === 'ask' ? { permissionDecisionReason: fix.ctx } : {}) });
  }
  // Warn only: context, no decision — the user's permission flow is untouched.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: fix.ctx } };
}

/**
 * The curation cascade (header steps 1–4) over the — possibly escape-fixed — event.
 * Advisory notes (graph-guard) collected on the way are merged into whatever the
 * cascade decides, so an advisory never replaces a decision nor blocks a call.
 */
async function cascade(event) {
  const notes = [];
  const out = await cascadeSteps(event, notes);
  if (!notes.length) return out;
  const note = notes.join(' ');
  const hso = out && out.hookSpecificOutput;
  if (hso) {
    hso.additionalContext = [hso.additionalContext, note].filter(Boolean).join(' ');
    return out;
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } };
}

async function cascadeSteps(event, notes) {
  try {
    // `PowerShell` takes the same cascade (redirect / whitelist / denyUnknown) — its rewrites
    // are PowerShell-valid and it is composed with the 5.1 chain fix by powershell-guard.js,
    // the ONE hook on that matcher (two hooks returning updatedInput overwrite each other).
    // The Bash-only steps (graph-guard's grep patterns, the `set -o pipefail` shaper) are skipped.
    const isPs = !!event && event.tool_name === 'PowerShell';
    if (!event || (event.tool_name !== 'Bash' && !isPs)) {
      return PASS;
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      return PASS;
    }

    const projectRoot = findProjectRoot(event.cwd || process.cwd());
    const { shells, whitelist } = loadShellsConfig(projectRoot);

    // 1. The curated script itself is being run → allowed, piped or not. The old deny of a
    //    pipe cost a round trip and its "fix" (re-run without the filter) put MORE output in
    //    context — replay on real history: 99 of the 243 old-guard denials were this rule.
    //    A pipe on a curated script is the signal its output doesn't fit: measured per
    //    script (`curation.piped`, dashboard) so the script gets tuned, not the agent blocked.
    const curatedShell = matchCuratedShell(command, shells);
    const scriptPath = curatedShell ? (curatedShell.script || '').trim() : '';
    if (scriptPath && _tokenize(command.trim()).some(t => _pathMatches(t, scriptPath))) {
      if (pipesCuratedScript(command, scriptPath)) {
        metrics.fire('curation.piped', { shellId: curatedShell.id || scriptPath }, { sessionId: event.session_id, cwd: event.cwd });
      }
      return PASS;
    }

    // 1b. C2 (Phase C): a TASK part whose signature + flags match a curated alias is
    //     REWRITTEN to the script (updatedInput — verified through mcp_tool). The old
    //     "Prefer it next time" hint (followed 19%) and deny-redirect (47%) are gone.
    //     Permission posture is the user's: bypassPermissions → allow; any other mode
    //     → ask (the prompt shows the rewrite). Variants run raw and are only measured.
    // Where the redirected script(s) record their raw output size (lib/raw-report.js). Its id pairs
    // each redirect with the measured run, so a measured run is never also estimated.
    let reportPath = '';
    try {
      const rr = require('./lib/raw-report.js');
      require('fs').mkdirSync(rr.reportDir(), { recursive: true });
      reportPath = rr.newReportPath();
    } catch (err) { console.error(`[curation-guard] raw report off for this run: ${err.message}`); }
    const reportId = reportPath ? require('./lib/raw-report.js').reportIdOf(reportPath) : '';
    const plan = planRedirect(command, shells, projectRoot, { reportPath, ps: isPs });
    const mctx = { sessionId: event.session_id, cwd: event.cwd };
    if (plan.bypass) {
      metrics.fire('curation.bypass', {}, mctx);
    } else if (plan.rewritten) {
      const mode = event.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
      const list = plan.replaced.map((r) => `\`${r.from}\` → \`${r.to}\``).join('; ');
      const ctx = `[curadoria] Redirecionado para o script curado do projeto: ${list}. A saída é o resumo curado (não a crua). Se precisar da saída crua, rode de novo com ${isPs ? '`$env:CCB_RAW=1;`' : '`CCB_RAW=1`'} na frente do comando.`;
      for (const r of plan.replaced) {
        let sig = ''; try { sig = canonicalSig(r.from); } catch (err) { void err; }
        metrics.fire('curation.redirected', { shellId: r.shellId, sig, mode, compound: plan.replaced.length > 1 || r.from !== command.trim(), ...(reportId ? { reportId } : {}) }, mctx);
      }
      return decision(mode, { updatedInput: { command: plan.rewritten }, additionalContext: ctx, ...(mode === 'ask' ? { permissionDecisionReason: ctx } : {}) });
    } else if (plan.uncovered.length) {
      metrics.fire('curation.uncovered', { shells: plan.uncovered }, mctx);
    }

    // 2. Project whitelist.
    if (isWhitelisted(command, whitelist)) {
      return PASS;
    }

    // 2.5 Graph-guard (Bash surface): a BROAD recursive search (grep -r/rg/find
    // at the repo root) on the mcp-memory backend with a READY Session Graph is
    // advised ONCE (additionalContext, never a deny — a deny here beat the Smart
    // Tool transparent redirect) with the smart_search pointer. Lives here (not a separate hook) so every Bash call keeps
    // paying exactly ONE guard spawn. Fully fail-open: any error falls through
    // to the normal cascade below.
    try {
      const ggCfg = require('./lib/hooks-config.js').getGraphGuard();
      if (ggCfg.enabled && !isPs) {
        const core = require('./lib/graph-guard-core.js');
        const broad = core.matchBroadBashSearch(command);
        if (broad) {
          const brainCfg = require('../engine/lib/brain-config.js').load();
          if (((brainCfg.backend && brainCfg.backend.type) || 'local') === 'mcp-memory') {
            const cwd = event.cwd || process.cwd();
            const sid = event.session_id || 'default';
            const res = await core.decideBroadSearch({
              kind: 'bash',
              raw: command,
              pattern: broad.pattern,
              projectRoot: require('path').resolve(cwd),
              sid,
              dataDir: require('../engine/lib/data-dir.js').dataDir(),
              cfg: ggCfg,
              probe: core.makeGraphStateProbe({ cwd, timeoutMs: ggCfg.probeTimeoutMs }),
            });
            if (res.action === 'advise') {
              try {
                require('../engine/lib/metrics.js').fire('graph-guard.fired', { kind: 'bash', tool: broad.tool }, { sessionId: sid, cwd });
              } catch (e) { void e; /* metrics are best-effort */ }
              notes.push(res.reason);
            }
          }
        }
      }
    } catch (err) {
      hookLog('error', 'curation-guard', `graph-guard branch failed (fail-open): ${err.message}`);
    }

    // 3. Paranoid mode.
    // Read per call (not at module load) — the shared daemon (Phase G) would freeze it.
    if (hooksConfig.getCurationGuard().denyUnknown) {
      const reason = `[curation-guard] Command \`${command}\` is unknown (denyUnknown mode active). Add it to the whitelist in \`${getShellsConfigPath(projectRoot)}\` or create a curated script with curation_register_shell.`;
      return decision('deny', { additionalContext: reason, permissionDecisionReason: reason });
    }

    // 3b. C2b: an EXPLORATION command (git log/grep/cat/ls…) gets its output bounded
    //     by the boss ONLY when Token Guard isn't installed (both coexist — the owner's
    //     decision). Single segment only (a `cd` must keep persisting), never when the
    //     output goes to a file/tee. Same permission rule as the redirect.
    //     Only under bypassPermissions: in the other modes Claude Code lets read-only
    //     commands (cat/grep/ls) through without asking, and a rewrite needs `ask` —
    //     every exploration command would start prompting.
    const shaped = isPs || plan.bypass || event.permission_mode !== 'bypassPermissions' ? null : planShaping(command, projectRoot);
    if (shaped) {
      const ctx = '[boss] Saída de exploração limitada pelo boss (Token Guard não instalado): o comando roda igual; se passar do limite, o resto fica salvo em arquivo. `CCB_RAW=1` na frente desliga o corte.';
      return decision('allow', { updatedInput: { command: shaped }, additionalContext: ctx });
    }

    // 4. Default: allow. If output is bulky, PostToolUse → Stop discovery
    //    loop will demand a curated script at end of turn.
    return PASS;
  } catch (err) {
    console.error(`[CURATION-GUARD] Error: ${err.message}`);
    hookLog('error', 'curation-guard', `Unhandled error: ${err.message}`);
    return PASS;
  }
}

if (require.main === module) {
  runPreToolUseCli(run, 'curation-guard', { defaultDecision: PASS });
}

module.exports = { run, decision, isWhitelisted, hasPipe, pipesCuratedScript, pipeFilterOf, sweepInlineScripts };
