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
| `enabled` | bool | `false` | **Removido** (era o cost-routing per-turn, que quebrava o prompt cache): ignorado, só avisado no log do router |
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
| `upstream.enabled` | bool | `false` | Gateway custom que preserva as credenciais recebidas do Claude Code |
| `upstream.baseUrl` | string | `""` | Fallback legado para derivar URLs operacionais |
| `upstream.wireProtocol` | enum | `"anthropic"` | `anthropic` ou `openai` |
| `upstream.endpoints.models` | URL | `""` | URL completa de listagem de modelos |
| `upstream.endpoints.generate` | URL | `""` | URL completa de geração (`/v1/messages`, `/v1/chat/completions` ou path próprio) |
| `upstream.endpoints.countTokens` | URL | `""` | URL completa de contagem; em OpenAI deve ser explícita, pois não há padrão |
| `upstream.endpoints.classify` | URL | `""` | URL de classificação; vazia herda `generate` |
| `upstream.modelAliasPrefix` | string | `"anthropic-"` | Prefixo externo usado para modelos não Anthropic aparecerem no picker |
| `upstream.forwardHeaders` | string[] | `[]` | Headers recebidos do Claude Code que também seguem ao gateway |
| `byok.enabled` | bool | `false` | Endpoint próprio com headers próprios; nunca recebe a credencial da assinatura |
| `byok.mode` | enum | `"on-limit"` | `on-limit` = só no 429; `always` = atende tudo |
| `byok.baseUrl` | string | `""` | Fallback legado para derivar URLs operacionais |
| `byok.wireProtocol` | enum | `"anthropic"` | `anthropic` ou `openai` |
| `byok.endpoints.*` | URL | `""` | Mesmas quatro URLs por operação de `upstream.endpoints` |
| `byok.openaiCompat` | objeto | `{}` (= `"null"`/`"keep"`/`"text"`) | Só com `wireProtocol: "openai"`. Valores são strings: `assistantEmptyContent` `"null"` ou `"empty"` (vale para assistant com tool calls e sem texto), `systemInMessages` `"keep"` ou `"reject"`, `toolReference` `"text"` ou `"reject"`. Valor ou chave inválida = config do BYOK inválida |
| `byok.modelMap` | objeto `{origem: destino}` (ou lista de regras) | ausente (sem mapeamento) | Troca o `model` enviado ao endpoint BYOK (só na rota BYOK: `always`, `on-limit`, cooldown; geração, classify remoto e `count_tokens`). Ordem: ID exato → ID sem data de snapshot (`-AAAAMMDD`) → padrões com `*` (mais caracteres literais vence; empate pela ordem). Sem prefixo implícito, sem regex (imune a ReDoS), até 500 regras; nome > 256 chars ou fora de ASCII visível nunca casa; origem só com dígitos é recusada. Sem regra, o `model` segue como veio |
| `byok.modelInjection` | objeto | ausente (desligado) | Injeta o modelo resolvido em campos extras do corpo (`{"body": {"metadata.force_model": "{model}"}}`) ou em headers. Único placeholder `{model}` (obrigatório em todo template); nada é avaliado como código. Recusa campos de protocolo do corpo, headers de credencial/protocolo/roteamento; valor de header até 1024 chars |
| `byok.headers` | map | `{}` | Headers livres (ex.: `Authorization: Bearer ...`). **Nunca commitar valores reais** |
| `byok.classifyRemote` | bool | `false` | **ADR-010**: classifica via SEU endpoint (~500 chars/sessão, modelo haiku). on-limit: só com cooldown ativo. Falha → MiniLM local |
| `byok.modelAliasPrefix` | string | `"anthropic-"` | Prefixo externo usado para modelos não Anthropic aparecerem no picker |
| `byok.fixedEndpoint` | bool | `false` | OPT-IN. `false` = endpoint ROTATIVO (ex.: "auto/best-free" entre vários modelos gratuitos) — usa o teto de timeout longo (`ROUTER_BYOK_UPSTREAM_TIMEOUT_MS`, default 100000ms), pensado pro próprio failover interno dele. `true` = endpoint FIXO e único do usuário (ex.: gateway corporativo específico, sem rotação) — usa um teto bem mais curto (`ROUTER_BYOK_FIXED_UPSTREAM_TIMEOUT_MS`, default 20000ms), já que aí uma demora grande só significa rede/serviço degradado, não failover em andamento |
| `byok.fixedTimeoutMs` | number\|null | `null` | Override OPCIONAL (ms) do teto de TTFB quando `byok.fixedEndpoint=true`, substituindo `ROUTER_BYOK_FIXED_UPSTREAM_TIMEOUT_MS` só para este endpoint. `0` é um valor válido e explícito: **sem limite** — quem corta a chamada nesse caso é o teto de ~300s do próprio Claude Code CLI, não o router. `null`/ausente = usa o padrão do env var |
| `byok.rotatingTimeoutMs` | number\|null | `null` | Mesma semântica de `byok.fixedTimeoutMs`, só que para `byok.fixedEndpoint=false` (substitui `ROUTER_BYOK_UPSTREAM_TIMEOUT_MS`). `0` = sem limite (teto do Claude Code CLI vira o backstop) |
| `byok.logLatency` | bool | `false` | OPT-IN. Quando `true`, loga (INFO) o TTFB (tempo até o primeiro byte da resposta) de cada chamada a este endpoint BYOK — útil para calibrar `fixedTimeoutMs`/`rotatingTimeoutMs` observando o comportamento real sob carga, ou com modelos que não fazem streaming de *thinking* (ex.: AWS Bedrock, que retorna só o bloco final) |
| `tenants` | map | `{}` | **ADR-011**: config por projeto (`{ "<projectId>": { sticky?, fallback?, byok?… } }`), shallow-merged sobre a global quando o request traz o header |

