'use strict';
/**
 * crash-report-flags.js — where Node writes its crash reports, and the flags that turn them on.
 *
 * Split out of crash-evidence.js (the Windows crash recorder, a Claude Code adapter) so the
 * embedder's load test (embedder-guard) needs nothing from the adapter side: the engine core
 * (KB, embedder, recall) must not pull host-specific modules.
 */
const path = require('path');

const REPORT_DIR = 'crash-reports';

function reportDir(dataDir) { return path.join(dataDir, REPORT_DIR); }

/** Node flags for a process whose fatal error or uncaught exception must leave a report. */
function reportFlags(dataDir) {
  return ['--report-on-fatalerror', '--report-uncaught-exception', `--report-directory=${reportDir(dataDir)}`];
}

module.exports = { REPORT_DIR, reportDir, reportFlags };
