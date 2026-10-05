'use strict';
/**
 * backup-remote.js — the mcp-memory part of a backup, done BY the server (it owns its
 * database). Contract: docs/BACKUP-CONTRACT.md — tools `backup_export` / `backup_import`.
 * A server without them is reported as "not included", never faked.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXPORT_TOOL = 'backup_export';
const IMPORT_TOOL = 'backup_import';

function parse(result) {
  try { return JSON.parse((result && result.text) || '{}'); } catch (err) { return { error: `unparseable reply: ${err.message}` }; }
}

/** Connected MCP client to the configured mcp-memory daemon, or null when not on that backend. */
async function connect({ pluginRoot, loadConfig, discoverUrl, McpClient }) {
  const cfg = (loadConfig() || {}).backend || {};
  if (cfg.type !== 'mcp-memory') return null;
  const Client = McpClient || require(path.join(pluginRoot, 'scripts', 'mcp-client.js'));
  const mcp = cfg.mcpMemory || {};
  const client = new Client({ transport: 'http', serverUrl: mcp.serverUrl || discoverUrl() || '', runDir: mcp.runDir || '', projectId: 'default', timeout: 120000 });
  await client.connect();
  return client;
}

const hasTool = (client, name) => (client._availableTools || []).some((t) => (t.name || t) === name);

/**
 * Ask the server for a snapshot file. Returns the `remote` descriptor for createBackup.
 * @returns {Promise<{kind:string, included:boolean, reason?:string, file?:string}>}
 */
async function exportRemote(opts) {
  let client;
  try { client = await connect(opts); } catch (err) { return { kind: 'mcp-memory', included: false, reason: `memory server unreachable: ${err.message}` }; }
  if (!client) return { kind: 'none', included: false };
  try {
    if (!hasTool(client, EXPORT_TOOL)) return { kind: 'mcp-memory', included: false, reason: `the memory server has no ${EXPORT_TOOL} tool yet — its data is NOT in this backup` };
    const destPath = path.join(opts.tmpDir, `mcp-memory-${Date.now()}.snapshot`);
    const r = parse(await client.callTool(EXPORT_TOOL, { destPath }));
    if (r.error || !fs.existsSync(destPath)) return { kind: 'mcp-memory', included: false, reason: `${EXPORT_TOOL} failed: ${r.error || 'no file written'}` };
    if (r.sha256) {
      const got = crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');
      if (got !== String(r.sha256).toLowerCase()) return { kind: 'mcp-memory', included: false, reason: `${EXPORT_TOOL} checksum mismatch` };
    }
    return { kind: 'mcp-memory', included: true, file: destPath, serverVersion: r.serverVersion || '' };
  } finally {
    client.close();
  }
}

/** Hand a restored snapshot back to the server. Throws (fail-loud) when it cannot. */
async function importRemote(snapshot, opts) {
  const client = await connect(opts);
  if (!client) throw new Error('this backup includes memory-server data, but the plugin is not on the mcp-memory backend — enable it, then restore again');
  try {
    if (!hasTool(client, IMPORT_TOOL)) throw new Error(`this backup includes memory-server data, but the server has no ${IMPORT_TOOL} tool — update the server, then restore again`);
    const srcPath = path.join(opts.tmpDir, `mcp-memory-restore-${Date.now()}.snapshot`);
    fs.writeFileSync(srcPath, snapshot);
    try {
      const r = parse(await client.callTool(IMPORT_TOOL, { srcPath, mode: 'replace' }));
      if (r.error || r.restored !== true) throw new Error(`${IMPORT_TOOL} failed: ${r.error || JSON.stringify(r)}`);
      return r;
    } finally {
      fs.rmSync(srcPath, { force: true });
    }
  } finally {
    client.close();
  }
}

module.exports = { exportRemote, importRemote, EXPORT_TOOL, IMPORT_TOOL };