### Multi-tenant (`X-CCB-Tenant`, ADR-011)

Cada projeto pode declarar sua própria rota. No `.claude/settings.local.json` do projeto:

```json
{ "env": { "ANTHROPIC_CUSTOM_HEADERS": "X-CCB-Tenant: meu-projeto" } }
```

- Header válido (`[a-z0-9-]`, ≤64 chars) → sticky pins, métricas e histórico ficam isolados sob esse tenant; `tenants[tenant]` é shallow-merged sobre a config global
- Sem header / header inválido → bucket global `_`, comportamento idêntico ao single-tenant (fail-open)
- Um tenant NÃO pode declarar `tenants` (sem recursão)
- Requer Claude Code ≥ 2.1.227; requerer CC Desktop reiniciado após editar o settings

### Série histórica (FASE D)

> Rows ganham campo `tenant` (ADR-011); rows sem o campo = global. `GET /api/router/history?tenant=` filtra. Cap de 90 **dias distintos** — tenants não encolhem a janela.

`DATA_DIR/model-router/metrics-history.jsonl`: uma row por dia com **deltas** dos contadores cumulativos (total/downgrades/planB/economia), cap de 90 dias. Exposta em `GET /api/router/history`; sparkline SVG na aba Router. `/metrics/reset` fecha a row aberta com stamp `reset:true`.

### Precedência dos Modos (`resolveMode()`)

