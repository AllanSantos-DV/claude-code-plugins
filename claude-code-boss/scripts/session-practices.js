#!/usr/bin/env node
/**
 * session-practices.js — PreToolUse hook on the shell tools (Bash, PowerShell).
 *
 * Teaches the session a good conduct practice AT THE MOMENT it is about to break it,
 * once per session (and once per sub-agent: its context is separate), never on every
 * prompt and never outside the trigger. Advisory only: it adds `additionalContext`
 * (delivered next to the tool result) and decides nothing — the sibling guards on the
 * same matcher keep owning deny / updatedInput (Claude Code hands Claude every
 * hook's additionalContext).
 *
 * The text does not depend on the Claude Code version: where the Monitor tool does not
 * exist (older builds) the same instruction says "run in background and end the turn".
 *
 * Extensible: a practice is one entry of PRACTICES — { id, platforms?, applies(cmd,
 * toolInput), text }. The once-per-session record is lib/cooldown-store.js (key
 * `practice:<id>:<agent>` under the session).
 */
'use strict';

const { readStdin, parsePayload, emitJson } = require('./lib/hook-io.js');
const { isShellTool } = require('./lib/shell-tool.js');

// Waits up to this long in total are fine (a short settle); past it, the session sits blocked.
const LONG_WAIT_S = 30;

