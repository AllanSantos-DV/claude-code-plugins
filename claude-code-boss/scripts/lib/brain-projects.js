'use strict';
/**
 * brain-projects.js — enumerate the local KBs under a brain dir.
 *
 * A project id is LOGICAL and may be nested: `owner/repo` or `host/owner/repo`
 * (what the strict resolver derives from a git remote) lands in
 * brain/<owner>/<repo>/brain.db. A one-level readdir missed every such KB, so the
 * dashboard and brain-migrate never listed them. Returns ids with `/` separators.
 */
const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 4; // host/owner/repo + one spare level

/** @returns {string[]} logical ids of every dir under `brainDir` holding a brain.db */
function listBrainProjects(brainDir, { maxDepth = MAX_DEPTH } = {}) {
  const out = [];
  const walk = (dir, segs) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { void err; return; }
    if (segs.length && names.some((d) => d.isFile() && d.name === 'brain.db')) out.push(segs.join('/'));
    if (segs.length >= maxDepth) return;
    for (const d of names) {
      if (d.isDirectory() && !d.name.startsWith('.')) walk(path.join(dir, d.name), [...segs, d.name]);
    }
  };
  walk(brainDir, []);
  return out.sort();
}

/** Absolute brain.db path of a logical id (segments joined with the OS separator). */
function brainDbPath(brainDir, project) {
  return path.join(brainDir, ...String(project).split('/'), 'brain.db');
}

module.exports = { listBrainProjects, brainDbPath, MAX_DEPTH };
