#!/usr/bin/env node
/**
 * brain-warm.js — download + verify the embedding model so the Brain learning
 * loop (semantic retrieval + dedup→recurrence→skill promotion) works out of the
 * box.
 *
 * Runs from postinstall (plugin-setup.js) and via `npm run setup:brain`.
 * Idempotent: a cache hit returns fast. Internet is required only the first time
 * (to fetch the model) — which is a safe assumption, since the plugin itself was
 * just downloaded over the network.
 *
 * One-time migration: if the model already lives in the legacy node_modules cache
 * (older installs), it is copied into the durable cache instead of re-downloaded.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const embedder = require('./brain-embedder.js');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

/** Copy a model from the legacy node_modules cache to the durable cache (once). */
function migrateLegacyCache(model, durableDir) {
  try {
    const dest = path.join(durableDir, model);
    if (fs.existsSync(dest)) return false;
    const legacy = path.join(PLUGIN_ROOT, 'node_modules', '@xenova', 'transformers', '.cache', model);
    if (!fs.existsSync(legacy)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(legacy, dest, { recursive: true });
    return true;
  } catch (err) {
    console.error(`[brain-warm] cache migration skipped: ${err.message}`);
    return false;
  }
}

(async () => {
  const t0 = Date.now();
  const model = embedder.getModel(); // loads config → sets provider/model/dimensions
  const provider = embedder.getProvider();

  if (provider !== 'transformers') {
    console.log(`[brain-warm] provider="${provider}" has no local model to fetch (readiness depends on the external service). Skipping warm.`);
    return;
  }

  const cacheDir = embedder.getModelCacheDir();
  if (migrateLegacyCache(model, cacheDir)) {
    console.log(`[brain-warm] migrated existing model from node_modules → ${cacheDir}`);
  }

  const cached = fs.existsSync(path.join(cacheDir, model));
  console.log(
    `[brain-warm] ${cached ? 'verifying cached model' : 'downloading model (~100-200 MB)'} ` +
    `"${model}" in ${cacheDir} …`
  );
  const ok = await embedder.init();
  const status = embedder.getStatus();
  if (!ok || !status.ready) {
    const err = status.error || 'unknown error';
    console.error(`[brain-warm] FAILED to initialize embedder: ${err}`);
    if (/sharp/i.test(err)) {
      console.error(
        '[brain-warm] This is the native "sharp" dependency of @xenova/transformers. Try, in order:\n' +
        '  1. npm rebuild sharp                  (re-fetch the prebuilt binary)\n' +
        '  2. npm install --include=optional\n' +
        '  3. No sharp prebuilt for your platform? Set embedder.provider to "ollama" or\n' +
        '     "voyage" in config/brain-config.json — those need no native deps.'
      );
    }
    process.exit(1);
  }

  const vec = await embedder.embed('warmup probe');
  if (!Array.isArray(vec) || vec.length !== embedder.getDimensions()) {
    console.error(`[brain-warm] verify FAILED: expected ${embedder.getDimensions()}-dim vector, got ${vec ? vec.length : 'null'}`);
    process.exit(1);
  }

  console.log(`[brain-warm] OK — ${status.model} (${vec.length}-dim) ready in ${Date.now() - t0}ms`);
})().catch((err) => {
  console.error(`[brain-warm] crashed: ${err.message}`);
  process.exit(1);
});
