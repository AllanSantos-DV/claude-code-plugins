# Configuration Reference — claude-code-boss

> Todas as opções de configuração, defaults e onde vivem.

## Hierarquia de Configuração

```
shipped config (no pacote do plugin, sobrescrito a cada update)
        ⊕
user-config (DATA_DIR, sobrevive a updates)   ← SUAS ESCOLHAS
        =
config efetiva (lida por ensure/server/dashboard)
```

**Regra de ouro:** o plugin NUNCA edita o shipped. Toda escolha sua vai para `user-config.json` via merge raso (objetos preservam chaves shipadas; escalares sobrescrevem).

---

## 1. Model Router

> 💰 Impacto na cobrança (assinatura vs API) por cenário: [features/ROUTER-BILLING.md](./features/ROUTER-BILLING.md).

### Arquivos

| Arquivo | Caminho | Papel |
|---------|---------|-------|
| Shipped | `claude-code-boss/config/router-config.json` | Defaults + documentação inline extensa |
| User | `<globalDir>/model-router/user-config.json` (0600) | Suas escolhas: toggles, NVIDIA key, BYOK headers |
| State | `DATA_DIR/model-router/state.json` | PID/porta/fingerprint do daemon vivo |
| Log | `DATA_DIR/model-router/router.log` | Requests, classificações, fallbacks |

### Chaves (shipped ⊕ user)

| Chave | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `enabled` | bool | `false` | Cost-routing per-turn (**deprecado** — quebra prompt cache) |
| `sticky.enabled` | bool | `false` | **Sticky Router** — classifica 1x/sessão, fixa modelo. RECOMENDADO |
| `sticky.ttlMs` | int | `21600000` | TTL do pin em memória (6h) |
| `fallback.enabled` | bool | `false` | Rede de segurança no 429 (passthrough cache-safe) |
| `fallback.triggerStatuses` | int[] | `[429]` | Status HTTP que disparam o plano B |
| `fallback.cooldown.*` | obj | ver shipped | Circuit breaker: `noHeaderMs`, `tripAfter`, `probeSuppressMs`, `minMs`, `maxMs` |
| `contextTuning.enabled` | bool | `false` | Grava env-tuning SEM proxy (`ENABLE_TOOL_SEARCH`, `AUTO_COMPACT_WINDOW`) |
| `autoCompactWindow` | int | `200000` | Teto do contexto ativo (clampado [50000, 1000000]) |
| `port` | int | `13456` | Porta FIXA do proxy |
| `routing.ceiling` | bool | `true` | Nunca escala acima do modelo do dropdown |
| `routing.catalog.enabled` | bool | `true` | Catálogo dinâmico via GET /v1/models da Anthropic |
| `routing.haikuTier.model` | string | `claude-haiku-4-5-20251001` | Modelo do tier haiku |
| `routing.sonnetTier.model` | string | `claude-sonnet-4-6` | Modelo do tier sonnet |
| `routing.opusTier.model` | string | `claude-opus-4-8` | Modelo do tier opus |
| `classifier.minScore` | float | `0.3` | Confiança mínima global (MiniLM local) |
| `classifier.defaultTier` | enum | `"sonnet"` | Tier na dúvida |
| `classifier.opusMinScore` | float | `0.4` | Score mínimo absoluto p/ aceitar opus |
| `classifier.opusMargin` | float | `0.05` | Vantagem mínima do opus sobre o 2º colocado |
| `nim.apiKey` | string | `""` | Chave NVIDIA (grátis). Classificação continua LOCAL por padrão |
| `nim.classifyRemote` | bool | `false` | **OPT-IN privacidade**: envia ~500 chars/prompt à NVIDIA p/ classificar |
| `nim.classifierModel` | string | `qwen/qwen2.5-1.5b-instruct` | Modelo NIM de classificação (se classifyRemote) |
| `nim.fallbackModel` | string | `meta/llama-3.3-70b-instruct` | Modelo NIM de geração no plano B |
| `nim.endpoint` | string | `https://integrate.api.nvidia.com/v1/chat/completions` | Endpoint NIM |
| `byok.enabled` | bool | `false` | Endpoint Anthropic-compatível próprio |
| `byok.mode` | enum | `"on-limit"` | `on-limit` = só no 429; `always` = atende tudo |
| `byok.baseUrl` | string | `""` | Host apenas (path é sempre `/v1/messages`) |
| `byok.headers` | map | `{}` | Headers livres (ex.: `Authorization: Bearer ...`). **Nunca commitar valores reais** |
| `byok.classifyRemote` | bool | `false` | **ADR-010**: classifica via SEU endpoint (~500 chars/sessão, modelo haiku). on-limit: só com cooldown ativo. Falha → MiniLM local |

