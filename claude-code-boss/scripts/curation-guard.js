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
const { canonicalSig } = require('./lib/command-signature.js');
const metrics = require('./lib/metrics.js');

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
 * Pure detector entry point — never abstains, always returns a decision
 * object. Shared by the standalone CLI (below) and
 * `pretooluse-bash-dispatcher.js`.
 * @param {object} event  PreToolUse payload
 * @returns {Promise<object>}
 */
async function run(event) {
  try {
    if (!event || event.tool_name !== 'Bash') {
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
    const plan = planRedirect(command, shells, projectRoot);
    const mctx = { sessionId: event.session_id, cwd: event.cwd };
    if (plan.bypass) {
      metrics.fire('curation.bypass', {}, mctx);
    } else if (plan.rewritten) {
      const mode = event.permission_mode === 'bypassPermissions' ? 'allow' : 'ask';
      const list = plan.replaced.map((r) => `\`${r.from}\` → \`${r.to}\``).join('; ');
      const ctx = `[curadoria] Redirecionado para o script curado do projeto: ${list}. A saída é o resumo curado (não a crua). Se precisar da saída crua, rode de novo com \`CCB_RAW=1\` na frente do comando.`;
      for (const r of plan.replaced) {
        let sig = ''; try { sig = canonicalSig(r.from); } catch (err) { void err; }
        metrics.fire('curation.redirected', { shellId: r.shellId, sig, mode, compound: plan.replaced.length > 1 || r.from !== command.trim() }, mctx);
      }
      // The script is told where to report the raw size it saw (lib/raw-report.js): the panel's
      // savings become exact for every script that honors the contract.
      let command2 = plan.rewritten;
      try {
        const rr = require('./lib/raw-report.js');
        require('fs').mkdirSync(rr.reportDir(), { recursive: true });
        command2 = rr.withReport(plan.rewritten, rr.newReportPath());
      } catch (err) { console.error(`[curation-guard] raw report off for this run: ${err.message}`); }
      return decision(mode, { updatedInput: { command: command2 }, additionalContext: ctx, ...(mode === 'ask' ? { permissionDecisionReason: ctx } : {}) });
    } else if (plan.uncovered.length) {
      metrics.fire('curation.uncovered', { shells: plan.uncovered }, mctx);
    }

    // 2. Project whitelist.
    if (isWhitelisted(command, whitelist)) {
      return PASS;
    }

    // 2.5 Graph-guard (Bash surface): a BROAD recursive search (grep -r/rg/find
    // at the repo root) on the mcp-memory backend with a READY Session Graph is
    // denied ONCE with the graph_search→scoped-grep two-step; the identical
    // retry passes. Lives here (not a separate hook) so every Bash call keeps
    // paying exactly ONE guard spawn. Fully fail-open: any error falls through
    // to the normal cascade below.
    try {
      const ggCfg = require('./lib/hooks-config.js').getGraphGuard();
      if (ggCfg.enabled) {
        const core = require('./lib/graph-guard-core.js');
        const broad = core.matchBroadBashSearch(command);
        if (broad) {
          const brainCfg = require('./lib/brain-config.js').load();
          if (((brainCfg.backend && brainCfg.backend.type) || 'local') === 'mcp-memory') {
            const cwd = event.cwd || process.cwd();
            const sid = event.session_id || 'default';
            const res = await core.decideBroadSearch({
              kind: 'bash',
              raw: command,
              pattern: broad.pattern,
              projectRoot: require('path').resolve(cwd),
              sid,
              dataDir: require('./lib/data-dir.js').dataDir(),
              cfg: ggCfg,
              probe: core.makeGraphStateProbe({ cwd, timeoutMs: ggCfg.probeTimeoutMs }),
            });
            if (res.action === 'deny') {
              try {
                require('./lib/metrics.js').fire('graph-guard.fired', { kind: 'bash', tool: broad.tool }, { sessionId: sid, cwd });
              } catch (e) { void e; /* metrics are best-effort */ }
              return decision('deny', { additionalContext: res.reason, permissionDecisionReason: res.reason });
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
    const shaped = plan.bypass || event.permission_mode !== 'bypassPermissions' ? null : planShaping(command, projectRoot);
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

module.exports = { run, decision, isWhitelisted, hasPipe, pipesCuratedScript, pipeFilterOf };
