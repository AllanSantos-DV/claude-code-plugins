'use strict';
/**
 * read-burst-hook.js — `hook_read_burst` (served by the brain daemon), PostToolUse on the
 * read-only tools and on the tools that end a run. See lib/read-burst.js.
 */
const readBurst = require('./lib/read-burst.js');
const hooksConfig = require('./lib/hooks-config.js');
const { hookEnv } = require('./lib/hook-context.js');

const SMART_TOOL_CALL_MS = 30000;
const SMART_TOOL_TOTAL_MS = 45000;

/**
 * The bundle without the Brain's recall (the prompt hook already injects it on every prompt), searched in the deepest
 * registered Smart Tool project holding the files already read; `searchRoot` (relative, '' = the project dir) goes to the journal.
 */
async function build({ theme, root, exclude, maxTokens, maxChars }, { discover = require('./context-bundle.js').discoverSmartToolUrl } = {}) {
  const cb = require('./lib/context-bundle.js');
  const url = discover();
  const call = (u, name, args) => cb.mcpCallTool(u, name, args, { timeoutMs: SMART_TOOL_CALL_MS });
  const { root: searchRoot, sub } = await cb.registeredRoot({
    projectDir: root, reads: [...exclude], status: (dir) => call(url, 'project_manage', { action: 'status', project_root: dir }),
  });
  const bundle = await cb.buildBundle({
    theme, root, exclude, limits: { maxTokens, maxChars },
    deps: {
      smartSearch: async (t) => cb.prefixHits(await cb.smartSearch(t, searchRoot, { url, call, timeoutMs: SMART_TOOL_TOTAL_MS, limits: { ...cb.DEFAULT_LIMITS, maxTokens } }), sub),
      memory: async () => null,
    },
  });
  return { ...bundle, searchRoot: sub };
}

/**
 * @param {object} event hook payload
 * @param {{build?: Function, base?: string}} [deps] test seams
 * @returns {Promise<{context: string, notice: string}>}
 */
async function run(event, deps = {}) {
  const ev = event || {};
  const cfg = hooksConfig.getReadBurst();
  if (!cfg.enabled || ev.hook_event_name !== 'PostToolUse') return { context: '', notice: '' };
  const root = hookEnv().CLAUDE_PROJECT_DIR || ev.cwd || '';
  return readBurst.onTool(ev, { root, minCalls: cfg.minCalls, maxTokens: cfg.maxTokens, maxPerSession: cfg.maxPerSession, base: deps.base, build: deps.build || build });
}

module.exports = { run, build };
