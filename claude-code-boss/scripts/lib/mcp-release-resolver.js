'use strict';
/**
 * mcp-release-resolver.js — hardware-aware asset resolution for the mcp-memory-server
 * GitHub Releases repo (github.com/AllanSantos-DV/mcp-memory-server-releases).
 *
 * Each release publishes both a GPU and a CPU-only JAR (e.g.
 * `mcp-memory-server-2.39.1.jar` / `mcp-memory-server-2.39.1-gpu.jar`), each with a
 * `.sha256` sidecar. This module picks the right one for the local machine and hands
 * back its download URL + expected hash — it does not download or verify anything
 * itself (mcp-wizard.js / config-testers/mcp-memory.js own that).
 *
 * Shared by scripts/lib/mcp-wizard.js (real activation flow) and
 * scripts/config-testers/mcp-memory.js (dashboard "Test connection" preview), so both
 * report the same resolved asset instead of duplicating the GitHub API call.
 */
const { spawnSync } = require('child_process');

const RELEASES_REPO = 'AllanSantos-DV/mcp-memory-server-releases';
const JAR_ASSET_RE = /^mcp-memory-server-\d+(?:\.\d+){1,3}(-gpu)?\.jar$/;

/** NVIDIA-only: nvidia-smi ships with the driver on Windows/Linux, absent everywhere else
 *  (including AMD/Apple GPUs) — the CPU-only jar is the correct default for those. */
function detectGpu() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf-8', timeout: 5000 });
  if (r.error || r.status !== 0) return { present: false };
  const name = (r.stdout || '').trim().split('\n')[0].trim();
  return name ? { present: true, name } : { present: false };
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'claude-code-boss', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${url} → HTTP ${r.status}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.text();
}

/**
 * Resolve the latest release's JAR asset matching the requested variant.
 * @param {{gpu?: boolean}} opts
 * @returns {Promise<{url:string, name:string, size:number, version:string, sha256:string}>}
 */
async function resolveLatestAsset({ gpu } = {}) {
  const wantGpu = !!gpu;
  const release = await fetchJson(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const jar = assets.find((a) => JAR_ASSET_RE.test(a.name) && /-gpu\.jar$/.test(a.name) === wantGpu);
  if (!jar) {
    throw new Error(`no ${wantGpu ? 'GPU' : 'CPU-only'} mcp-memory-server asset found in release ${release.tag_name || '(unknown)'} of ${RELEASES_REPO}`);
  }
  const shaAsset = assets.find((a) => a.name === `${jar.name}.sha256`);
  let sha256 = '';
  if (shaAsset) {
    const raw = await fetchText(shaAsset.browser_download_url);
    const m = raw.trim().match(/[0-9a-f]{64}/i);
    sha256 = m ? m[0].toLowerCase() : '';
  }
  return { url: jar.browser_download_url, name: jar.name, size: jar.size || 0, version: release.tag_name || '', sha256 };
}

module.exports = { RELEASES_REPO, JAR_ASSET_RE, detectGpu, resolveLatestAsset };
