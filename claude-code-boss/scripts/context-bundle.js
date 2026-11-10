#!/usr/bin/env node
/**
 * context-bundle.js — the relevant excerpts for a theme in ONE call (CLI).
 *
 *   node scripts/context-bundle.js "<theme>" [--root <dir>] [--max-tokens N] [--json]
 *
 * Code, tests and docs ranked by Smart Tool, the Brain's recall for the theme, and the sections of the project's task
 * maps that mention it. The read-burst hook builds the same bundle on its own during a run of read-only calls.
 * Fail loud: a source that cannot answer is named under "notes" in the output.
 * Smart Tool endpoint: CCB_SMART_TOOL_URL, else the address the running service writes in ~/.smart-tool/data/daemon.json.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The Smart Tool MCP endpoint, read from the service's run file on every call (the service may move to another port
 * between runs; no address is kept here). Throws, naming the file, when the service is not running.
 * @returns {string}
 */
function discoverSmartToolUrl(env = process.env, home = os.homedir()) {
  if (env.CCB_SMART_TOOL_URL) return env.CCB_SMART_TOOL_URL;
  const file = path.join(home, '.smart-tool', 'data', 'daemon.json');
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `Smart Tool service not running (no run file ${file})` : `Smart Tool run file ${file} unreadable: ${err.message}`);
  }
  if (!run || typeof run.url !== 'string' || !/^https?:\/\//.test(run.url)) throw new Error(`Smart Tool run file ${file} has no service address`);
  return `${run.url.replace(/\/+$/, '')}/mcp`;
}

async function main(argv) {
  const args = argv.slice();
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const root = path.resolve(take('--root') || process.env.CCB_PROJECT_ROOT || process.cwd());
  const maxTokens = Number(take('--max-tokens')) || undefined;
  const asJson = args.includes('--json');
  const theme = args.filter((a) => a !== '--json').join(' ').trim();
  if (theme.length < 3) { process.stderr.write('usage: node scripts/context-bundle.js "<theme>" [--root <dir>] [--max-tokens N] [--json]\n'); return 2; }
  const { buildBundle } = require('./lib/context-bundle.js');
  const b = await buildBundle({ theme, root, deps: { smartToolUrl: discoverSmartToolUrl() }, limits: maxTokens ? { maxTokens } : {} });
  process.stdout.write(asJson ? `${JSON.stringify({ theme: b.theme, tokens: b.tokens, files: b.files, notes: b.notes, text: b.text })}\n` : `${b.text}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`[context-bundle] ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, discoverSmartToolUrl };
