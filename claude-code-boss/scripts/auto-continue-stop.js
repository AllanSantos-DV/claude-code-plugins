#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { writeJsonAtomic } = require('./lib/atomic-write.js');
const path = require('path');

const { runStopDetectorCli } = require('./lib/hook-io.js');
const hooksCfg = require('./lib/hooks-config.js');

const DEFAULT_MAX = 1;
const REASON = '[auto-continue] Continue if the next step is obvious from the plan/todos. Otherwise just end the reply normally — this is the only attempt, there is no retry.';

function counterPath(dataDir, sid) {
  return path.join(dataDir, '.runtime', `auto-continue-${sid}.json`);
}

function readCounter(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { /* absent/corrupt: start at zero */ return { count: 0 }; }
}

function writeCounter(file, n) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { count: n });
}

function loadConfig() {
  // Read through the profile-resolved getter so `standard`/`free` can silence it
  // (returns { enabled, maxBlocks }).
  return hooksCfg.getAutoContinue();
}

async function run(event) {
  const ev = event || {};
  const cfg = loadConfig();
  if (!cfg.enabled) return {};

  const sid = ev.session_id || ev.sessionId || 'default';
  const { dataDir: resolveDataDir } = require('./lib/data-dir.js');
  const dataDir = resolveDataDir();
  const cFile = counterPath(dataDir, sid);

  const max = cfg.maxBlocks || DEFAULT_MAX;
  const cur = readCounter(cFile);
  if (cur.count >= max) return {};

  writeCounter(cFile, cur.count + 1);
  return { block: true, reason: REASON };
}

if (require.main === module) {
  runStopDetectorCli(run, 'auto-continue-stop');
}

module.exports = { run, REASON, readCounter, writeCounter, counterPath };
