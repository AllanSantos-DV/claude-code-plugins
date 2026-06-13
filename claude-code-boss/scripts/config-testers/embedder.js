'use strict';
/**
 * config-testers/embedder.js — extracted from dashboard.testEmbedder().
 * Input:  { provider: 'transformers'|'ollama'|'voyage', model: string }
 * Output: { ok, dim?, error?, ms }
 */

async function test(input) {
  const t0 = Date.now();
  const provider = input && input.provider;
  const model = ((input && input.model) || '').trim();
  if (!['transformers', 'ollama', 'voyage'].includes(provider)) {
    return { ok: false, error: 'Invalid provider (expected transformers|ollama|voyage)', ms: Date.now() - t0 };
  }
  if (!model) return { ok: false, error: 'Model is required', ms: Date.now() - t0 };

  try {
    if (provider === 'transformers') {
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', model, { quantized: true });
      const out = await extractor('test', { pooling: 'mean', normalize: true });
      const dim = out.data.length;
      return { ok: true, dim, details: { provider, model }, ms: Date.now() - t0 };
    }
    if (provider === 'ollama') {
      const { spawn } = require('child_process');
      const pullResult = await new Promise((resolve) => {
        const p = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', (err) => resolve({ ok: false, error: `Ollama not installed or not in PATH: ${err.message}` }));
        p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `ollama pull exited ${code}: ${stderr.slice(-200)}` }));
      });
      if (!pullResult.ok) return { ...pullResult, ms: Date.now() - t0 };
      const embedRes = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'test' }),
      }).catch(err => ({ _err: err.message }));
      if (embedRes._err) return { ok: false, error: `Ollama embed call failed: ${embedRes._err}`, ms: Date.now() - t0 };
      if (!embedRes.ok) return { ok: false, error: `Ollama embed HTTP ${embedRes.status}`, ms: Date.now() - t0 };
      const data = await embedRes.json();
      const dim = (data.embedding || []).length;
      if (!dim) return { ok: false, error: 'Ollama returned empty embedding', ms: Date.now() - t0 };
      return { ok: true, dim, details: { provider, model }, ms: Date.now() - t0 };
    }
    if (provider === 'voyage') {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) return { ok: false, error: 'VOYAGE_API_KEY env var not set. Set it before starting the dashboard.', ms: Date.now() - t0 };
      const r = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test', model }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, error: `Voyage HTTP ${r.status}: ${txt.slice(0, 200)}`, ms: Date.now() - t0 };
      }
      const data = await r.json();
      const dim = (data.data?.[0]?.embedding || []).length;
      if (!dim) return { ok: false, error: 'Voyage returned empty embedding', ms: Date.now() - t0 };
      return { ok: true, dim, details: { provider, model }, ms: Date.now() - t0 };
    }
  } catch (err) {
    const error = err.message;
    return { ok: false, error, ms: Date.now() - t0 };
  }
}

module.exports = { domain: 'embedder', test };
