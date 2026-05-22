# Upgrade: Voyage AI Embedding Provider

Replace the default Transformers.js (CPU, offline, 384-dim) with Voyage AI's cloud API — higher quality embeddings, larger dimensions, superior semantic search. Best for production deployments.

## Prerequisites

- Voyage AI API key from [voyageai.com](https://www.voyageai.com/)
- Set as environment variable: `VOYAGE_API_KEY`

## Step 1 — Set API Key

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, or Windows env vars)
export VOYAGE_API_KEY="pa-...your-key..."
```

Claude Code inherits environment variables from the shell, so this is sufficient.

## Step 2 — Update Config

Edit `config/brain-config.json`:

```json
{
  "embedder": {
    "provider": "voyage",
    "model": "voyage-4-lite",
    "dimensions": 1024
  }
}
```

Recommended Voyage models:

| Model | Dimensions | Best for |
|-------|-----------|----------|
| `voyage-4-lite` | 1024 | General purpose, fastest |
| `voyage-3-large` | 1536 | Maximum accuracy |
| `voyage-code-3` | 1536 | Code retrieval (planned) |

> **Important**: `dimensions` must match the model's output. Incompatible vectors break all search results.

## Step 3 — Verify

```bash
VOYAGE_API_KEY="pa-..." node -e "
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
Provider: voyage
Dimensions: 1024
First 5 values: [0.0234, -0.0567, 0.0891, ...]
```

## Step 4 — Re-index KB

Voyage 1024-dim vectors are incompatible with Transformers 384-dim. Re-index all entries:

```bash
node -e "
  const store = require('./scripts/brain-store.js');
  await store.init({ project: 'your-project' });
  console.log('Entries to re-index:', await store.count());
"
```

Then trigger brain-indexer — it auto-detects dimension mismatch and re-generates all vectors.

## Cost Estimate

Voyage pricing (as of 2025):

| Model | Price per 1M tokens |
|-------|-------------------|
| `voyage-4-lite` | $0.10 |
| `voyage-3-large` | $0.20 |

At ~100 embeddings/project with ~100 tokens each → **<$0.001 per project**. Negligible.

## How It Works

```
User input
    ↓
brain-embedder.js → HTTPS → api.voyageai.com → Voyage AI GPU cluster
    ↓
1024-dim vector → brain-store.js → SQLite BLOB
    ↓
cosine similarity → ranked results (better quality at 1024 dims)
```

## Trade-offs

| Aspect | Transformers.js | Voyage AI |
|--------|----------------|-----------|
| Cost | Free | ~$0.10/1M tokens |
| Quality | Good (384-dim) | Excellent (1024-dim) |
| Latency | ~50ms local | ~100ms network |
| Offline | Yes | No (requires internet) |
| Setup | npm install | API key + env var |
| Privacy | Full (local) | Data sent to Voyage |
| Maintain | Zero | API versioning, keys |

Choose Voyage when search quality matters more than latency or privacy. The 1024-dim vectors capture more semantic nuance, which measurably improves retrieval relevance.
