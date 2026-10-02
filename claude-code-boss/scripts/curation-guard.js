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
 *      a. invoking the curated script with no pipe → allow
 *      b. invoking the curated script with a pipe   → deny (edit the script)
 *      c. raw alias (not invoking the script)       → deny (redirect to script)
 *   2. command matches project whitelist → allow
 *   3. denyUnknown=true → deny (paranoid mode)
 *   4. default → allow (PostToolUse/Stop discovery loop handles the rest)
 */
const { hookLog } = require('./hook-logger.js');
const { loadCurationConfig } = require('./curation-paths.js');
const { runPreToolUseCli } = require('./lib/hook-io.js');
const { findProjectRoot, loadShellsConfig, matchCuratedShell, _pathMatches, _tokenize } = require('./shells-config.js');
const { planRedirect } = require('./lib/curation-redirect.js');
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
  const segments = String(command || '').split(/\s*(?:&&|\|\||;|\r?\n)\s*/).filter(Boolean);
  return segments.some(seg => hasPipe(seg) && invokesScript(_tokenize(seg.split(/(?<!\|)\|(?!\|)/)[0]), scriptPath));
}

// Build a properly-formatted PreToolUse decision object per Claude Code docs.
// permissionDecision MUST be "allow" | "deny" | "ask" and live INSIDE hookSpecificOutput.
// https://docs.claude.com/en/docs/claude-code/hooks
function decision(permissionDecision, { additionalContext, permissionDecisionReason, updatedInput } = {}) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  if (updatedInput) hookSpecificOutput.updatedInput = updatedInput;
  return { hookSpecificOutput };
}

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
      return decision('allow');
    }

    const command = event.tool_input?.command || '';
    if (!command) {
      return decision('allow');
    }

    const projectRoot = findProjectRoot(event.cwd || process.cwd());
    const { shells, whitelist } = loadShellsConfig(projectRoot);

    // 1. The curated script itself is being run: allowed, but never through a pipe (its
    //    output is already shaped — measured: this denial is followed 76% of the time).
    const curatedShell = matchCuratedShell(command, shells);
    const scriptPath = curatedShell ? (curatedShell.script || '').trim() : '';
    if (scriptPath && _tokenize(command.trim()).some(t => _pathMatches(t, scriptPath))) {
      if (pipesCuratedScript(command, scriptPath)) {
        const reason = `[curation-guard] Curated script \`${scriptPath}\` invoked with a pipe. Its output is already shaped (filter: ${curatedShell.outputFilter || 'summary'}, lines: ${curatedShell.outputLines || 200}) and is meant to be consumed as-is. If the output is not adequate, edit the script. See skill \`curation-script-pattern\`.`;
        return decision('deny', { additionalContext: reason, permissionDecisionReason: reason });
      }
      return decision('allow');
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
      for (const r of plan.replaced) metrics.fire('curation.redirected', { shellId: r.shellId, mode, compound: plan.replaced.length > 1 || r.from !== command.trim() }, mctx);
      return decision(mode, { updatedInput: { command: plan.rewritten }, additionalContext: ctx, ...(mode === 'ask' ? { permissionDecisionReason: ctx } : {}) });
    } else if (plan.uncovered.length) {
      metrics.fire('curation.uncovered', { shells: plan.uncovered }, mctx);
    }

    // 2. Project whitelist.
    if (isWhitelisted(command, whitelist)) {
      return decision('allow');
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
      const cfg = loadCurationConfig();
      const reason = `[curation-guard] Command \`${command}\` is unknown (denyUnknown mode active). Add it to the whitelist in \`${cfg.shellsConfigPath}\` or create a curated script in \`${cfg.scriptsDir}/\`.`;
      return decision('deny', { additionalContext: reason, permissionDecisionReason: reason });
    }

    // 4. Default: allow. If output is bulky, PostToolUse → Stop discovery
    //    loop will demand a curated script at end of turn.
    return decision('allow');
  } catch (err) {
    console.error(`[CURATION-GUARD] Error: ${err.message}`);
    hookLog('error', 'curation-guard', `Unhandled error: ${err.message}`);
    return decision('allow');
  }
}

if (require.main === module) {
  runPreToolUseCli(run, 'curation-guard', { defaultDecision: decision('allow') });
}

module.exports = { run, decision, isWhitelisted, hasPipe, pipesCuratedScript };