### Série histórica (FASE D)

`DATA_DIR/model-router/metrics-history.jsonl`: uma row por dia com **deltas** dos contadores cumulativos (total/downgrades/planB/economia), cap de 90 dias. Exposta em `GET /api/router/history`; sparkline SVG na aba Router. `/metrics/reset` fecha a row aberta com stamp `reset:true`.

### Precedência dos Modos (`resolveMode()`)

```
sticky.enabled===true        → sticky-tier    (verde)
enabled===true               → routing        (âmbar, deprecado)
fallback.enabled===true      → fallback-only  (azul)
byok.enabled && mode=always  → byok-direct    (roxo)
byok.enabled && mode=on-limit→ fallback-only
nenhum                       → off            (cinza)
```

### Variáveis de Ambiente Injetadas no settings.json

| Env | Quando gravado | Quando removido |
|-----|----------------|-----------------|
| `ANTHROPIC_BASE_URL=http://127.0.0.1:13456` | router ativo (qualquer modo ≠ off) | modo off (só se for NOSSO valor localhost) |
| `ENABLE_TOOL_SEARCH=true` | router ativo OU contextTuning on | disable (só o valor nosso) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` | idem | idem |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | router ativo (melhora cache atrás de gateway) | idem |

**Garantia:** uma `ANTHROPIC_BASE_URL` custom de terceiro é **preservada** — o plugin nunca clobbera valor que não é dele.

---

## 2. Brain KB

### Arquivos

| Arquivo | Caminho | Papel |
|---------|---------|-------|
| Shipped | `claude-code-boss/config/brain-config.json` | Defaults do embedder/backend/thresholds |
| User | `<globalDir>/brain/user-config.json` | Override do usuário |
| DB local | `DATA_DIR/brain/*.sqlite` | KB embarcada (node:sqlite builtin) |

### Chaves Principais

| Chave | Default | Descrição |
|-------|---------|-----------|
| `backend` | `"local"` | `local` (SQLite) ou `mcp-memory` (Java daemon) |
| `embedder.provider` | `"transformers"` | `transformers` (local, offline), `ollama`, `voyage` |
| `embedder.model` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 50 idiomas, 384 dim |
| `retrieval.fastTopK` | `1` | Resultados na busca rápida (in-loop) |
| `retrieval.deepTopK` | `3` | Resultados na busca profunda |
| `retrieval.minScoreFast` | `0.50` | Score mínimo cosine (fast) — calibrado p/ multilingual MiniLM |
| `kb.maxEntriesPerProject` | `10000` | Teto de entradas por projeto |
| `kb.submission.minBashLines` | `3` | Mínimo de linhas de output Bash p/ submissão |
| `kb.submission.minOutputChars` | `1500` | Mínimo de chars p/ submissão |
| `kb.capture.maxBlockAttempts` | `5` | Tentativas de re-block da oferta de captura antes de relentar |

### Identidade de Projeto

O recall e escopado por `projectId`. Resolucao em ordem (fail-loud se nada resolver):

1. Env `CCB_PROJECT_ID`
2. `.memory/project.json` (`metadata.defaults.project_id`) — mecanismo atual
3. Legacy `.claude-boss-project` na raiz — deprecado, ainda honrado
4. Git remote origin normalizado (`host/owner/repo`)

---

## 3. Hooks

### Arquivo: `<globalDir>/hooks/user-config.json`

Shipped em `claude-code-boss/config/hooks-config.json`; override do usuário em `~/.claude/claude-code-boss/hooks/user-config.json`.

> Nota: o fallback hardcoded no código (caso o shipped esteja ausente/corrompido) é `dev`, diferente do default de fábrica (`standard`).

| Chave | Default | Descrição |
|-------|---------|-----------|
| `profile` | `"standard"` | `standard` (quiet), `dev` (tudo on, curadoria 3x), `free` (passthrough, zero blocking) |
| `hooks.<name>.enabled` | varia | Toggle individual por hook |
| `memoryRotate.maxLines` | `150` | Rotação do MEMORY.md (max 500; CC trunca em 200) |
| `errorGuard.enabled` | `true` | Bloqueia Bash com falha recorrente conhecida |
| `captureTriggerEvidence` | `false` | OPT-IN: captura snippets de triggers de shadow policies |

Trocar perfil: `/dashboard` → aba Hooks, ou `/boss-profile <standard|dev|free>`.

### Eventos Hook Utilizados

| Evento | Scripts |
|--------|---------|
| `SessionStart` | model-router-ensure, memory-rotate, session-whitelist, brain-health, project-snapshot, curation-session, doctor-advisory, review-checklist-advisory, tuning-advisory, project-identity-advisory, graph-warm, policy-inject |
| `UserPromptSubmit` | model-router-ensure, brain-health, correction-detect, active-research-detect, brain_retrieve_context (MCP) |
| `PreToolUse` | curation-guard + error-guard (Bash); policy-enforce-shadow (Edit); graph-guard (Grep/Glob) |
| `PostToolUse` | curation-detect, decision-detect, error-resolve (Bash); file-edit-detect (Edit/Write/NotebookEdit); policy-glob-inject (Edit/Write/MultiEdit/NotebookEdit) |
| `Stop` | stop-dispatcher (coordena 16 detectors in-process) |
| `SubagentStart` | policy-inject |
| `UserPromptExpansion` | skill-metric |
| `PostToolUseFailure` | curation-detect, failure-detect |

---

## 4. Variáveis de Ambiente (leitura)

| Env | Efeito |
|-----|--------|
| `CLAUDE_PLUGIN_ROOT` | Raiz do plugin (injetada pelo Claude Code; fallback `__dirname/..`) |
| `CLAUDE_PLUGIN_DATA` | Sobrepõe DATA_DIR (útil p/ testes) |
| `CCB_PROJECT_ID` | Fixa projectId do Brain |
| `MCP_RUN_DIR` | Sobrepõe `~/.mcp-memory/run` (daemon registry) |
| `BOSS_ROUTER_FORCE_RESTART=1` | Ensure derruba daemon órfão no modo off (setado pelo dashboard) |
| `BOSS_ROUTER_MODE` | Diagnóstico apenas (server recomputa da config) |
| `CLAUDE_SKIP_EMBED_WARM` | Pula download/warm do modelo no postinstall |

---

## 5. Dashboard

Iniciar: `/dashboard` (slash command) ou `node scripts/dashboard-start.js`.

- Bind: `127.0.0.1`, porta efêmera
- Auth: token de sessão (injetado no HTML) + allowlist de **Host header** (`localhost:<port>` / `127.0.0.1:<port>`, anti DNS-rebinding)
- Abas: Home · Brain KB · Skills · Hooks · Insights · Logs · Router

Escrever config pelo dashboard = gravar `user-config.json` + spawn síncrono do ensure (`BOSS_ROUTER_FORCE_RESTART=1`) → mudanças aplicam sem restart (exceto quando o banner avisa).

---

## 6. Boas Práticas de Config

1. **Nunca edite o shipped** — updates sobrescrevem
2. **Credenciais** só em `user-config.json` (permissão 0600, fora do git)
3. **Sticky > Routing** — per-turn está deprecado (quebra cache)
4. **contextTuning** se você usa modelos 1M — evita o teto de 200K atrás de gateway
5. **`.memory/project.json` commitado** no repo — projectId estável entre máquinas (o marker legacy `.claude-boss-project` ainda funciona mas está deprecado)
6. Depois de trocar embedder model: `node scripts/brain-reembed.js` (obrigatório)
