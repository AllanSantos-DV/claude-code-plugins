/**
 * lib/daemon-common.js — shared helpers for the HTTP daemon + its supervisor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic per-data-dir port in the private range (49152-65535) so two
 * different installs on the same machine don't collide. Override with
 * BRAIN_HTTP_PORT.
 */
export function resolvePort(dataDir) {
  const env = process.env.BRAIN_HTTP_PORT && Number(process.env.BRAIN_HTTP_PORT);
  if (env && env > 0) return env;
  const h = crypto.createHash('sha256').update(String(dataDir || 'default')).digest();
  return 49152 + (h.readUInt16BE(0) % (65535 - 49152));
}

/**
 * Lock/health file path. Lives in DATA_DIR (persistent across versions), NEVER in
 * the rotating/cleaned plugin cache — so any version's launcher can find it.
 */
export function lockFile(dataDir) {
  return path.join(dataDir, 'brain-http.lock.json');
}

export const HEALTH_PATH = '/health';
export const MCP_PATH = '/mcp';

// ─── Auth (same pattern as the dashboard: local token + host/origin guard) ───
// The daemon binds 127.0.0.1, but "localhost-only" is not authorization: any
// local process — or a browser page via DNS rebinding — could otherwise call
// /mcp (read/poison the KB) or /shutdown. Token lives in DATA_DIR next to the
// lock file; every same-user consumer (supervisor, OpenCode, curl) reads it
// from disk. Override/fix with BRAIN_HTTP_TOKEN (e.g. containerized clients).

/** Token file path — DATA_DIR, persistent across plugin versions (like the lock). */
export function tokenFile(dataDir) {
  return path.join(dataDir, 'brain-http.token');
}

/** Read the shared token (env override first); null when absent. */
export function readToken(dataDir) {
  const env = (process.env.BRAIN_HTTP_TOKEN || '').trim();
  if (env) return env;
  try {
    const tok = fs.readFileSync(tokenFile(dataDir), 'utf8').trim();
    return tok || null;
  } catch (e) { void e; return null; }
}

/** Read-or-create the shared token (daemon boot path). */
export function ensureToken(dataDir) {
  const existing = readToken(dataDir);
  if (existing) return existing;
  const tok = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile(dataDir), tok, { mode: 0o600 });
  } catch (e) { void e; /* fs failure → token still enforced for this run */ }
  return tok;
}

function timingSafeEq(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Gate a request: local Origin (when present — browsers send it, native
 * clients don't; a foreign Origin means DNS rebinding) + constant-time token
 * match from `Authorization: Bearer <t>` or `X-Brain-Token`.
 * @returns {{ ok:true } | { ok:false, code:number, error:string }}
 */
export function requestAllowed(req, token, dataDir) {
  const origin = req.headers && req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(String(origin))) {
    return { ok: false, code: 403, error: 'forbidden origin (DNS-rebinding guard)' };
  }
  const bearer = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  const given = (req.headers && req.headers['x-brain-token']) || bearer;
  if (!token || !timingSafeEq(given, token)) {
    return { ok: false, code: 401, error: `missing/invalid token — read it from ${tokenFile(dataDir || '<DATA_DIR>')} and send Authorization: Bearer <token>` };
  }
  return { ok: true };
}
