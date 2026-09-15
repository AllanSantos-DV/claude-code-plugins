/**
 * lib/daemon-common.js — shared helpers for the HTTP daemon + its supervisor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonicalize a data dir so the SAME directory spelled differently (forward vs
 * back slashes, relative vs absolute, mixed case on Windows) maps to ONE
 * identity. Without this, `tokenFile`/`identityKey` derive a DIFFERENT token
 * file and identity per spelling — the lockfile records `C:/Users/...` while
 * callers pass `C:\Users\...`, so the daemon and its clients read different
 * token/lock files (→ 401s). `path.resolve` makes the path absolute and unifies
 * separators to the platform's; on Windows (case-insensitive FS) we also
 * case-fold. Fail loud on a missing/"undefined" dir: deriving anything from
 * `String(undefined)` used to spawn a plausible-looking phantom daemon.
 *
 * `resolvePort` is now a FIXED constant (see below) and does not depend on the
 * spelling — but it STILL validates the dir through `identityKey` so an unset
 * data dir fails loud instead of silently booting on the default port.
 */
export function canonicalDataDir(dataDir) {
  const raw = dataDir == null ? '' : String(dataDir).trim();
  if (!raw || raw === 'undefined' || raw === 'null') {
    throw new Error(
      `brain daemon: dataDir is required but got ${JSON.stringify(dataDir)} — refusing to `
      + 'derive a port/token from an unset data dir (would spawn a phantom daemon).',
    );
  }
  return path.resolve(raw);
}

/** Case-folded canonical form used ONLY as the hash/identity key (never as a real fs path). */
function identityKey(dataDir) {
  const canon = canonicalDataDir(dataDir);
  return process.platform === 'win32' ? canon.toLowerCase() : canon;
}

/**
 * FIXED port for the brain-http daemon (same pattern as model-router's
 * FIXED_PORT: a single, well-known port a static .mcp.json entry can point
 * "type":"http" at directly, with zero per-session process spawn). DATA_DIR
 * itself is already ONE global path per machine (not per-project — see
 * index.js's default), so the daemon is genuinely a machine-wide singleton;
 * a fixed port matches that reality instead of hiding it behind a hash only
 * this process could recompute. Override with BRAIN_HTTP_PORT (e.g. a second
 * install on the same machine, or tests).
 *
 * `dataDir` is still validated (via identityKey/canonicalDataDir) so a
 * missing/undefined data dir fails loud here too, same as before — only the
 * PORT computation stopped depending on it.
 *
 * env is injectable (second arg) so tests/helpers can pin a port without
 * mutating process.env — the runner executes tests sequentially but still
 * guards against env races.
 */
export const DEFAULT_PORT = 58217;
export function resolvePort(dataDir, env = process.env) {
  identityKey(dataDir); // throws on missing/invalid dataDir — see canonicalDataDir
  const e = env.BRAIN_HTTP_PORT && Number(env.BRAIN_HTTP_PORT);
  if (e && e > 0 && e <= 65535) return e;
  return DEFAULT_PORT;
}

/**
 * Lock/health file path. Lives in DATA_DIR (persistent across versions), NEVER in
 * the rotating/cleaned plugin cache — so any version's launcher can find it.
 */
export function lockFile(dataDir) {
  return path.join(canonicalDataDir(dataDir), 'brain-http.lock.json');
}

export const HEALTH_PATH = '/health';
export const MCP_PATH = '/mcp';

// ─── Auth (same pattern as the dashboard: local token + host/origin guard) ───
// The daemon binds 127.0.0.1, but "localhost-only" is not authorization: any
// local process could otherwise call /mcp (read/poison the KB) or /shutdown.
//
// Trust model (accept-the-limit): /mcp is gated by originAllowed() alone —
// a static .mcp.json "type":"http" URL cannot carry a runtime secret, so the
// endpoint deliberately trades the token for (127.0.0.1 bind + origin guard).
// The remaining exposure is ANY process that can reach loopback (including a
// different OS user) and any content served from a localhost origin (e.g. an
// untrusted page previewed through a local dev server). That is the documented
// MACHINE-TRUST boundary — see README §Auth. Browser cross-origin reads stay
// closed: the daemon emits no Access-Control-Allow-Origin and non-simple MCP
// POSTs trigger CORS preflight, which fails without it. /shutdown (destructive,
// never called by Claude Code's MCP client) keeps the full token gate.
// Token lives in DATA_DIR next to the lock file; every same-user consumer
// (supervisor, curl) reads it from disk. Override/fix with BRAIN_HTTP_TOKEN.

/** Token file path — DATA_DIR, persistent across plugin versions (like the lock). */
export function tokenFile(dataDir) {
  return path.join(canonicalDataDir(dataDir), 'brain-http.token');
}

/** Read the shared token (env override first); null when absent. */
export function readToken(dataDir, env = process.env) {
  const token = (env && typeof env === 'object' && !Array.isArray(env)) ? (env.BRAIN_HTTP_TOKEN ?? '') : '';
  const normalizedToken = String(token).trim();
  if (normalizedToken) return normalizedToken;
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
 * Origin-only guard (DNS-rebinding): a foreign browser Origin is refused; a
 * missing Origin (every native client — including Claude Code's MCP http
 * transport) passes. Used alone for /mcp: that endpoint is declared straight
 * in .mcp.json as a static "type":"http" URL with no per-session process and
 * no room for a runtime-generated secret in a static header, so /mcp trades
 * the token for this origin check + the 127.0.0.1 bind (both were already
 * true before; the token was the second, now-dropped, layer). /shutdown (a
 * destructive local action, not something Claude Code's MCP client ever
 * calls) keeps the full token gate below.
 * @returns {{ ok:true } | { ok:false, code:number, error:string }}
 */
export function originAllowed(req) {
  const origin = req.headers && req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(String(origin))) {
    return { ok: false, code: 403, error: 'forbidden origin (DNS-rebinding guard)' };
  }
  return { ok: true };
}

/**
 * Gate a request: local Origin (when present — browsers send it, native
 * clients don't; a foreign Origin means DNS rebinding) + constant-time token
 * match from `Authorization: Bearer <t>` or `X-Brain-Token`. Used for
 * /shutdown only — see originAllowed() above for why /mcp no longer needs it.
 * @returns {{ ok:true } | { ok:false, code:number, error:string }}
 */
export function requestAllowed(req, token, dataDir) {
  const originGate = originAllowed(req);
  if (!originGate.ok) return originGate;
  const bearer = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  const given = (req.headers && req.headers['x-brain-token']) || bearer;
  if (!token || !timingSafeEq(given, token)) {
    // Human-readable hint only — never let canonicalization throw while building an error.
    let where = '<DATA_DIR>';
    try { where = tokenFile(dataDir); } catch { /* dataDir absent → keep placeholder */ }
    return { ok: false, code: 401, error: `missing/invalid token — read it from ${where} and send Authorization: Bearer <token>` };
  }
  return { ok: true };
}
