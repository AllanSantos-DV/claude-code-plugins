'use strict';
/**
 * Asks the Skill Manager (skill-engine CLI) what became of the items a source installed, so a product can tell
 * "waiting for approval" from "missing". The CLI is found through the pointer file `cli.json` in the Skill Manager
 * home; without it the Manager is not installed and nothing is asked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const QUERY_TIMEOUT_MS = 8000;

/** @returns {{cli: string, node: string}|null} the CLI pointer, or null when the Skill Manager is not installed. */
function locateCli(home) {
  const dir = home || process.env.SKILL_ENGINE_HOME || path.join(os.homedir(), '.skill-engine');
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'cli.json'), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const p = JSON.parse(raw);
  if (!p || typeof p.cli !== 'string' || !p.cli) throw new Error(`${path.join(dir, 'cli.json')} has no "cli" path`);
  return { cli: p.cli, node: typeof p.node === 'string' && p.node ? p.node : process.execPath };
}

/**
 * Runs `skill-engine query --owner <owner> --json`.
 * @returns {{owner: string, known: boolean, items: Array<{id: string, kind: string, state: string, reason: string|null, pendingUpdate: *, approve: *}>}}
 * @throws when the CLI cannot be run or does not answer JSON (the caller reports it; it is never read as "all good").
 */
function queryOwner(owner, { home, run = spawnSync } = {}) {
  const ptr = locateCli(home);
  if (!ptr) return null;
  const r = run(ptr.node, [ptr.cli, 'query', '--owner', owner, '--json'], { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, windowsHide: true });
  if (r.error) throw new Error(`skill-engine query failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`skill-engine query exited ${r.status}: ${String(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  let out;
  try { out = JSON.parse(r.stdout); } catch (err) { throw new Error(`skill-engine query did not answer JSON: ${err.message}`); }
  if (!out || out.ok !== true || !Array.isArray(out.items)) throw new Error('skill-engine query answered an unexpected shape');
  return { owner, known: out.known === true, items: out.items };
}

module.exports = { locateCli, queryOwner };
