'use strict';
/**
 * Is THIS session's brain-server MCP connection down for good?
 *
 * Claude Code retries a dropped HTTP MCP server 5 times (~16 s) and then gives up
 * ("Max reconnection attempts (5) reached, giving up"); a failed first connect
 * ("Connection failed …") is not retried either. The session then has no brain_*
 * tools until the user runs /mcp → Reconnect — even after the daemon is back — and
 * nobody told them (2026-10-05 outage). Claude Code writes every MCP client event,
 * tagged with the sessionId, to
 *   <cache>/claude-cli-nodejs/<cwd slug>/mcp-logs-plugin-claude-code-boss-brain-server/*.jsonl
 * so the last connect/give-up event of this session tells the state. Undocumented
 * log format → anything unexpected is 'unknown' (no notice), never a false alarm.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = 'mcp-logs-plugin-claude-code-boss-brain-server';
const DOWN = [/Max reconnection attempts .*giving up/i, /^Connection failed\b/];
const UP = [/^Connection established\b/, /^Reconnected \(attempt/, /reconnection successful/i, /^Successfully connected\b/];

/** Claude Code's cache root (env-paths layout of the `claude-cli-nodejs` app). */
function defaultCacheRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'claude-cli-nodejs', 'Cache') : null;
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'claude-cli-nodejs');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-cli-nodejs');
}

/** Claude Code's per-project folder name: every non-alphanumeric char → '-'. */
function cwdSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @returns {{state:'down'|'up'|'unknown', at?:string}}
 */
function linkState({ sessionId, cwd, cacheRoot = defaultCacheRoot() } = {}) {
  if (!sessionId || !cwd || !cacheRoot) return { state: 'unknown' };
  const dir = path.join(cacheRoot, cwdSlug(cwd), LOG_DIR);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 3).reverse();
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[mcp-link] cannot list ${dir}: ${err.message}`);
    return { state: 'unknown' };
  }
  let last = { state: 'unknown' };
  for (const { f } of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { console.error(`[mcp-link] cannot read ${f}: ${err.message}`); continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(sessionId)) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { void err; continue; }
      if (e.sessionId !== sessionId) continue;
      const msg = String(e.debug || e.error || '');
      if (DOWN.some((r) => r.test(msg))) last = { state: 'down', at: e.timestamp };
      else if (UP.some((r) => r.test(msg))) last = { state: 'up', at: e.timestamp };
    }
  }
  return last;
}

/**
 * The notice for a session whose link is down while the daemon is healthy (so a
 * reconnect WILL work). Null otherwise — a dead daemon is brain-daemon-ensure's
 * advisory, not this one.
 * @param {{sessionId:string, cwd:string, daemonHealthy:()=>Promise<boolean>, cacheRoot?:string}} o
 * @returns {Promise<{user:string, agent:string}|null>}
 */
async function linkNotice({ sessionId, cwd, daemonHealthy, cacheRoot }) {
  const s = linkState({ sessionId, cwd, ...(cacheRoot ? { cacheRoot } : {}) });
  if (s.state !== 'down') return null;
  if (!(await daemonHealthy())) return null;
  return {
    // One line: Claude Code prefixes every line of a hook systemMessage.
    user: 'claude-code-boss: a memória desta sessão desconectou e o Claude Code parou de tentar reconectar. '
      + 'O serviço já voltou — digite /mcp, escolha brain-server e Reconnect (ou abra uma nova sessão).',
    agent: `[BRAIN] This session's brain-server MCP connection is down: Claude Code gave up reconnecting (${s.at || 'time unknown'}). `
      + 'The brain daemon is healthy again, but brain_* tools stay unavailable in THIS session until the user runs '
      + '/mcp → brain-server → Reconnect, or opens a new session. Tell the user that in plain words; do not try to restart anything yourself.',
  };
}

module.exports = { linkState, linkNotice, cwdSlug, defaultCacheRoot, LOG_DIR };
