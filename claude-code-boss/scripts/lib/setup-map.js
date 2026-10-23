'use strict';
/**
 * setup-map.js — what the user's setup gives the agent to LOOK THINGS UP and to REMEMBER, in one snapshot:
 * Smart Tool (semantic search + symbol graph), the memory backend (local SQLite or mcp-memory), the code graph
 * (mcp-memory only) and the standing rules (CLAUDE.md / AGENTS.md / active policies).
 *
 * Used by the Doctor to say whether the setup is complete, and by anything that wants to shape an instruction to
 * the tools the user really has (`capabilities`): with none of them the instruction still works through Grep/Read.
 *
 * Every probe is injectable (hermetic tests) and best-effort: a failed probe is reported in `errors`, never thrown
 * and never turned into a plausible "all fine".
 */
const os = require('os');

const SMART_TOOL_NAME = /smart[-_]?tool/i;

/**
 * @returns {Promise<{
 *   smartTool: {configured: boolean, servers: string[], reachable: boolean|null},
 *   memory: {backend: 'local'|'mcp-memory', connected: boolean|null, reason: string, scope: {id: string|null, strength: string, optedOut: boolean}},
 *   graph: {applicable: boolean, state: string, nodes: number},
 *   rules: {files: Array<{path:string,tokens:number}>, policies: number},
 *   errors: string[]
 * }>}
 */
async function gatherSetup({
  home = os.homedir(),
  cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  listServers = (o) => require('./fixed-cost.js').listMcpServers(o),
  listInstructions = (o) => require('./fixed-cost.js').listInstructionFiles(o),
  tcpProbe = (port, ms) => require('./mcp-health.js').probeTcpPort(port, ms),
  derivePort = (url) => require('./mcp-health.js')._derivePort(url),
  loadBrainConfig = () => require('../../engine/lib/brain-config.js').load(),
  probeMemory = (cfg) => require('./mcp-health.js').probeHealth(cfg),
  graphProbe = (c) => require('./graph-guard-core.js').makeGraphStateProbe({ cwd: c, timeoutMs: 3000 })(),
  resolveScope = (c) => {
    const pid = require('../../engine/lib/project-id.js');
    return { id: pid.tryResolveProjectId({ cwd: c }), strength: pid.projectIdStrength({ cwd: c }), optedOut: pid.memoryOptedOut({ cwd: c }) };
  },
  countPolicies = (c) => {
    const policyStore = require('../../engine/lib/policy-store.js');
    let projectId = 'default';
    try { projectId = require('../../engine/lib/project-id.js').resolveLocalScopeId({ cwd: c }) || 'default'; } catch (e) { void e; }
    return policyStore.listAlways(require('../../engine/lib/data-dir.js').dataDir(), { projectId }).length;
  },
} = {}) {
  const errors = [];
  const out = {
    smartTool: { configured: false, servers: [], reachable: null },
    memory: { backend: 'local', connected: null, reason: '', scope: { id: null, strength: 'none', optedOut: false } },
    graph: { applicable: false, state: 'n/a', nodes: 0 },
    rules: { files: [], policies: 0 },
    errors,
  };

  try {
    const { servers, errors: e } = listServers({ home, cwd });
    errors.push(...e);
    const found = servers.filter((s) => SMART_TOOL_NAME.test(s.name) && !s.disabled);
    out.smartTool.configured = found.length > 0;
    out.smartTool.servers = found.map((s) => s.name);
    const http = found.find((s) => s.config && s.config.url);
    if (http) {
      const port = derivePort(String(http.config.url).replace(/\$\{[^}]*\}/g, ''));
      out.smartTool.reachable = Number.isInteger(port) ? !!(await tcpProbe(port, 1500)) : null;
    }
  } catch (err) { errors.push(`smart-tool: ${err.message}`); }

  let cfg = null;
  try {
    cfg = loadBrainConfig();
    out.memory.backend = (cfg && cfg.backend && cfg.backend.type) === 'mcp-memory' ? 'mcp-memory' : 'local';
  } catch (err) { errors.push(`brain-config: ${err.message}`); }
  if (out.memory.backend === 'mcp-memory') {
    try {
      const h = await probeMemory(cfg);
      out.memory.connected = !!h.connected;
      out.memory.reason = h.connected ? '' : String((h.details && (h.details.reason || (h.details.jarExists === false ? 'no server running and no jar installed' : ''))) || 'not connected');
    } catch (err) { errors.push(`memory: ${err.message}`); }
    out.graph.applicable = true;
    if (out.memory.connected) {
      try {
        const g = await graphProbe(cwd);
        out.graph.state = (g && g.state) || 'offline';
        out.graph.nodes = (g && g.nodes) || 0;
      } catch (err) { errors.push(`graph: ${err.message}`); out.graph.state = 'error'; } // the server ANSWERED with an error: not "offline"
    } else {
      out.graph.state = 'offline';
    }
  } else {
    out.memory.connected = true; // local SQLite lives inside the plugin: connected by design
  }

  // Memory is per FOLDER: with no project id (and no opt-out) it is off here, whatever the backend says.
  try { out.memory.scope = resolveScope(cwd); } catch (err) { errors.push(`memory scope: ${err.message}`); }

  try {
    const { files, errors: e } = listInstructions({ home, cwd });
    errors.push(...e);
    out.rules.files = files;
  } catch (err) { errors.push(`instruction files: ${err.message}`); }
  try { out.rules.policies = countPolicies(cwd); } catch (err) { errors.push(`policies: ${err.message}`); }

  return out;
}

/**
 * The lookup the agent can lean on, best first, and whether the user already gave it rules.
 * `lookup` is advice for an instruction, never a gate: 'grep' is always available.
 * @param {object} setup output of gatherSetup (or null)
 * @returns {{lookup: 'smart_search'|'graph'|'grep', hasRules: boolean, tools: string[]}}
 */
function capabilities(setup) {
  const s = setup || {};
  const tools = [];
  if (s.smartTool && s.smartTool.configured && s.smartTool.reachable !== false) tools.push('smart_search');
  if (s.graph && s.graph.applicable && s.graph.state === 'ready') tools.push('graph');
  const hasRules = !!(s.rules && ((s.rules.files || []).length > 0 || s.rules.policies > 0));
  return { lookup: tools[0] || 'grep', hasRules, tools };
}

module.exports = { gatherSetup, capabilities, SMART_TOOL_NAME };
