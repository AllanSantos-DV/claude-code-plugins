'use strict';
/**
 * release-resolver.js — which mcp-memory-server jar to download, from the public releases
 * repo (github.com/AllanSantos-DV/mcp-memory-server-releases).
 *
 * Since server 2.45.6 a release publishes ONE server jar, `mcp-memory-server-X.Y.Z.jar` (+ its
 * `.sha256`); the "-gpu" jar is discontinued — GPU acceleration comes only from the embeddings
 * sidecar, which the daemon provisions by itself (native-java launcher contract, C-3).
 *
 * The repo also publishes sidecar releases (`sidecar-v*`) with no server jar, and GitHub marks
 * whichever was published LAST as "latest" (on 2026-10-05 that was Sidecar v1.6.1) — so
 * `releases/latest` is not used: the releases are listed and the highest X.Y.Z that has the
 * server jar wins. Returns the download URL + published hash; it downloads nothing itself.
 */
const RELEASES_REPO = 'AllanSantos-DV/mcp-memory-server-releases';
const JAR_ASSET_RE = /^mcp-memory-server-(\d+)\.(\d+)\.(\d+)\.jar$/;

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'mcp-memory-bootstrap', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${url} → HTTP ${r.status}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.text();
}

const versionOf = (name) => (JAR_ASSET_RE.exec(name) || []).slice(1).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

/**
 * The newest published server jar.
 * @returns {Promise<{url:string, name:string, size:number, version:string, sha256:string}>}
 */
async function resolveLatestAsset() {
  const releases = await fetchJson(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=50`);
  let best = null;
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const jar = assets.find((a) => JAR_ASSET_RE.test(a.name));
    if (jar && (!best || newer(versionOf(jar.name), versionOf(best.jar.name)))) best = { rel, jar, assets };
  }
  if (!best) throw new Error(`no mcp-memory-server-X.Y.Z.jar in the published releases of ${RELEASES_REPO}`);
  const shaAsset = best.assets.find((a) => a.name === `${best.jar.name}.sha256`);
  let sha256 = '';
  if (shaAsset) {
    const raw = await fetchText(shaAsset.browser_download_url);
    const m = raw.trim().match(/[0-9a-f]{64}/i);
    sha256 = m ? m[0].toLowerCase() : '';
  }
  return { url: best.jar.browser_download_url, name: best.jar.name, size: best.jar.size || 0, version: best.rel.tag_name || '', sha256 };
}

module.exports = { RELEASES_REPO, JAR_ASSET_RE, resolveLatestAsset };
