---
name: embedder-switch
description: "**WORKFLOW SKILL** — Safely switch the brain KB embedder (provider/model) end-to-end: validate via Test/Install endpoint, persist config, run mandatory re-embed, advise on hook-driven restart. USE FOR: 'trocar pra voyage-4-lite', 'usar ollama', 'mudar modelo do brain', 'configurar embedder'. DO NOT USE FOR: KB retrieval thresholds, hooks toggle, or other non-embedder config changes."
---

# Embedder Switch — End-to-end Workflow

When the user wants to change the brain embedder (provider, model, or dimensions), follow this exact sequence. Do **not** edit `config/brain-config.json` directly via the Write tool — go through the dashboard API so validation and re-embed are not skipped.

## Prerequisites

The dashboard must be running. If not, launch it via the `config-dashboard` skill first. You will need:

- `DASHBOARD_URL` — `http://localhost:<port>` printed by `node scripts/dashboard.js`
- `DASHBOARD_TOKEN` — printed alongside the URL (header `x-dashboard-token`)

## Step 1 — Validate before saving

**Always call the Test/Install endpoint first.** It downloads/installs the model AND derives the real dimension. Skipping this step risks saving a config that points at an unreachable model (missing API key, ollama not installed, model not in HF).

```bash
curl -s -X POST \
  -H "x-dashboard-token: $DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"<transformers|ollama|voyage>","model":"<id>"}' \
  "$DASHBOARD_URL/api/brain/embedder/test"
```

Response shape: `{ok: true, dim: <int>, ms: <int>}` or `{ok: false, error: "<msg>"}`.

If `ok: false`:
- **transformers** failure → likely network or unknown HF model. Suggest checking the spelling.
- **ollama** failure → "Ollama not installed or not in PATH" → instruct user to install Ollama and `ollama serve`. Do not save.
- **voyage** failure → "VOYAGE_API_KEY not set" → instruct user to `export VOYAGE_API_KEY=pa-xxxx` (Linux/macOS) or `setx VOYAGE_API_KEY pa-xxxx` (Windows + new terminal) and restart the dashboard.
- **Stop here** — do not proceed to save.

## Step 2 — Save config

The dimension reported by Test/Install is the source of truth. Use it.

```bash
# 1. Read current config
CFG=$(curl -s -H "x-dashboard-token: $DASHBOARD_TOKEN" "$DASHBOARD_URL/api/brain/backend-config")

# 2. Patch embedder fields, keep everything else intact (use jq):
NEW=$(echo "$CFG" | jq --arg p "<provider>" --arg m "<model>" --argjson d <dim> \
  '.embedder.provider=$p | .embedder.model=$m | .embedder.dimensions=$d')

# 3. Save
echo "$NEW" | curl -s -X PUT \
  -H "x-dashboard-token: $DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$DASHBOARD_URL/api/brain/backend-config"
```

Server returns `{ok: true, requiresRestart: true}`.

## Step 3 — Mandatory re-embed (only if MODEL changed)

Switching model invalidates every existing embedding (different model → different vectors → search returns garbage). Switching dimension is even worse — vector search will throw.

```bash
node scripts/brain-reembed.js
```

This rebuilds embeddings for every entry in every project KB using the new model. Runs in batches; takes ~1-3 minutes for a 100-entry KB on transformers, longer for cloud providers.

**If only the provider changed but the model+dim are equivalent** (rare — e.g., same `all-minilm` in transformers vs ollama), re-embed is still safer. Default to running it.

## Step 4 — No manual restart needed

The brain-server MCP process is restarted automatically by the SessionStart + UserPromptSubmit hooks on the next user turn. Do not tell the user to restart Claude Code.

## Triggers

| User says | Action |
|---|---|
| "trocar pra voyage-4-lite" | Run all 4 steps with `provider=voyage, model=voyage-4-lite` |
| "usar ollama com nomic" | Steps 1-4 with `provider=ollama, model=nomic-embed-text` |
| "voltar pro transformers" | Steps 1-4 with `provider=transformers, model=Xenova/paraphrase-multilingual-MiniLM-L12-v2` |
| "mudar dimensão pra 768" | Refuse — dimension is derived from model. Ask which model they want. |
| "abrir dashboard pra trocar embedder" | Defer to `config-dashboard` skill, then this one for the wiring |

## Recommended Defaults

When the user is undecided, recommend by use case:

- **Default (Portuguese + English, offline, free)**: `transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dim, ~120 MB)
- **Best free cloud quality**: `voyage` + `voyage-4-lite` (1024 dim, 200M tokens/month free)
- **Best self-hosted quality**: `ollama` + `mxbai-embed-large` (1024 dim, requires Ollama installed)

## Common Pitfalls

- ❌ Editing `config/brain-config.json` with the Write tool — bypasses validation and re-embed.
- ❌ Saving with a guessed dimension — must come from Test/Install response.
- ❌ Skipping re-embed "to save time" — searches will silently return wrong results until re-embed runs.
- ❌ Telling the user "now restart Claude Code" — hooks handle it on next turn.
- ❌ Running Test/Install for a custom model without warning the user about download size (mpnet ~110 MB, mxbai ~669 MB).

## Decision capture

If the user made a non-trivial choice during this workflow (e.g. picked one provider/model over another with a stated reason), call `capture_lesson({type:'decision', title, summary, detail, tags:["decision","architecture","embedder"], sourceUrl: <commit-sha-or-PR-url>})` once after the swap is done. The `decision-detect` hook will also nudge you on the next Stop if a `git commit` / `gh pr create` body looked decision-shaped — don't capture twice for the same key.

## Memory scope note (Plan #7)

The embedder config (`config/brain-config.json`) lives next to the plugin and behaves per-machine. The brain KB is per-project (one DB per `cwd` basename) plus a global `__user__` DB for cross-repo entries (lessons about the user / agent behavior). When recording a decision about the embedder swap itself, prefer `scope: 'user'` if the rationale generalizes ("I prefer voyage on cloud-only machines"); use the default project scope when the choice is tied to this codebase ("this repo's KB is large, ollama is faster locally").