```
sticky.enabled===true        → sticky-tier    (verde)
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
| `backend.mcpMemory.autoUpdate.enabled` | `true` | No HTTP, verifica/aplica updates no `SessionStart` |
| `backend.mcpMemory.autoUpdate.allowRemote` | `false` | Permite chamar `update` em `serverUrl` não-loopback; fallback de restart local continua proibido |
| `backend.mcpMemory.autoUpdate.intervalMs` | `86400000` | Intervalo mínimo entre tentativas (24h) |
| `backend.mcpMemory.autoUpdate.updateTimeoutMs` | `30000` | Teto da chamada mutável `update` sem retry |
| `backend.mcpMemory.autoUpdate.restartTimeoutMs` | `25000` | Teto para `/health.version` confirmar a versão nova |
| `embedder.provider` | `"transformers"` | `transformers` (local, offline), `ollama`, `voyage` |
| `embedder.model` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 50 idiomas, 384 dim |
| `retrieval.fastTopK` | `1` | Resultados na busca rápida (in-loop) |
| `retrieval.deepTopK` | `3` | Resultados na busca profunda |
| `retrieval.minScoreFast` | `0.50` | Score mínimo cosine (fast) — calibrado p/ multilingual MiniLM |
| `kb.retrieval.compose.maxQueryChars` | `300` | (`mcp-memory`) Teto do texto do prompt enviado ao recall; o custo do compose no servidor cresce com o tamanho (em prompts reais: 800 → mediana 9 s, metade estourava o prazo de 8 s; 300 → 5 s). `0` = prompt inteiro |
| `kb.retrieval.compose.projectArmMinScore` | `0.65` | (`mcp-memory`) Score mínimo dos hits do braço de projeto (`search_memory` filtrado pelo project id), que roda sempre em paralelo ao compose. Abaixo disso é ruído (~0,5–0,63) |
| `kb.retrieval.compose.timeoutMs` | `8000` | (`mcp-memory`) Prazo de cada braço do recall; no prazo a requisição é cancelada (socket fechado). Cada braço tem disjuntor por taxa de falha: 5 falhas nas últimas 10 pulam as 4 próximas chamadas e deixam 1 sonda |
| `kb.retrieval.compose.poolWarming` | `false` | (`mcp-memory`) Busca extra no pool home a cada prompt, para o servidor promover docs; só ajuda com a promoção do servidor ligada (`promotion_mode=multi_signal`) |
| `kb.maxEntriesPerProject` | `10000` | Teto de entradas por projeto |
| `kb.submission.minBashLines` | `3` | Mínimo de linhas de output Bash p/ submissão |
| `kb.submission.minOutputChars` | `1500` | Mínimo de chars p/ submissão |
| `kb.capture.maxBlockAttempts` | `5` | Tentativas de re-block da oferta de captura antes de relentar; ao relentar a oferta fecha, a sessão para de oferecer e os ciclos esperam uma próxima sessão do projeto (adoção 24 h depois do fim da sessão) |
| `kb.capture.turns` | `3` | Quantos turnos humanos FINAIS do transcript a captura lê a cada Stop (`lib/transcript-turns.js`) — nunca o transcript inteiro |
| `kb.capture.includeThinking` | `false` | Inclui o thinking do assistente nos ciclos oferecidos para captura (tool call/output nunca entram) |
| `curation.maxOutputChars` | `1500` | Saída de um comando acima disso conta como volumosa para a curadoria |
| `curation.maxOutputLines` | `30` | Idem, em linhas |
| `curation.oneHitMaxRecurrence` | `3` | Teto de recorrência de um comando marcado como uso único; passou disso, a curadoria volta a ser pedida |
| `curation.oneHitWindowDays` | `90` | Janela da contagem de recorrência |
| `curation.shapeMaxLines` | `80` | Sem Token Guard instalado: linhas de um comando de exploração isolado que chegam ao modelo (o resto fica em `.runtime/shaped`, com o caminho indicado) |
| `curation.shapeMaxChars` | `8000` | Idem, em caracteres |

### Data dirs e identidade de instalação

O Claude Code dá a cada modo de lançamento um **sufixo próprio** de data dir sob
`~/.claude/plugins/data/`: `claude-code-boss` (legado/bare), `claude-code-boss-inline`
(dev / `--plugin-dir`), `claude-code-boss-<marketplace>` (instalação via marketplace).
Por isso uma máquina pode acumular irmãos povoados com lições invisíveis entre si.

- O pointer global (`~/.claude/claude-code-boss/active-data-dir.json`) mantém ativo o
  dir MAIS PESADO (guard anti-regressão) — mas os irmãos antigos não se fundem sozinhos.
- `node scripts/doctor.js` reporta fragmentação com contagem de entradas por dir.
- `node scripts/consolidate-datadirs.js` (dry-run) → `--apply`: funde tudo no dir
  ativo — backup-first, graft por id, reconcile do corpo mais recente vence,
  recurrence MAX no mesmo id (não infla o rerank; SUM só para near-dups de ids
  diferentes), verify-before-delete, nunca apaga o dir ativo.
- `-inline` ativo num install de marketplace = houve lançamento dev/inline nessa
  máquina e ele venceu o guard por peso. Consolide para reabsorver.

### Identidade de Projeto

O recall e escopado por `projectId`. Resolucao em ordem (fail-loud se nada resolver):

1. Env `CCB_PROJECT_ID`
2. `.memory/project.json` (`metadata.defaults.project_id`) — mecanismo atual
3. Legacy `.claude-boss-project` na raiz — deprecado, ainda honrado
4. Git remote origin normalizado (`host/owner/repo`)

Sem id (2.29.1): memória desligada na pasta — `brain_retrieve_context` volta vazio,
os KB tools com `cwd` sem id são recusados (`NO_PROJECT_ID`), e o SessionStart +
Stop (`project-id-stop`) pedem para definir o id. Avisos desligáveis com
`onboarding.projectIdentity: false`.

---

## 3. Hooks

### Arquivo: `<globalDir>/hooks/user-config.json`

Shipped em `claude-code-boss/config/hooks-config.json`; override do usuário em `~/.claude/claude-code-boss/hooks/user-config.json`.

> Nota: o fallback hardcoded no código (caso o shipped esteja ausente/corrompido) é `dev`, diferente do default de fábrica (`standard`).

| Chave | Default | Descrição |
|-------|---------|-----------|
| `profile` | `"standard"` | `standard` (quiet), `dev` (tudo on, curadoria 3x), `free` (passthrough, zero blocking) |
| `hooks.<name>.enabled` | varia | Toggle individual por hook |
| `disabledHooks` | `[]` | Hooks desligados no painel (ids das ferramentas `hook_*` servidas pelo daemon); o daemon responde `{}` sem rodá-los. Os hooks de comando (dispatchers, ensure do roteador) são infraestrutura e não entram aqui |
| `memoryRotate.maxLines` | `150` | Rotação do MEMORY.md (max 500; CC trunca em 200) |
| `errorGuard.enabled` | `true` | Bloqueia Bash com falha recorrente conhecida |
| `powershellGuard.enabled` / `.advisory` / `.platforms` | `true` / `false` / `["win32"]` | Corrige sozinho o PowerShell (escape de `$`/crase em `powershell -Command` via Bash, `&&`/`||` e `2>&1` no 5.1) e avisa o resto; `advisory: true` só avisa, nunca reescreve. Também liga o aviso de SessionStart com a edição de cada ferramenta |
| `fileFormatGuard.enabled` | `true` | `Write` sobre arquivo existente preserva o EOL (CRLF/LF) e o BOM originais |
| `shellEscapeGuard.enabled` / `.mode` | `true` / `"rewrite"` | Windows: move heredoc / `node -e` / `python -c` longo para arquivo e reescreve o comando (o Bash tool corrompe `\\` e aspas). `"warn"` só avisa |
| `shellEscapeGuard.block` | `false` | O que não dá para reescrever com segurança vira `deny` em vez de aviso |
| `shellEscapeGuard.inlineMaxChars` / `.platforms` | `300` / `["win32"]` | Tamanho a partir do qual `node -e` sem `\`/aspas/quebra é movido; onde o guard age |
| `captureTriggerEvidence` | `false` | OPT-IN: captura snippets de triggers de shadow policies |
| `specFunnel.enabled` | `false` | OPT-IN, desligado por padrão: injeta no SessionStart e no SubagentStart (junto das políticas, mesmo bloco `[BRAIN policy]`) uma instrução curta "procure o que já existe e reaproveite antes de escrever; entregue o menor diff; diga o que pulou". Só vale ligar em projeto **sem** CLAUDE.md/AGENTS.md/regras próprias: medido em projeto cru, o reaproveitamento de helper subiu de 58% para 100%, a custo de +9% a +17% por execução; quem já tem regras não ganha e só paga. Para ligar, ponha `{ "specFunnel": { "enabled": true } }` em `<globalDir>/hooks/user-config.json` (só `true` liga; vale numa sessão nova). Respeita `policyInject.enabled=false` |
| `compaction.enabled` | `true` | Compactação controlada (`hooks/compaction.mjs`); `free` desliga |
| `compaction.thresholdPercent` | `30` | % (10–80) da janela que o engine aplica (limite do modelo ou `CLAUDE_CODE_AUTO_COMPACT_WINDOW`); acima, compacta no próximo prompt **só com o cache do provedor já expirado** — nunca com ele quente. Slider no dashboard (`PUT /api/compaction/config`, gravado aqui) |
| `compaction.minIntervalMinutes` | `10` | Intervalo mínimo (1–60) entre duas compactações do gate |
| `compaction.preserveRecentMessages` | `6` | Mensagens mais novas que a poda nunca toca |
| `compaction.phaseRestart` | `false` | Reinício em fases: um aviso (< 80 tokens) para seguir a próxima fase numa sessão nova com um handoff curto, passado `phaseRestartTokens`, com cache quente, depois de um turno com `git commit`. Ligar pelo painel mede antes as transcrições (só leitura) e só liga direto se houver ganho |
| `compaction.phaseRestartTokens` | `400000` | Limiar do aviso (100 mil–900 mil tokens) |

Trocar perfil: `/dashboard` → aba Hooks, ou `/boss-profile <standard|dev|free>`.

### Eventos Hook Utilizados

| Evento | Scripts |
|--------|---------|
| `SessionStart` | model-router-ensure, memory-rotate, session-whitelist, brain-health, project-snapshot, curation-session, doctor-advisory, review-checklist-advisory, tuning-advisory, project-identity-advisory, graph-warm, powershell-advisory, policy-inject |
| `UserPromptSubmit` | model-router-ensure, brain-health, correction-detect, active-research-detect, brain_retrieve_context (MCP) |
| `PreToolUse` | curation-guard + error-guard (Bash); session-practices (Bash, PowerShell; desligado no perfil `free`); powershell-guard (PowerShell); file-format-guard (Write); policy-enforce-shadow (Edit); graph-guard (Grep/Glob) |
| `PostToolUse` | curation-detect, decision-detect (Bash); file-format-guard (Write); file-edit-detect (Edit/Write/NotebookEdit); policy-glob-inject (Edit/Write/MultiEdit/NotebookEdit) |
| `Stop` | stop-dispatcher (coordena 17 detectors in-process, incl. project-id-stop) |
| `SubagentStart` | policy-inject |
| `UserPromptExpansion` | skill-metric |
| `PostToolUseFailure` | curation-detect, failure-detect |
| *function hooks* (`modules`) | `hooks/compaction.mjs`: `classic.SessionStart`, `session.start`, `prompt.submit`, `turn.start`, `session.measure`, `turn.complete`, `session.compact`, `session.end` |

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
| `ROUTER_UPSTREAM_TIMEOUT_MS` | Teto de TTFB p/ Anthropic direta (default `8000`) |
| `ROUTER_BYOK_UPSTREAM_TIMEOUT_MS` | Teto de TTFB p/ BYOK rotativo (`byok.fixedEndpoint=false`) e p/ o gateway alternativo (`upstream.*`) (default `100000`) |
| `ROUTER_BYOK_FIXED_UPSTREAM_TIMEOUT_MS` | Teto de TTFB p/ BYOK fixo (`byok.fixedEndpoint=true`) (default `20000` — ponto de partida, não medido em produção como o valor acima; ajuste conforme a latência real do seu endpoint) |
| `ROUTER_BYOK_CLASSIFY_TIMEOUT_MS` | Teto p/ a chamada de pré-classificação remota via BYOK (`byok.classifyRemote`) (default `5000`) |
| `ROUTER_UPSTREAM_ENABLED` / `ROUTER_BYOK_ENABLED` | Liga o perfil (`true/false`, `1/0`, `yes/no`, `on/off`) |
| `ROUTER_UPSTREAM_WIRE_PROTOCOL` / `ROUTER_BYOK_WIRE_PROTOCOL` | `anthropic` ou `openai` |
| `ROUTER_UPSTREAM_BASE_URL` / `ROUTER_BYOK_BASE_URL` | Base URL legada usada quando a URL operacional está vazia |
| `ROUTER_UPSTREAM_MODELS_URL` / `ROUTER_BYOK_MODELS_URL` | URL completa de modelos |
| `ROUTER_UPSTREAM_GENERATE_URL` / `ROUTER_BYOK_GENERATE_URL` | URL completa de geração |
| `ROUTER_UPSTREAM_COUNT_TOKENS_URL` / `ROUTER_BYOK_COUNT_TOKENS_URL` | URL completa de contagem |
| `ROUTER_UPSTREAM_CLASSIFY_URL` / `ROUTER_BYOK_CLASSIFY_URL` | URL completa de classificação |
| `ROUTER_UPSTREAM_MODEL_ALIAS_PREFIX` / `ROUTER_BYOK_MODEL_ALIAS_PREFIX` | Prefixo externo do alias no picker |

---

## 5. Dashboard

Iniciar: `/dashboard` (slash command) ou `node scripts/dashboard-start.js`.

- Bind: `127.0.0.1`, porta efêmera
- Auth: token de sessão (injetado no HTML) + allowlist de **Host header** (`localhost:<port>` / `127.0.0.1:<port>`, anti DNS-rebinding)
- Abas: Home · Brain KB · Skills · Hooks · Insights · Logs · Router
- Home › **Curation & guards** lê `GET /api/metrics/curation?days&project&root`
  (eventos `curation.*` e dos guards no store de métricas + latência por hook do
  `/health` do brain daemon em `BRAIN_HTTP_PORT`, padrão 38217). `root` = pasta
  de um projeto com `shells.json`, para listar scripts nunca usados (o campo
  "project folder" do painel guarda no navegador). Daemon fora → a latência
  aparece como indisponível, nunca vazia.
- **Retenção de métricas (janela):** os eventos de alto volume que só alimentam contagem —
  `curation.skipped` e `shell-escape.*` — ficam brutos por **14 dias**; depois viram uma linha
  `metrics.daily` por dia e evento com a contagem (e, para `curation.skipped`, a contagem por
  classe), então os totais do painel não mudam. Roda no SessionStart, no máximo uma vez por dia
  por projeto (`metrics-store.compactNoise`). Os demais eventos não são apagados.
- O painel Router configura custom upstream e BYOK por operação. A precedência é
  `dashboard/user-config.json` > variáveis de ambiente > defaults versionados.
- As rotas locais consumidas pelo Claude Code permanecem Anthropic. Quando
  `wireProtocol=openai`, a geração pode apontar para `/v1/chat/completions`; o
  router traduz requests, respostas JSON, SSE e tool calls nos dois sentidos.
- Um ID como `gpt-4.1` é publicado no picker como
  `anthropic-ccb-alias-gpt-4.1` e restaurado antes de chegar ao endpoint. IDs que
  já contêm `claude` ou `anthropic` não são alterados.

Escrever config pelo dashboard = gravar `user-config.json` + spawn síncrono do ensure (`BOSS_ROUTER_FORCE_RESTART=1`) → mudanças aplicam sem restart (exceto quando o banner avisa).

---

## 6. Boas Práticas de Config

1. **Nunca edite o shipped** — updates sobrescrevem
2. **Credenciais** só em `user-config.json` (permissão 0600, fora do git)
3. **Sticky** — o roteamento per-turn foi removido (quebrava o cache)
4. **Auto-update MCP Memory** — `check_update` → `update` sem retry → confirmação
   exata por `/health.version`. Desative com
   `backend.mcpMemory.autoUpdate.enabled=false` no user-config do Brain. No
   Windows, o fallback para JAR bloqueado só relança um PID validado como
   `java.exe -jar mcp-memory-server-*.jar --daemon`
5. **contextTuning** se você usa modelos 1M — evita o teto de 200K atrás de gateway
6. **`.memory/project.json` commitado** no repo — projectId estável entre máquinas (o marker legacy `.claude-boss-project` ainda funciona mas está deprecado)
7. Depois de trocar embedder model: `node scripts/brain-reembed.js` (obrigatório)
