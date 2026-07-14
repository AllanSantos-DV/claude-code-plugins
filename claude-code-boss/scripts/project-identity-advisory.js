#!/usr/bin/env node
/**
 * project-identity-advisory.js — SessionStart hook.
 *
 * Under the SHARED mcp-memory daemon, the client scopes every memory op by a
 * `projectId` resolved from the folder (env `CCB_PROJECT_ID` → `.claude-boss-project`
 * marker → `basename(cwd)`). When there's NO marker and NO env override, recall
 * silently rides `basename(cwd)` — which changes per machine/clone and can COLLIDE
 * with another folder of the same name on the shared daemon (wrong/split memory).
 *
 * The marker mechanism already exists (see README "Identidade do projeto"), but
 * nothing prompts the user to pin it — so in practice most projects never get the
 * stable identity the marker was built for. This hook closes that gap: it detects
 * the fragile-fallback state and injects a single guided advisory telling the agent
 * to OFFER (with the user's consent) to create the marker. It never writes anything
 * itself — the identity must be user-chosen, so the agent mediates.
 *
 * Silent when: not mcp-memory (local SQLite keys by basename BY DESIGN); a marker or
 * env id already exists; on per-folder cooldown; or opted out (`onboarding.projectIdentity`).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const { readMarker, sanitize, MARKER_FILE } = require('./lib/project-id.js');
const { getBackendType, getMcpProjectId, getOnboarding } = require('./lib/brain-config.js');

// Per-folder: nudge at most once per window (creating the marker silences it
// permanently, so this only bounds the reminder for folders left on basename).
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * PURE — does this session lack a STABLE project identity, so recall is riding the
 * fragile `basename(cwd)` fallback on the shared daemon?
 *
 * Only meaningful under mcp-memory: the local SQLite backend keys by basename by
 * design, so it NEVER nudges there. The stability test is a SUPERSET of the real
 * handshake's scope sources (`brain-backend`: `mcpCfg.projectId || resolveProjectId(cwd)`,
 * where resolveProjectId = env `CCB_PROJECT_ID` → `.claude-boss-project` marker →
 * basename): config-pinned `mcpProjectId` wins, then env, then marker; only the raw
 * basename fallback warrants a nudge.
 *
 * @param {object} o
 * @param {string} o.mode           backend type (`local` | `mcp-memory`)
 * @param {string} [o.cwd]          session working directory
 * @param {object} [o.env]          environment (defaults {})
 * @param {string} [o.mcpProjectId] config `backend.mcpMemory.projectId` (handshake override)
 * @param {object} [o.fs]           fs impl (for tests)
 * @returns {boolean} true iff a guided identity nudge is warranted
 */
function needsProjectIdentityNudge({ mode, cwd, env = {}, mcpProjectId, fs: fsImpl = fs } = {}) {
  if (mode !== 'mcp-memory') return false;          // local: basename is by design
  // Config-pinned handshake id wins RAW (brain-backend `mcpCfg.projectId || _project`
  // + mcp-client `projectId ? {projectId} : {}`): any truthy value is stamped as the
  // scope, so the marker/env remedy is inert → treat any non-empty string as stable.
  if (mcpProjectId) return false;
  if (sanitize(env.CCB_PROJECT_ID)) return false;   // explicit env id → stable
  if (cwd && readMarker(cwd, fsImpl)) return false;  // marker in tree → stable
  return true;                                       // neither → basename fallback
}

function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  return (env && !env.includes('${'))
    ? env : path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}

function stampDir() {
  return path.join(dataDir(), '.runtime', 'project-identity-advisory');
}

/**
 * Per-FOLDER stamp file: each folder gets its OWN file (named by a stable hash of
 * the cwd), so concurrent SessionStart hooks for DIFFERENT folders never share a
 * file → no read-modify-write lost updates across folders. Combined with the
 * atomic write in stamp(), a reader never sees a torn file either.
 */
function stampFileFor(cwd) {
  const h = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  return path.join(stampDir(), `${h}.json`);
}

/** Read the folder's stamp ts; missing/corrupt/torn → null (fail-open). */
function readTs(file) {
  try {
    const ts = JSON.parse(fs.readFileSync(file, 'utf8')).ts;
    return Number.isFinite(ts) ? ts : null;
  } catch { /* absent/corrupt → not stamped */ return null; }
}

/** True iff this folder was stamped within COOLDOWN_MS of `now`. */
function onCooldown(file, now = Date.now()) {
  const last = readTs(file);
  return last !== null && (now - last) < COOLDOWN_MS;
}

/** Record this folder's nudge at `now`. Atomic (temp+rename) + best-effort. */
function stamp(file, now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts: now }));
    fs.renameSync(tmp, file);  // atomic swap: readers never observe a partial write
  } catch (e) { void e; /* stamp is best-effort; never block the session */ }
}

/** The guided advisory text. Consent-first: the agent OFFERS, never auto-writes. */
function buildAdvisory(basename) {
  const name = basename ? ` (\`${basename}\`)` : '';
  return `[PROJETO] Esta pasta não tem identidade de memória fixa — o recall está usando o nome da pasta${name}, `
    + `que muda entre máquinas/clones e pode colidir no daemon compartilhado (memória trocada/dividida). `
    + `Se o usuário for trabalhar de verdade aqui, OFEREÇA fixar um id estável: pergunte o nome do projeto e, `
    + `com o "ok" dele, crie o arquivo \`${MARKER_FILE}\` na raiz do projeto com esse nome numa única linha `
    + `(processo em "Identidade do projeto" no README do plugin). Se ele preferir manter o padrão, siga sem alterar.`;
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { /* defaults */ }
  const eventName = event.hook_event_name || 'SessionStart';

  if (!getOnboarding().projectIdentity) return emitEmpty();     // opted out

  const cwd = (typeof event.cwd === 'string' && event.cwd) ? event.cwd : process.cwd();
  const nudge = needsProjectIdentityNudge({
    mode: getBackendType(),
    cwd,
    env: process.env,
    mcpProjectId: getMcpProjectId(),
  });
  if (!nudge) return emitEmpty();

  const file = stampFileFor(cwd);
  if (onCooldown(file)) return emitEmpty();
  stamp(file);

  emitJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: buildAdvisory(path.basename(cwd)),
    },
  });
}

if (require.main === module) {
  main().catch((err) => { console.error(`[project-identity-advisory] ${err.message}`); emitEmpty(); });
}

module.exports = {
  needsProjectIdentityNudge,
  onCooldown,
  stamp,
  readTs,
  stampFileFor,
  stampDir,
  buildAdvisory,
  COOLDOWN_MS,
};
