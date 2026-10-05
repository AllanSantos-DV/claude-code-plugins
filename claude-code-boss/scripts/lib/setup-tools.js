'use strict';
/**
 * setup-tools.js — tools that let the AGENT set the plugin up for the user, instead of
 * sending a non-technical user to the dashboard:
 *   backend_status / backend_setup / backend_setup_status — enable the mcp-memory server
 *     (graph tools, compose recall, ingestion) end to end: Java check, download, start,
 *     switch the backend, restart the brain daemon so it loads the new backend.
 *   project_list / project_set — name a folder that has no project id (no git remote),
 *     checking the name against the projects already in memory.
 * Same shape as lib/graph/tools.js: { definitions, names, handle(name,args) }.
 */
const fs = require('fs');
const path = require('path');

function text(s) { return { content: [{ type: 'text', text: s }] }; }
function fail(s) { return { isError: true, content: [{ type: 'text', text: s }] }; }

const OFF_ON_LOCAL = 'graph tools (graph_*: code graph, callers, references), compose recall (two-level memory), '
  + 'conversation ingestion and the local→server migration';

/** The command that installs Java 21 on this OS (the agent runs it, with the user's OK). */
function javaInstallCommand(platform = process.platform) {
  if (platform === 'win32') return 'winget install --id EclipseAdoptium.Temurin.21.JRE -e --accept-source-agreements --accept-package-agreements';
  if (platform === 'darwin') return 'brew install --cask temurin@21';
  return 'sudo apt-get install -y openjdk-21-jre-headless   # Debian/Ubuntu (Fedora: sudo dnf install -y java-21-openjdk-headless)';
}

const DEFINITIONS = [
  {
    name: 'backend_status',
    description: 'Show which memory backend this plugin uses (local SQLite or the mcp-memory server), whether Java 21+ and the server are installed/running, and which features are OFF on the local backend. Call it when the user asks about graph tools/memory features, or before offering backend_setup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'backend_setup',
    description: 'Enable the full memory server (mcp-memory) for the user: checks Java 21+, downloads the server (~57 MB; ~530 MB GPU build when an NVIDIA GPU is present), starts it, and switches the plugin backend to it. Ask the user first. Runs in the background — then poll backend_setup_status. If Java is missing it returns the exact install command to run, then call it again.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'backend_setup_status',
    description: 'Progress of backend_setup. Poll every ~5-10 s until it reports done or failed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_list',
    description: 'List the projects that already exist in memory (local and, on the mcp-memory backend, the server) and say whether the given folder has a project id. Use it before project_set to spot a folder that continues an existing project.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'The folder to check (your working directory)' } } },
  },
  {
    name: 'project_set',
    description: 'Give a folder WITHOUT a project id (no git remote) its project name, turning memory on there (writes .memory/project.json). Use only the name the user confirmed (e.g. "loja-online" — no owner/org needed). If the name already exists in memory, it is refused unless link:true, meaning the user confirmed this folder IS that project (a migration/continuation).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'The folder to name (your working directory)' },
        name: { type: 'string', description: 'The project name the user confirmed' },
        link: { type: 'boolean', description: 'true = the user confirmed this folder is the EXISTING project with this name' },
      },
      required: ['cwd', 'name'],
    },
  },
];

