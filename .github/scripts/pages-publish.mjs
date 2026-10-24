#!/usr/bin/env node
/**
 * pages-publish.mjs — publishes pages/ to the `gh-pages` branch and checks the public URL, with no Actions artifact.
 *
 *   publish: checks the site, builds an orphan commit holding only pages/ plus .nojekyll and force-pushes it to
 *            gh-pages (the branch belongs to the site and is rebuilt on every publication). An SSH remote needs the
 *            deploy key's private half in PAGES_DEPLOY_KEY: a push made with GITHUB_TOKEN does not trigger the Pages
 *            build.
 *   verify:  reads the public page until it shows `v<version of claude-code-boss/package.json>` and equals the
 *            published index.html; fails loudly when it never does.
 *
 * Any invalid setup (empty site, symlink, version missing, branch other than gh-pages, key missing) exits 1 with the
 * cause on stderr. Pure Node, zero deps, zero AI.
 *
 * Usage:
 *   node .github/scripts/pages-publish.mjs publish [--site DIR] [--remote URL] [--branch gh-pages] [--message TEXT]
 *   node .github/scripts/pages-publish.mjs verify  [--url URL] [--site DIR] [--attempts 20] [--interval 15] [--stamp ID]
 *
 * Revert to the Actions artifact: AGENTS.md ("Publicação por branch").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BRANCH = 'gh-pages';
export const KEY_ENV = 'PAGES_DEPLOY_KEY';
const DEFAULT_REMOTE = 'git@github.com:AllanSantos-DV/claude-code-plugins.git';
const DEFAULT_URL = 'https://allansantos-dv.github.io/claude-code-plugins/';
const PLUGIN_PAGE = 'claude-code-boss/index.html';
const NOT_PUBLISHED = new Set(['.token-guard', '.source-hash']);

export class PagesError extends Error {}

export function productVersion(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'claude-code-boss', 'package.json'), 'utf8')).version;
}

function symlinksIn(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [path.relative(base, full)];
    return e.isDirectory() ? symlinksIn(full, base) : [];
  });
}

export function checkSite(site, version) {
  const index = path.join(site, 'index.html');
  const plugin = path.join(site, PLUGIN_PAGE);
  for (const f of [index, plugin]) if (!fs.statSync(f, { throwIfNoEntry: false })?.isFile()) throw new PagesError(`${f} does not exist: nothing to publish`);
  const links = symlinksIn(site);
  if (links.length) throw new PagesError(`symbolic links in ${site} (Pages by branch does not publish them): ${links.join(', ')}`);
  if (!fs.readFileSync(plugin, 'utf8').includes(`v${version}`)) throw new PagesError(`${plugin} does not show v${version}: stale page`);
}

export function stageTree(site, dest) {
  fs.cpSync(site, dest, { recursive: true, filter: (src) => !NOT_PUBLISHED.has(path.basename(src)) });
  fs.writeFileSync(path.join(dest, '.nojekyll'), '');
}

function git(args, { cwd, env } = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new PagesError(`git ${args[0]} could not run: ${r.error.message}`);
  if (r.status) throw new PagesError(`git ${args[0]} failed (${r.status}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function publish({ site, remote, branch, message, key, root = ROOT }) {
  if (branch !== BRANCH) throw new PagesError(`force push only to ${BRANCH}, not '${branch}'`);
  checkSite(site, productVersion(root));
  const overSsh = /^(git@|ssh:\/\/)/.test(remote);
  if (overSsh && !String(key).includes('PRIVATE KEY')) throw new PagesError(`${KEY_ENV} missing or not a private key: an SSH remote needs the deploy key`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-publish-'));
  try {
    const env = { ...process.env };
    if (overSsh) {
      const keyFile = path.join(temp, 'deploy_key');
      // LF only: ssh refuses CRLF ("error in libcrypto"); 0600 or ssh refuses the key.
      fs.writeFileSync(keyFile, `${String(key).replace(/\r/g, '').trim()}\n`, { mode: 0o600 });
      const q = (p) => `"${p.split(path.sep).join('/')}"`;
      env.GIT_SSH_COMMAND = `ssh -i ${q(keyFile)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(path.join(temp, 'known_hosts'))}`;
    }
    const tree = path.join(temp, 'tree');
    stageTree(site, tree);
    git(['init', '-q', '-b', branch], { cwd: tree });
    git(['add', '-A'], { cwd: tree });
    git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', message], { cwd: tree });
    git(['push', '--force', remote, `HEAD:refs/heads/${branch}`], { cwd: tree, env });
    return git(['rev-parse', 'HEAD'], { cwd: tree }).trim();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

export async function verify({ url, version, attempts, interval, stamp, site }) {
  const needle = `v${version}`;
  const expected = site ? fs.readFileSync(path.join(site, PLUGIN_PAGE), 'utf8') : null;
  let last = 'no answer';
  for (let i = 0; i < attempts; i += 1) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      const res = await fetch(`${new URL(PLUGIN_PAGE, url)}?v=${stamp}`, { signal: abort.signal });
      const body = await res.text();
      if (!res.ok) last = `HTTP ${res.status}`;
      else if (!body.includes(needle)) last = 'the page answers, but without that version';
      else if (expected && !sameText(body, expected)) last = 'the page shows the version, but it is not the published index.html';
      else return;
    } catch (err) {
      last = err.message;
    } finally {
      clearTimeout(timer);
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, interval * 1000));
  }
  throw new PagesError(`${url} does not show '${needle}' after ${attempts} attempts (${last})`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new PagesError(`bad argument: ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  return opts;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  const site = o.site || path.join(ROOT, 'pages');
  if (cmd === 'publish') {
    const sha = publish({ site, remote: o.remote || DEFAULT_REMOTE, branch: o.branch || BRANCH, message: o.message || 'Pages of claude-code-plugins', key: process.env[KEY_ENV] || '' });
    process.stdout.write(`${o.branch || BRANCH} published at ${sha}.\n`);
  } else if (cmd === 'verify') {
    const version = productVersion();
    await verify({ url: o.url || DEFAULT_URL, version, attempts: Number(o.attempts || 20), interval: Number(o.interval || 15), stamp: o.stamp || String(Date.now()), site });
    process.stdout.write(`The public page shows v${version}.\n`);
  } else {
    throw new PagesError(`unknown command: ${cmd} (use publish|verify)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(1);
  });
}
