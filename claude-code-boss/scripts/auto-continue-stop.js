#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStdin, parsePayload, emitEmpty, emitStopBlock } = require('./lib/hook-io.js');

const DEFAULT_MAX = 1;
const REASON = '[auto-continue] Continue se o próximo passo for óbvio pelo plano/todos. Caso contrário, encerre normalmente — esta é a única tentativa, não haverá nova chance.';

function counterPath(dataDir, sid) {
  return path.join(dataDir, '.runtime', `auto-continue-${sid}.json`);
}

function readCounter(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { count: 0 }; }
}

function writeCounter(file, n) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ count: n }));
}

function loadConfig() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'hooks-config.json'), 'utf-8'));
    return cfg.autoContinue || {};
  } catch { return {}; }
}

async function main() {
  const raw = await readStdin();
  const ev = parsePayload(raw) || {};
  const cfg = loadConfig();
  if (cfg.enabled === false) return emitEmpty();

  const sid = ev.session_id || ev.sessionId || 'default';
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
  const cFile = counterPath(dataDir, sid);

  const max = cfg.maxBlocks || DEFAULT_MAX;
  const cur = readCounter(cFile);
  if (cur.count >= max) return emitEmpty();

  writeCounter(cFile, cur.count + 1);
  emitStopBlock(REASON);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[auto-continue-stop] ${err.message}`);
    emitEmpty();
  });
}

module.exports = { REASON, readCounter, writeCounter, counterPath };