function createSetupTools({ pluginRoot, requestRestart = () => {}, deps = {} } = {}) {
  const lib = (m) => require(path.join(pluginRoot, 'scripts', 'lib', m));
  const wizard = deps.wizard || lib('mcp-wizard.js');
  const loadConfig = deps.loadConfig || (() => lib('brain-config.js').load());
  const dataDir = deps.dataDir || (() => lib('data-dir.js').dataDir());
  const health = deps.health || (async (url) => {
    const r = await lib('http-health.js').probeHealth(url, { timeoutMs: 3000 });
    if (r.status !== 200) return null;
    try { return JSON.parse(r.body); } catch (err) { void err; return {}; }
  });
  const platform = deps.platform || process.platform;
  const pid = deps.projectId || lib('project-id.js');

  const backendType = () => {
    const b = (loadConfig() || {}).backend || {};
    return b.type === 'mcp-memory' ? 'mcp-memory' : 'local';
  };

  async function daemonInfo() {
    const url = wizard.discoverDaemonUrl();
    if (!url) return { running: false };
    const h = await health(url);
    return h ? { running: true, url, version: h.version || '?' } : { running: false, url };
  }

  async function remoteProjects() {
    if (deps.remoteProjects) return deps.remoteProjects();
    const McpClient = require(path.join(pluginRoot, 'scripts', 'mcp-client.js'));
    const mcp = ((loadConfig() || {}).backend || {}).mcpMemory || {};
    const client = new McpClient({ transport: 'http', serverUrl: mcp.serverUrl || wizard.discoverDaemonUrl() || '', runDir: mcp.runDir || '', projectId: 'default', timeout: 15000 });
    try {
      await client.connect();
      const r = await client.callTool('list_projects', {});
      const data = JSON.parse((r && r.text) || '{}');
      return Array.isArray(data.data) ? data.data : [];
    } finally {
      client.close();
    }
  }

  function localProjects() {
    if (deps.localProjects) return deps.localProjects();
    return lib('brain-projects.js').listBrainProjects(path.join(dataDir(), 'brain')).filter((p) => p !== '__user__');
  }

  /** Every known project id; remote failures are reported, never hidden. */
  async function knownProjects() {
    const local = localProjects();
    let remote = [];
    let remoteError = null;
    if (backendType() === 'mcp-memory') {
      try { remote = await remoteProjects(); } catch (err) { remoteError = err.message; }
    }
    return { all: [...new Set([...local, ...remote])].sort(), local, remote, remoteError };
  }

  let restartedFor = null;

  async function handle(name, args = {}) {
    switch (name) {
      case 'backend_status': {
        const type = backendType();
        const [java, daemon] = await Promise.all([wizard.checkJava(), daemonInfo()]);
        const lines = [
          `Backend: ${type === 'local' ? 'local (SQLite, built in)' : 'mcp-memory (server)'}`,
          `Java 21+: ${java.ok ? `found (${java.version})` : `missing — ${java.error}`}`,
          `mcp-memory server: ${daemon.running ? `running v${daemon.version} at ${daemon.url}` : 'not running'}`,
        ];
        if (type === 'local') {
          lines.push(`OFF on the local backend: ${OFF_ON_LOCAL}.`);
          lines.push('Next: explain this to the user in plain words and offer to enable the memory server; with their OK call backend_setup.');
        }
        return text(lines.join('\n'));
      }

      case 'backend_setup': {
        const daemon = await daemonInfo();
        if (backendType() === 'mcp-memory' && daemon.running) return text(`Already enabled: backend is mcp-memory, server v${daemon.version} running at ${daemon.url}.`);
        const java = await wizard.checkJava();
        if (!java.ok) {
          return text([
            `Java 21+ is needed first (${java.error}).`,
            `Install it with (ask the user's OK — it installs system software): ${javaInstallCommand(platform)}`,
            'Then call backend_setup again — no restart needed (the standard install folders are searched).',
          ].join('\n'));
        }
        const st = await wizard.start('default');
        if (st.status === 'failed') return fail(`Setup could not start: ${st.error}`);
        return text('Setup started (download → start → switch backend). Poll backend_setup_status every ~5-10 s and tell the user it may take a minute or two on the first download.');
      }

      case 'backend_setup_status': {
        const st = wizard.getState();
        const steps = (st.details || []).map((d) => `  ${d.status === 'ok' ? '✓' : d.status === 'error' ? '✗' : '…'} ${d.detail || d.message || ''}`).join('\n');
        if (st.status === 'completed') {
          if (restartedFor !== st.finishedAt) {
            restartedFor = st.finishedAt;
            requestRestart();
          }
          return text(`Done: the memory server is enabled (backend mcp-memory).\n${steps}\nThe brain service restarts now to load it — Claude Code reconnects by itself in a few seconds. Graph tools and compose recall work from the next call. If brain tools disappear in this session, the user can run /mcp → brain-server → Reconnect.`);
        }
        if (st.status === 'failed') return fail(`Setup failed: ${st.error}\n${steps}\nTell the user what failed in plain words; backend_setup can be called again after fixing it.`);
        // The wizard's per-step _emit writes 'running'/'ok' into status while it works.
        if (!st.status || st.status === 'idle') return text('No setup has run yet. Call backend_setup.');
        return text(`Running (step ${st.step}/${st.total}):\n${steps}`);
      }

      case 'project_list': {
        const known = await knownProjects();
        const lines = [`Projects in memory (${known.all.length}): ${known.all.join(', ') || '(none yet)'}`];
        if (known.remoteError) lines.push(`(could not read the server's project list: ${known.remoteError})`);
        if (args.cwd) {
          const id = pid.tryResolveProjectId({ cwd: args.cwd });
          lines.push(id
            ? `This folder's project id: ${id} (${pid.projectIdStrength({ cwd: args.cwd })}) — memory is ON here.`
            : 'This folder has NO project id — memory is OFF here until project_set names it.');
        }
        return text(lines.join('\n'));
      }

      case 'project_set': {
        const cwd = String(args.cwd || '').trim();
        if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return fail(`cwd must be an existing absolute folder (got ${JSON.stringify(args.cwd)})`);
        const current = pid.tryResolveProjectId({ cwd });
        if (current) return fail(`This folder already has project id "${current}" (${pid.projectIdStrength({ cwd })}) — nothing to set.`);
        const id = pid.sanitizeLogicalProjectId(args.name);
        if (!id) return fail(`Invalid project name ${JSON.stringify(args.name)} — use letters, numbers, - _ . and optional / segments.`);
        const known = await knownProjects();
        if (known.remoteError) return fail(`Could not check the name against the server's projects (${known.remoteError}) — not writing, to avoid a silent collision. Try again.`);
        const exists = known.all.includes(id);
        if (exists && !args.link) {
          return fail(`A project named "${id}" already exists in memory. Ask the user: is this folder that same project (a migration/continuation)? If yes, call project_set again with link:true; if not, pick a different name with them.`);
        }
        const root = pid.findProjectRoot({ cwd }) || cwd;
        const memDir = path.join(root, '.memory');
        fs.mkdirSync(memDir, { recursive: true });
        const file = path.join(memDir, 'project.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') return fail(`Existing ${file} is unreadable (${err.message}) — fix or remove it first.`); }
        cfg.version = cfg.version || '1';
        cfg.metadata = { ...(cfg.metadata || {}), defaults: { ...((cfg.metadata || {}).defaults || {}), project_id: id } };
        lib('atomic-write.js').writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
        // The user chose to name it: an earlier "no memory here" marker no longer applies.
        try { fs.unlinkSync(path.join(memDir, 'memory-off.json')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        const now = pid.tryResolveProjectId({ cwd });
        if (now !== id) return fail(`Wrote ${file} but the folder resolves to ${JSON.stringify(now)}, not "${id}" — check for a parent .memory/project.json.`);
        return text(`Memory is ON for this folder as project "${id}" (${exists ? 'linked to the existing project' : 'new project'}). Written: ${file}`);
      }

      default:
        return fail(`unknown setup tool: ${name}`);
    }
  }

  return { definitions: DEFINITIONS, names: new Set(DEFINITIONS.map((d) => d.name)), handle };
}

module.exports = { createSetupTools, DEFINITIONS, javaInstallCommand, OFF_ON_LOCAL };