// A command starts at the beginning, after a separator/grouping, after `do`/`then`/`else`,
// or inside a quoted `bash -c "…"` / `powershell -Command "…"`.
const CMD_POS = String.raw`(?:^|[;&|({}\n\`"']|\bdo\b|\bthen\b|\belse\b)\s*`;
const UNIT_S = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const BASH_SLEEP = new RegExp(`${CMD_POS}sleep\\s+(\\d+(?:\\.\\d+)?)([smhd]?)\\b`, 'g');
const PS_SLEEP = new RegExp(`${CMD_POS}Start-Sleep\\b([^;|&\\n)}"']*)`, 'gi');
const CMD_TIMEOUT = new RegExp(`${CMD_POS}timeout(?:\\.exe)?\\s+/t\\s+(\\d+)`, 'gi');
// A sleep inside a loop is a poll: its total is unbounded whatever each step waits.
const POLL_LOOP = /\b(?:while|until|for)\b[\s\S]*?\bdo\b[\s\S]*?\bsleep\s+\d|\b(?:while|for|foreach|do)\b[\s\S]*?\{[\s\S]*?Start-Sleep\b/i;

/** Seconds of one `Start-Sleep` argument list (`-Seconds 5`, `-s 5`, `5`, `-Milliseconds 500`, `-Duration` ignored). */
function psSleepSeconds(args) {
  const ms = /-m(?:illi\w*)?\s*[: ]\s*(\d+(?:\.\d+)?)/i.exec(args);
  if (ms) return Number(ms[1]) / 1000;
  const s = /(?:-s(?:ec\w*)?\s*[: ]\s*)?(\d+(?:\.\d+)?)/i.exec(args);
  return s ? Number(s[1]) : 0;
}

/**
 * Does this command wait in the foreground for long? Pure.
 * @returns {{seconds:number, poll:boolean}|null} null = no long wait
 */
function longWait(cmd) {
  if (typeof cmd !== 'string' || !cmd) return null;
  let seconds = 0;
  for (const m of cmd.matchAll(BASH_SLEEP)) seconds += Number(m[1]) * UNIT_S[m[2].toLowerCase()];
  for (const m of cmd.matchAll(PS_SLEEP)) seconds += psSleepSeconds(m[1]);
  for (const m of cmd.matchAll(CMD_TIMEOUT)) seconds += Number(m[1]);
  const poll = seconds > 0 && POLL_LOOP.test(cmd);
  return poll || seconds >= LONG_WAIT_S ? { seconds, poll } : null;
}

// Test runners, matched at the start of a command segment (after `cd …` / `VAR=x` prefixes).
const TEST_RUNNERS = [
  /^(?:npm|pnpm|yarn|bun)\b(?:\s+--?[\w-]+(?:[ =]\S+)?)*\s+(?:run(?:-script)?\s+)?(?:test|t)(?::[\w:.-]+)?(?:\s|$)/,
  /^node\b.*\s--test\b/,
  /^node\s+(?:--?[\w-]+(?:=\S+)?\s+)*\S*?(?:^|[\\/])?(?:test[\w.-]*|[\w.-]+\.(?:test|spec))\.[cm]?[jt]s\b/,
  /^(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|bunx\s+|yarn\s+)?(?:jest|vitest|mocha|ava|tap|playwright\s+test|cypress\s+run)\b/,
  /^(?:python3?|py)(?:\s+-\w+)*\s+-m\s+(?:pytest|unittest|tox)\b/,
  /^(?:pytest|tox|nox)\b/,
  /^(?:go|cargo|dotnet|deno|swift|zig|mix)\s+test\b/,
  /^(?:\.[\\/])?(?:mvnw?|gradlew?)(?:\.cmd|\.bat)?\b.*\s(?:test|verify|check)\b/,
  /^make\b.*\s(?:test|check)\b/,
  /^Invoke-Pester\b/i,
];
const SEGMENT_SPLIT = /&&|\|\||[;|\n]|\bdo\b|\bthen\b/;
const SEGMENT_PREFIX = /^(?:[({]\s*)*(?:(?:[A-Za-z_]\w*=\S*|env|\$env:\w+\s*=\s*\S+;?)\s+)*/;

/** Does any segment of this command run a test suite? Pure. */
function runsTests(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  return cmd.split(SEGMENT_SPLIT).some((seg) => {
    const s = seg.trim().replace(/^["'`]+/, '').replace(SEGMENT_PREFIX, '');
    return s && TEST_RUNNERS.some((re) => re.test(s));
  });
}

const PRACTICES = [
  {
    id: 'background-wait',
    applies: (cmd, input) => !(input && input.run_in_background === true) && !!longWait(cmd),
    text: '[boss · boa prática: espera] Não espere em primeiro plano (sleep, Start-Sleep, timeout ou laço de polling): '
      + 'a sessão fica travada até o comando acabar (o Bash corta em 10 min) e nada mais anda. '
      + 'Lance o processo demorado com run_in_background: true. Se a ferramenta Monitor estiver na sua lista de ferramentas, '
      + 'use-a para acompanhar a saída ou esperar a condição; se não estiver (Claude Code mais antigo), encerre o turno logo '
      + 'depois de lançar em segundo plano: você é notificado quando o processo terminar. Subagente também avisa ao concluir; '
      + `não faça sleep esperando por ele. Pausas curtas (até ~${LONG_WAIT_S} s no total) não têm problema.`,
  },
  {
    id: 'hidden-test-processes',
    platforms: ['win32'], // console windows only exist on Windows
    applies: (cmd) => runsTests(cmd),
    text: '[boss · boa prática: testes sem janela] Rodando testes no Windows: nenhum processo pode abrir janela de console '
      + '(um CMD piscando na tela do usuário a cada processo filho). No código de teste e no que ele dispara: Node '
      + 'spawn/exec/execFile/fork com windowsHide: true; Python subprocess com creationflags=subprocess.CREATE_NO_WINDOW '
      + '(ou pythonw.exe); .NET ProcessStartInfo.CreateNoWindow = true; PowerShell ou cmd lançados por fora via '
      + '`conhost.exe --headless …` (-WindowStyle Hidden ainda pisca). Se uma janela aparecer, corrija o spawn em vez de ignorar.',
  },
];

/**
 * @param {object} event PreToolUse payload
 * @param {{platform?:string, practices?:object[], store?:{has:Function, add:Function}}} [deps] test seams
 * @returns {Promise<object>} {} or an additionalContext-only reply
 */
async function run(event, deps = {}) {
  if (!event || !isShellTool(event.tool_name)) return {};
  const input = event.tool_input || {};
  const cmd = input.command;
  if (typeof cmd !== 'string' || !cmd) return {};
  const platform = deps.platform || process.platform;
  const hits = (deps.practices || PRACTICES).filter((p) => (!p.platforms || p.platforms.includes(platform)) && p.applies(cmd, input));
  if (!hits.length) return {};
  if (!event.session_id) {
    // Without a session there is no "once": better silent than repeated on every call.
    console.error('[session-practices] no session_id: practice not injected');
    return {};
  }
  const store = deps.store || require('./lib/cooldown-store.js');
  const agent = event.agent_id || 'main';
  const fresh = hits.filter((p) => !store.has(event.session_id, `practice:${p.id}:${agent}`));
  if (!fresh.length) return {};
  for (const p of fresh) store.add(event.session_id, `practice:${p.id}:${agent}`);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: fresh.map((p) => p.text).join('\n\n') } };
}

if (require.main === module) {
  readStdin().then(async (raw) => emitJson(await run(parsePayload(raw)))).catch((err) => {
    console.error(`[session-practices] ${err && err.message ? err.message : err}`);
    emitJson({});
  });
}

module.exports = { run, longWait, runsTests, PRACTICES, LONG_WAIT_S };
