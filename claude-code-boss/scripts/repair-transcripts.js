#!/usr/bin/env node
'use strict';

/**
 * repair-transcripts.js — repairs session transcripts whose compaction copies chain to a row before the boundary
 * (see lib/transcript-repair.js). Nothing runs it automatically.
 *
 *   node repair-transcripts.js scan                      read only: how many transcripts and rows would change
 *   node repair-transcripts.js repair                    repairs the closed ones, backing each up first
 *   node repair-transcripts.js adopt <backup folder>     moves an earlier backup tree into the stable backup folder
 *
 * Options: --root <projects folder> (default ~/.claude/projects), --sessions-dir <folder> (default ~/.claude/sessions),
 * --backup-root <folder> (default <plugin data dir>/transcript-repair).
 */

const os = require('os');
const path = require('path');
const { repairTranscripts, adoptBackup, defaultBackupRoot } = require('./lib/transcript-repair.js');

function main(argv) {
  const [mode, ...rest] = argv;
  const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? path.resolve(rest[i + 1]) : fallback; };
  const home = os.homedir();
  const root = opt('--root', path.join(home, '.claude', 'projects'));
  const sessionsDir = opt('--sessions-dir', path.join(home, '.claude', 'sessions'));
  const backupRoot = opt('--backup-root', defaultBackupRoot());
  if (mode === 'scan' || mode === 'repair') return repairTranscripts({ root, sessionsDir, backupRoot, dryRun: mode === 'scan' });
  if (mode === 'adopt' && rest[0] && !rest[0].startsWith('--')) return adoptBackup({ from: path.resolve(rest[0]), root, backupRoot });
  throw new Error('usage: repair-transcripts.js scan | repair | adopt <backup folder> [--root <dir>] [--sessions-dir <dir>] [--backup-root <dir>]');
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 1)); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { main };
