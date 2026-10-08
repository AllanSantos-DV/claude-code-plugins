'use strict';
/**
 * backup-remote.js — the mcp-memory part of a backup, done BY the server (it owns its
 * database). Contract: docs/BACKUP-CONTRACT.md — tools `backup_export` / `backup_import`.
 * A server without them is reported as "not included", never faked.
 *
 * The server snapshot is large (6 GB memory.db → 4.2 GB VACUUM INTO, measured 2026-10-06), so
 * the calls get a long timeout and the snapshot only ever moves as a FILE (never a buffer).
 * Any failure of the remote part is reported in the archive ("not included" + reason) and
 * never takes the local backup down with it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256File } = require('./file-hash.js');

const EXPORT_TOOL = 'backup_export';
const IMPORT_TOOL = 'backup_import';
const REMOTE_TIMEOUT_MS = Number(process.env.CCB_BACKUP_REMOTE_TIMEOUT_MS) || 60 * 60 * 1000;

function parse(result) {
  try { return JSON.parse((result && result.text) || '{}'); } catch (err) { return { error: `unparseable reply: ${err.message}` }; }
}


/** Connected MCP client to the configured mcp-memory daemon, or null when not on that backend. */
async function connect({ pluginRoot, loadConfig, discoverUrl, McpClient, timeoutMs = REMOTE_TIMEOUT_MS }) {
  const cfg = (loadConfig() || {}).backend || {};
  if (cfg.type !== 'mcp-memory') return null;
  const Client = McpClient || require(path.join(pluginRoot, 'scripts', 'mcp-client.js'));
  const mcp = cfg.mcpMemory || {};
  const client = new Client({ transport: 'http', serverUrl: mcp.serverUrl || discoverUrl() || '', runDir: mcp.runDir || '', projectId: 'default', timeout: timeoutMs });
  await client.connect();
  return client;
}

const hasTool = (client, name) => (client._availableTools || []).some((t) => (t.name || t) === name);

/**
 * Ask the server for a snapshot file. Returns the `remote` descriptor for createBackup.
 * @returns {Promise<{kind:string, included:boolean, reason?:string, file?:string, serverVersion?:string}>}
 */
async function exportRemote(opts) {
  let client;
  try { client = await connect(opts); } catch (err) { return { kind: 'mcp-memory', included: false, reason: `memory server unreachable: ${err.message}` }; }
  if (!client) return { kind: 'none', included: false };
  const destPath = path.join(opts.tmpDir, `mcp-memory-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.snapshot`);
  const notIncluded = (reason) => { fs.rmSync(destPath, { force: true }); return { kind: 'mcp-memory', included: false, reason }; };
  try {
    if (!hasTool(client, EXPORT_TOOL)) return notIncluded(`the memory server has no ${EXPORT_TOOL} tool yet — its data is NOT in this backup`);
    if (opts.onProgress) opts.onProgress('the memory server is writing its snapshot (large databases take minutes)');
    let r;
    try { r = parse(await client.callTool(EXPORT_TOOL, { destPath })); }
    catch (err) { return notIncluded(`${EXPORT_TOOL} did not finish: ${err.message}`); }
    if (r.error || !fs.existsSync(destPath)) return notIncluded(`${EXPORT_TOOL} failed: ${r.error || 'no file written'}`);
    if (r.sha256 && (await sha256File(destPath)) !== String(r.sha256).toLowerCase()) return notIncluded(`${EXPORT_TOOL} checksum mismatch`);
    return { kind: 'mcp-memory', included: true, file: destPath, serverVersion: r.serverVersion || '' };
  } finally {
    client.close();
  }
}

/** Hand a restored snapshot FILE back to the server. Throws (fail-loud) when it cannot. */
async function importRemote(snapshotFile, opts) {
  if (!snapshotFile || !fs.existsSync(snapshotFile)) throw new Error('this backup says it includes memory-server data, but the snapshot is missing');
  const client = await connect(opts);
  if (!client) throw new Error('this backup includes memory-server data, but the plugin is not on the mcp-memory backend — enable it, then restore again');
  try {
    if (!hasTool(client, IMPORT_TOOL)) throw new Error(`this backup includes memory-server data, but the server has no ${IMPORT_TOOL} tool — update the server, then restore again`);
    const r = parse(await client.callTool(IMPORT_TOOL, { srcPath: path.resolve(snapshotFile), mode: 'replace' }));
    if (r.error || r.restored !== true) throw new Error(`${IMPORT_TOOL} failed: ${r.error || JSON.stringify(r)}`);
    return r;
  } finally {
    client.close();
  }
}

module.exports = { exportRemote, importRemote, EXPORT_TOOL, IMPORT_TOOL, REMOTE_TIMEOUT_MS };
