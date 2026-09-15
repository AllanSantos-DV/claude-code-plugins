#!/usr/bin/env node
/**
 * brain-daemon-ensure.js — SessionStart hook.
 *
 * .mcp.json declares `brain-server` as a direct "type":"http" URL (no
 * `command`, no per-session process — ADR-001 "daemon único"). Something
 * still has to make sure the ONE shared daemon is actually listening on that
 * fixed port BEFORE Claude Code's MCP client tries to connect at session
 * start — that something is this hook. It is itself EPHEMERAL (runs, ensures,
 * exits — it is not a resident runtime, so it does not itself violate the
 * daemon-único principle it exists to serve).
 *
 * Delegates entirely to lib/daemon-supervisor.js's ensureDaemon() — the same
 * version-aware find-or-start/swap logic already used elsewhere; no new
 * daemon-lifecycle code here.
 *
 * Fail-open: any error just means the session's first KB tool call can fail and
 * retry on a later prompt (the next SessionStart/UserPromptSubmit re-emits this
 * hook); this hook must never block a session start.
 */
'use strict';

const path = require('path');
const { readStdin, emitEmpty, emitJson, parsePayload } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

async function main() {
  let eventName = 'SessionStart';
  try {
    const raw = await readStdin();
    const event = parsePayload(raw) || {};
    eventName = event.hook_event_name || eventName;

    const root = pluginRoot();
    const data = dataDir();
    const fileUrl = require('url').pathToFileURL(
      path.join(root, 'servers', 'brain-server', 'lib', 'daemon-supervisor.js'),
    ).href;
    const { ensureDaemon } = await import(fileUrl);

    const result = await ensureDaemon({ pluginRoot: root, dataDir: data });

    if (result.status === 'error') {
      emitJson({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            `[BRAIN] daemon único não pôde ser garantido (${result.error}) — a sessão tentará ` +
            'conectar ao brain-server mesmo assim; se falhar, rode `node servers/brain-server/index.js` ' +
            'manualmente e veja o erro.',
        },
      });
      return;
    }
    emitEmpty();
  } catch (err) {
    console.error(`[brain-daemon-ensure] ${err.message}`);
    emitEmpty(); // never block session start
  }
}

if (require.main === module) main();

module.exports = { pluginRoot };
