#!/usr/bin/env node
/**
 * Brain Embedder — Provider abstraction for text embeddings.
 *
 * Supports three providers, configured via config/brain-config.json:
 *   "transformers" (default) — @xenova/transformers, pure JS ONNX, offline
 *   "ollama"       — Ollama subprocess, local GPU if available
 *   "voyage"       — Voyage AI API, cloud, needs API key
 *
 * Usage:
 *   const embedder = require('./brain-embedder');
 *   await embedder.init();
 *   const vec = await embedder.embed("hello world");
 *   const dim = embedder.getDimensions();
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'brain-config.json');

/**
 * Durable model cache — user-level, NOT inside node_modules.
 * @xenova/transformers defaults its cache to `node_modules/@xenova/transformers/.cache`,
 * which is wiped whenever node_modules is deleted/reinstalled (forcing a ~120 MB
 * re-download). Anchoring it under CLAUDE_PLUGIN_DATA keeps the model across reinstalls.
 */
function embedderDataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env && !env.includes('${')) return env;
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
}
function modelCacheDir() {
  return path.join(embedderDataDir(), 'models');
}

let _initialized = false;
let _provider = 'transformers';
let _model = 'Xenova/all-MiniLM-L6-v2';
let _dimensions = 384;
let _extractor = null;
let _error = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const e = raw.embedder || {};
      _provider = e.provider || 'transformers';
      _model = e.model || 'Xenova/all-MiniLM-L6-v2';
      _dimensions = e.dimensions || 384;
    }
  } catch (err) {
    _error = `Config load error: ${err.message}`;
  }
}

async function initTransformers() {
  try {
    const tf = await import('@xenova/transformers');
    // Redirect the model cache to a durable, user-level location (see modelCacheDir).
    tf.env.cacheDir = modelCacheDir();
    const { pipeline } = tf;
    _extractor = await pipeline('feature-extraction', _model, {
      quantized: true,
    });
    return true;
  } catch (err) {
    _error = `Transformers init failed: ${err.message}`;
    return false;
  }
}

async function embedTransformers(text) {
  if (!_extractor) return null;
  const result = await _extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

async function embedBatchTransformers(texts) {
  if (!_extractor) return null;
  const results = await _extractor(texts, { pooling: 'mean', normalize: true });
  return results.map(r => Array.from(r.data));
}

function embedOllama(text) {
  try {
    const out = execSync(
      `ollama run ${_model.replace(/^.*\//, '')} "${text.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(out.trim());
  } catch (err) {
    _error = `Ollama embed error: ${err.message}`;
    return null;
  }
}

function embedBatchOllama(texts) {
  return texts.map(t => embedOllama(t));
}

async function embedVoyage(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    _error = 'VOYAGE_API_KEY not set';
    return null;
  }
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: _model }),
    });
    if (!res.ok) {
      _error = `Voyage API error: ${res.status} ${res.statusText}`;
      return null;
    }
    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    _error = `Voyage embed error: ${err.message}`;
    return null;
  }
}

async function embedBatchVoyage(texts) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    _error = 'VOYAGE_API_KEY not set';
    return null;
  }
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: _model }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data.map(d => d.embedding);
  } catch (err) {
    _error = `Voyage batch error: ${err.message}`;
    return null;
  }
}

async function init() {
  if (_initialized) return true;
  loadConfig();
  let ok = false;
  switch (_provider) {
    case 'transformers':
      ok = await initTransformers();
      break;
    case 'ollama':
      ok = true;
      break;
    case 'voyage':
      ok = true;
      break;
    default:
      _error = `Unknown provider: ${_provider}`;
      return false;
  }
  _initialized = ok;
  return ok;
}

async function embed(text) {
  if (!_initialized && !(await init())) return null;
  switch (_provider) {
    case 'transformers':
      return embedTransformers(text);
    case 'ollama':
      return embedOllama(text);
    case 'voyage':
      return await embedVoyage(text);
    default:
      return null;
  }
}

async function embedBatch(texts) {
  if (!_initialized && !(await init())) return null;
  switch (_provider) {
    case 'transformers':
      return embedBatchTransformers(texts);
    case 'ollama':
      return embedBatchOllama(texts);
    case 'voyage':
      return await embedBatchVoyage(texts);
    default:
      return null;
  }
}

function getDimensions() { return _dimensions; }

function getProvider() { return _provider; }

/** Active model identifier (after loadConfig). */
function getModel() { loadConfig(); return _model; }

/** Durable cache dir where the transformers model is stored. */
function getModelCacheDir() { return modelCacheDir(); }

function getStatus() {
  return {
    provider: _provider,
    model: _model,
    dimensions: _dimensions,
    ready: _initialized,
    error: _error,
  };
}

module.exports = { init, embed, embedBatch, getDimensions, getProvider, getModel, getModelCacheDir, getStatus };
