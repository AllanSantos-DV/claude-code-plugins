'use strict';
/**
 * marketplace-autoupdate.js — turn Claude Code's plugin auto-update ON for the marketplace
 * this plugin came from, once, and tell the user.
 *
 * Claude Code leaves auto-update OFF for every third-party marketplace
 * (code.claude.com/docs/en/plugins/loading, "When auto-update runs", read 2026-10-05), so
 * a user who never opens /plugin → Marketplaces stays on the version they installed
 * forever. Precedence (same doc): `autoUpdate` on the marketplace's `extraKnownMarketplaces`
 * entry in settings → `autoUpdate` on its `known_marketplaces.json` entry (what the
 * "Enable auto-update" toggle writes) → the default. An explicit value anywhere — the
 * user's choice — is never overridden.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = 'marketplace-autoupdate.json';

function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** `<marketplace>` from `<plugins>/cache/<marketplace>/<plugin>/<version>`; null for --plugin-dir/inline. */
function marketplaceOf(pluginRoot) {
  const parts = path.resolve(String(pluginRoot || '')).split(path.sep);
  const i = parts.lastIndexOf('cache');
  if (i < 0 || parts.length < i + 4) return null;
  const name = parts[i + 1];
  return name && name !== 'inline' ? name : null;
}

function readJson(file) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (err) { return { ok: false, missing: err.code === 'ENOENT', error: err.message }; }
}

/**
 * Enable auto-update when nobody chose yet. Returns { status, marketplace? }:
 * 'not-marketplace' | 'already-done' | 'explicit' (user's choice kept) | 'enabled' | 'error'.
 */
function ensureAutoUpdate({ pluginRoot, env = process.env, markerDir, write } = {}) {
  const mkt = marketplaceOf(pluginRoot);
  if (!mkt) return { status: 'not-marketplace' };
  const marker = path.join(markerDir || require('./data-dir.js').globalDir(), MARKER);
  if (fs.existsSync(marker)) return { status: 'already-done', marketplace: mkt };
  const dir = configDir(env);
  const settingsFile = path.join(dir, 'settings.json');
  const knownFile = path.join(dir, 'plugins', 'known_marketplaces.json');
  const settings = readJson(settingsFile);
  const known = readJson(knownFile);
  if (!known.ok) return { status: 'error', error: `known_marketplaces.json ${known.missing ? 'missing' : `unreadable (${known.error})`} — not touching it` };
  if (!known.data[mkt]) return { status: 'error', error: `marketplace "${mkt}" not in known_marketplaces.json` };
  const declared = settings.ok && settings.data.extraKnownMarketplaces && settings.data.extraKnownMarketplaces[mkt];
  const explicit = (declared && typeof declared.autoUpdate === 'boolean') || typeof known.data[mkt].autoUpdate === 'boolean';
  const save = write || ((file, obj) => require('./atomic-write.js').writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n'));
  const mark = (status) => {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ marketplace: mkt, status, at: new Date().toISOString(), notified: status !== 'enabled' }));
  };
  if (explicit) { mark('explicit'); return { status: 'explicit', marketplace: mkt }; }
  known.data[mkt].autoUpdate = true;
  save(knownFile, known.data);
  // The toggle also writes the settings entry when the marketplace is declared there.
  if (declared) { declared.autoUpdate = true; save(settingsFile, settings.data); }
  mark('enabled');
  return { status: 'enabled', marketplace: mkt };
}

/** One-line notice for the user, once, after ensureAutoUpdate enabled it. Null otherwise. */
function takeAutoUpdateNotice({ markerDir, env = process.env } = {}) {
  const marker = path.join(markerDir || require('./data-dir.js').globalDir(), MARKER);
  const m = readJson(marker);
  if (!m.ok || m.data.notified || m.data.status !== 'enabled') return null;
  fs.writeFileSync(marker, JSON.stringify({ ...m.data, notified: true }));
  const off = /^(1|true)$/i;
  const blocked = (off.test(env.DISABLE_AUTOUPDATER || '') || off.test(env.DISABLE_UPDATES || '') || off.test(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '')) && !off.test(env.FORCE_AUTOUPDATE_PLUGINS || '');
  return `claude-code-boss: liguei a atualização automática do plugin (marketplace ${m.data.marketplace}) — as versões novas chegam sozinhas na próxima sessão. `
    + `Para desligar: /plugin → Marketplaces → ${m.data.marketplace} → Disable auto-update.`
    + (blocked ? ' Atenção: DISABLE_AUTOUPDATER (ou similar) está definido no seu ambiente e desliga toda atualização; defina FORCE_AUTOUPDATE_PLUGINS=1 para as atualizações de plugin.' : '');
}

module.exports = { ensureAutoUpdate, takeAutoUpdateNotice, marketplaceOf, configDir, MARKER };
