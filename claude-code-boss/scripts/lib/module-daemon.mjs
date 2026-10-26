// The brain daemon's address and local token, for function-hook MODULES (hooks/*.mjs): they run
// with no Node, so they reach the boss over HTTP through the module's `$` (`$.env`, `$.fs`, `$.http`).
// Shared by hooks/compaction.mjs and hooks/boss.mjs.

const slashes = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
// A local absolute path: a drive (C:/…) or a POSIX root — never a UNC/network path (//host/…).
const isLocalAbsolute = (p) => /^[A-Za-z]:\//.test(p) || (/^\/(?!\/)/.test(p));
const msg = (err) => String(err && err.message ? err.message : err);

// ── HMAC-SHA256 in plain JS: the module's environment has no Node (so no `crypto`). Checked against node:crypto in test-units. ──
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function sha256(bytes) {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const msg = bytes.slice();
  const bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 7; i >= 0; i--) msg.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((msg[off + 4 * i] << 24) | (msg[off + 4 * i + 1] << 16) | (msg[off + 4 * i + 2] << 8) | msg[off + 4 * i + 3]) | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = [];
  for (const v of h) out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  return out;
}

/** HMAC-SHA256(key, message) as lowercase hex — the same value as node:crypto's createHmac('sha256', key).update(message).digest('hex'). */
export function hmacSha256Hex(key, message) {
  let k = utf8Bytes(key);
  if (k.length > 64) k = sha256(k);
  while (k.length < 64) k.push(0);
  const inner = sha256(k.map((b) => b ^ 0x36).concat(utf8Bytes(message)));
  const mac = sha256(k.map((b) => b ^ 0x5c).concat(inner));
  return mac.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
}

/** A fresh challenge (hex, 32 chars): crypto.getRandomValues when the module's environment has it, else Math.random (a nonce only has to be fresh to stop a replay). */
export function makeNonce() {
  const bytes = [];
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') bytes.push(...c.getRandomValues(new Uint8Array(16)));
  else for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256) ^ (Date.now() >> (i % 4) * 8 & 0xff));
  return bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
}

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
  // The token is read from the LOCAL dir first, but nothing is sent with it until the process on the port proves it knows it.
  const token = (await $.fs.read(`${local}/brain-http.token`)).trim();
  const nonce = makeNonce();
  const h = await $.http.fetch(`${base}/health?nonce=${nonce}`);
  if (!h.ok) throw new Error(`brain daemon /health answered ${h.status} on port ${port}`);
  const body = JSON.parse(h.text);
  const { dataDir } = body;
  if (!dataDir || slashes(dataDir).toLowerCase() !== local.toLowerCase()) {
    throw new Error(`the process on port ${port} names another data dir (${dataDir}) than this machine's boss (${local}) — not sending the token`);
  }
  if (typeof body.proof === 'string') {
    if (body.proof !== hmacSha256Hex(token, nonce)) {
      throw new Error(`the process on port ${port} answered the /health challenge with a wrong proof — it does not know this machine's token; not sending it`);
    }
  } else if (!holder.legacyWarned) {
    // An older daemon has no challenge. Same trust as before (the dataDir it names), said out loud — never silent.
    holder.legacyWarned = true;
    $.ui.log(`${label}: the daemon on port ${port} did not answer the /health challenge (older build) — trusting it by the data dir it names only; restart the brain daemon to get the verified handshake`);
  }
  holder.daemon = { base, token };
  return holder.daemon;
}
