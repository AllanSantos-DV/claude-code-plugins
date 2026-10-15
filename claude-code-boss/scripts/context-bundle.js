#!/usr/bin/env node
/**
 * context-bundle.js — PROTOTYPE (opt-in CLI): the relevant excerpts for a theme in ONE call.
 *
 *   node scripts/context-bundle.js "<theme>" [--root <dir>] [--max-tokens N] [--json]
 *
 * The agent (or you) runs it instead of a burst of Read/Grep/Glob turns: code, tests and docs ranked by Smart Tool,
 * the Brain's recall for the theme, and the sections of the project's task maps that mention it. Nothing runs on its
 * own: no hook calls this. Fail loud: a source that cannot answer is named under "notes" in the output.
 * Smart Tool URL: CCB_SMART_TOOL_URL, else the `smart-tool` http MCP server of ~/.claude.json.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function discoverSmartToolUrl(env = process.env, home = os.homedir()) {
  if (env.CCB_SMART_TOOL_URL) return env.CCB_SMART_TOOL_URL;
  const file = path.join(home, '.claude.json');
  let cj;
  try { cj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is unreadable: ${err.message}`);
  }
  const s = (cj.mcpServers || {})['smart-tool'];
  return s && s.url ? s.url : null;
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
