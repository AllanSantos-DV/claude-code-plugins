# Upgrade: Ollama Embedding Provider

Replace the default Transformers.js (pure JS, ~22MB download, CPU-only) with Ollama running locally — GPU acceleration, faster inference, larger context windows.

## Prerequisites

- [Ollama](https://ollama.com/) installed and running (`ollama serve`)
- At least one embedding model pulled, e.g.:
  ```bash
  ollama pull nomic-embed-text
  ```

## Step 1 — Update Config

Edit `config/brain-config.json`:

```json
{
  "embedder": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768
  }
}
```

Supported model options and their dimensions:

| Model | Dimensions |
|-------|-----------|
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `all-minilm` | 384 |
| `snowflake-arctic-embed` | 1024 |

> **Important**: `dimensions` must match the model's output. If you change it, you must re-index your KB — vectors from a different model are incompatible.

## Step 2 — Fix the Embedder (Recommended)

The current `embedOllama()` in `scripts/brain-embedder.js` uses `ollama run <model>` which is the **chat** interface and won't return usable embeddings. Replace it to call the Ollama REST API:

```javascript
async function embedOllama(text) {
  try {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: _model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    const data = await res.json();
    return data.embedding;
  } catch (err) {
    _error = `Ollama embed error: ${err.message}`;
    return null;
  }
}
```

For batch:
```javascript
async function embedBatchOllama(texts) {
  const results = await Promise.all(texts.map(t => embedOllama(t)));
  return results;
}
```

This fix is optional — the system degrades to keyword search if embedding fails.

## Step 3 — Verify

```bash
node -e "
  const e = require('./scripts/brain-embedder.js');
  await e.init();
  const v = await e.embed('test query');
  console.log('Provider:', e.getProvider());
  console.log('Dimensions:', v?.length);
  console.log('First 5 values:', v?.slice(0, 5));
"
```

Expected output:
```
Provider: ollama
Dimensions: 768
First 5 values: [0.0123, -0.0456, 0.0789, ...]
```

## How It Works

```
User input
    ↓
brain-embedder.js → fetch('localhost:11434/api/embeddings') → Ollama → GPU/CUDA
    ↓
384/768/1024-dim vector → brain-store.js → SQLite BLOB
    ↓
cosine similarity → ranked results
```

## Re-indexing

If you already have entries stored with Transformers dimensions (384), they must be re-indexed:

```bash
# Optional: clear existing vectors (keeps entries, regenerates embeddings)
node -e "
  const store = require('./scripts/brain-store.js');
  await store.init({ project: 'your-project' });
  const count = await store.count();
  console.log(count, 'entries to re-index');
  // Re-index all entries via brain-indexer
"
```

The brain-indexer subagent regenerates embeddings when it detects dimension mismatch.

## Trade-offs

| Aspect | Transformers.js | Ollama |
|--------|----------------|--------|
| Dependencies | npm package | System install |
| First load | ~22MB download | ~300MB+ model pull |
| Speed | CPU, ~50ms | GPU/CUDA, ~5ms |
| Offline | Yes | Yes |
| Memory | ~200MB RAM | ~1GB+ RAM/VRAM |
| Context window | 256 tokens | 512+ tokens |

Choose Ollama if you have a GPU or need lower latency at scale (>10K entries). Stick with Transformers.js for portability and simplicity.
