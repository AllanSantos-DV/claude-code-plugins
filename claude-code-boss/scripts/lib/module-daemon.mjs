// The brain daemon's address and local token, for function-hook MODULES (hooks/*.mjs): they run
// with no Node, so they reach the boss over HTTP through the module's `$` (`$.env`, `$.fs`, `$.http`).
// Shared by hooks/compaction.mjs and hooks/boss.mjs.

const slashes = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
// A local absolute path: a drive (C:/…) or a POSIX root — never a UNC/network path (//host/…).
const isLocalAbsolute = (p) => /^[A-Za-z]:\//.test(p) || (/^\/(?!\/)/.test(p));
const msg = (err) => String(err && err.message ? err.message : err);

/**
 * The boss data dir from LOCAL state — CLAUDE_PLUGIN_DATA, else the pointer the boss publishes in
 * the user's home (lib/data-dir.js) — never from /health, which is open: whatever holds the port
 * could name any path, and reading a UNC path makes Windows hand the user's NTLM hash to that host
 * (pre-release audit 3.1.0).
 * @param {object} $  the module's ops
 * @param {string} label  the module's name in its log lines
 * @returns {Promise<string|null>} forward-slashed dir, or null when unknown (the caller does not act)
 */
export async function localDataDir($, label) {
  const env = String((await $.env.get('CLAUDE_PLUGIN_DATA')) || '').trim();
  if (env && !env.includes('${')) return slashes(env);
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
  if (!home) return null;
  try {
    const ptr = JSON.parse(await $.fs.read(`${slashes(home)}/.claude/claude-code-boss/active-data-dir.json`));
    return ptr && typeof ptr.dir === 'string' && ptr.dir.trim() ? slashes(ptr.dir.trim()) : null;
  } catch (err) {
    $.ui.log(`${label}: boss data-dir pointer unreadable: ${msg(err)}`);
    return null;
  }
}

/**
 * The daemon's address and local token. The hook_* tools are unlisted (never the model's), and a
 * module's $.mcp.call only reaches listed tools — so a module calls the daemon's /hook/* routes,
 * behind the same token gate as /mcp. The token is read only from the LOCAL data dir, and used
 * only when the process on the port names that same dir in /health.
 * @param {object} $  the module's ops
 * @param {object} holder  per-session state (caches `holder.daemon = { base, token }`)
 * @param {boolean} [refresh]  re-read after a 401 (the daemon restarted with a new token)
 * @param {string} [label]  the module's name in its log lines
 * @returns {Promise<{base: string, token: string}>}
 */
export async function daemon($, holder, refresh = false, label = 'boss') {
  if (holder.daemon && !refresh) return holder.daemon;
  const port = Number(await $.env.get('BRAIN_HTTP_PORT')) || 38217;
  const base = `http://127.0.0.1:${port}`;
  const local = await localDataDir($, label);
  if (!local) throw new Error('boss data dir unknown (no CLAUDE_PLUGIN_DATA, no published pointer) — not reading the token');
  if (!isLocalAbsolute(local)) throw new Error(`boss data dir is not a local absolute path (${local}) — refused`);
  const h = await $.http.fetch(`${base}/health`);
  if (!h.ok) throw new Error(`brain daemon /health answered ${h.status} on port ${port}`);
  const { dataDir } = JSON.parse(h.text);
  if (!dataDir || slashes(dataDir).toLowerCase() !== local.toLowerCase()) {
    throw new Error(`the process on port ${port} names another data dir (${dataDir}) than this machine's boss (${local}) — not sending the token`);
  }
  const token = (await $.fs.read(`${local}/brain-http.token`)).trim();
  holder.daemon = { base, token };
  return holder.daemon;
}
