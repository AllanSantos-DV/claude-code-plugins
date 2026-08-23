# claude-code-boss — Documentação Funcional e de Negócio

> **Versão:** 2.21.9+ | **Última atualização:** 2025-08-22
> **Público:** Agentes analisando o plugin, novos desenvolvedores, PMs, QA

---

## 1. Visão Geral do Negócio

### O que é o claude-code-boss?

Um **plugin para Claude Code** que adiciona três capacidades principais ao assistente:

| Capacidade | Descrição | Valor de Negócio |
|------------|-----------|------------------|
| **Brain KB** | Base de conhecimento semântica com busca vetorial, curadoria automática e loop de aprendizado | Evita repetição de erros, captura conhecimento institucional, reduz tempo de onboarding |
| **Model Router** | Proxy inteligente que roteia requests para o modelo ideal (haiku/sonnet/opus) ou fallback (NVIDIA/BYOK) | Reduz custo em ~60-80%, estende janela de contexto, fallback automático no rate-limit |
| **Curadoria & Curriculum** | Detecção automática de comandos repetidos → geração de wrappers → shells curados | Elimina digitação repetida, padroniza workflows, acelera devs |

### Problemas que Resolve

| Problema | Antes | Depois (com plugin) |
|----------|-------|---------------------|
| **Custo de API** | Sempre usa modelo caro (opus/sonnet) | Roteia para modelo mais barato que resolve a task |
| **Rate limit (429)** | Sessão trava, usuário espera | Fallback automático para NVIDIA/BYOK, sessão continua |
| **Janela de contexto** | 200K fixo, estoura rápido | Auto-compact + tool-search → 1M efetivo |
| **Conhecimento perdido** | Lições morrem na sessão | Brain KB persiste, busca semântica, loop de aprendizado |
| **Comandos repetidos** | Digita tudo manual | Curadoria detecta → cria wrapper → 1 tecla |
| **Erros repetidos** | Mesmo erro toda sessão | Brain captura correção → injeta na próxima sessão |

---

## 2. Funcionalidades de Usuário Final

### 2.1 Brain KB (Base de Conhecimento)

| Feature | Comando/Trigger | Descrição |
|---------|-----------------|-----------|
| **Salvar lição** | Automático (Stop hook) ou `/brain-store` | Captura correções, padrões, decisões |
| **Buscar contexto** | Automático (UserPromptSubmit) | Injeta lições relevantes no prompt |
| **Buscar manual** | `/brain-search "query"` | Busca semântica + keyword fallback |
| **Consolidar** | `/brain-consolidate` | Merge de near-duplicates, limpeza |
| **Migrar** | `/brain-migrate` | Local SQLite ↔ MCP Memory Server |

**Tipos de entrada:** `lesson` (correção), `pattern` (padrão reutilizável), `decision` (escolha arquitetural), `research` (findings externos), `code` (snippet), `reference` (link/doc).

### 2.2 Model Router (Roteador de Modelos)

#### Modos de Operação

| Modo | Ativação | Comportamento | Cache |
|------|----------|---------------|-------|
| **Off** | Default | Direto Anthropic, sem proxy | Nativo (1M) |
| **Sticky Router** | `/dashboard` → Router → Sticky ON | Classifica **1x** no turno 0, fixa modelo p/ sessão | Preservado (modelo fixo) |
| **Fallback Only** | `/dashboard` → Fallback ON | Passthrough Anthropic, só intervém no 429 | Preservado |
| **Routing (deprecated)** | `/dashboard` → Routing ON | Reclassifica a **cada request** | Quebra (modelo muda) |
| **BYOK Direct** | `/dashboard` → BYOK always | Proxy p/ endpoint próprio sempre | N/A |

#### Recursos de Economia

| Feature | Descrição | Impacto |
|---------|-----------|---------|
| **Sticky Router** | Classifica 1x, fixa modelo | Preserva prompt cache (modelo constante) |
| **Ceiling (teto)** | Nunca sobe acima do modelo escolhido | Usuário controla custo máximo |
| **Context Tuning** | `ENABLE_TOOL_SEARCH=true` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` | ~50-70% redução tokens input |
| **Fallback 429** | NVIDIA/BYOK quando janela esgota | Sessão nunca trava por rate limit |
| **NVIDIA Key** | Gratuita em build.nvidia.com | Plano B gratuito |
| **BYOK** | Endpoint próprio (OpenRouter, etc) | Controle total de custo/modelos |

#### Dashboard UI (`/dashboard` → aba Router)

| Controle | Ação |
|----------|------|
| **Sticky Router** | Liga/desliga roteador cache-safe |
| **Fallback 429** | Liga/desliga rede de segurança |
| **Routing (deprecated)** | Liga/desliga roteamento per-turn |
| **BYOK** | Configura endpoint próprio (URL + headers) |
| **NVIDIA Key** | Cola chave `nvapi-...` |
| **NVIDIA Classify** | Opt-in: envia ~500 chars p/ NVIDIA classificar |
| **Desligar tudo** | **Botão master** — zera tudo + contextTuning OFF |

### 2.3 Curadoria & Shells Curados

| Stage | Trigger | Ação |
|-------|---------|------|
| **Detect** | PostToolUse/Bash | Detecta comando repetido (>3x) |
| **Guard** | PreToolUse/Bash | Redireciona p/ wrapper se existe |
| **Generate** | Stop hook | Gera `.ps1` wrapper + entrada no `shells.json` |
| **Inject** | UserPromptSubmit | Injeta sugestão de wrapper no prompt |

**Artefatos gerados:** `.ps1` wrapper em `scripts/curated/`, entrada em `shells.json` com signature + metadata.

### 2.4 Comandos Slash Disponíveis

| Comando | Descrição |
|---------|-----------|
| `/dashboard` | Abre dashboard web (Router, Brain, Curadoria, Logs) |
| `/plugin list` | Lista plugins instalados |
| `/plugin install <name>` | Instala plugin do marketplace |
| `/brain-search "query"` | Busca semântica no Brain KB |
| `/brain-store` | Salva lição manual |
| `/brain-consolidate [--apply]` | Preview/Apply consolidação near-duplicates |
| `/brain-migrate` | Migra local ↔ MCP Memory |
| `/brain-reembed` | Re-embeda toda KB (troca modelo embedding) |
| `/doctor` | Health check completo (Node, deps, Brain, Router, Hooks) |
| `/reload-plugins` | Recarrega plugins sem reiniciar Claude Code |

---

## 3. Arquitetura (Alto Nível)

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLAUDE CODE CLIENT                       │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────────┐ ┌──────────────┐ ┌──────────────┐
    │   HOOKS SYSTEM  │ │  DASHBOARD   │ │  MODEL ROUTER │
    │  (Claude hooks) │ │  (HTTP API)  │ │  (Proxy HTTP) │
    └────────┬────────┘ └──────┬───────┘ └──────┬───────┘
             │                 │                 │
    ┌────────┴────────┐        │        ┌────────┴────────┐
    ▼                 ▼        ▼        ▼                 ▼
┌─────────┐      ┌─────────┐ ┌─────────┐         ┌─────────────┐
│ Brain KB│      │Curadoria│ │ Dashboard│         │ Model Router│
│(SQLite) │      │(Shells) │ │  (HTTP)  │         │  (Proxy)    │
└─────────┘      └─────────┘ └─────────┘         └─────────────┘
       │                                   │
       └───────────────────┬───────────────┘
                           ▼
                  ┌─────────────────┐
                  │  DATA_DIR       │
                  │ ~/.claude/      │
                  │ plugins/data/   │
                  │ claude-code-boss│
                  └─────────────────┘
```

### Componentes Principais

| Componente | Localização | Responsabilidade |
|------------|-------------|------------------|
| **Hooks** | `hooks.json` + `scripts/*.js` | Interceptam eventos Claude Code |
| **Brain KB** | `scripts/brain-*.js` + `servers/brain-server/` | KB semântica, embedding, busca |
| **Model Router** | `scripts/model-router-ensure.js` + `servers/model-router/` | Proxy HTTP, classificação, fallback |
| **Curadoria** | `scripts/curation-*.js` | Detecção, geração, wrappers |
| **Dashboard** | `scripts/dashboard.js` + `dashboard/index.html` | UI web, API HTTP |
| **Hooks Config** | `scripts/policy-*.js`, `scripts/hooks-config.js` | Políticas, enforcement, injection |

### Data Flow: Request Lifecycle

```
User Prompt
    │
    ▼
UserPromptSubmit Hook
    │
    ├─► model-router-ensure.js  (garante proxy vivo, configura ANTHROPIC_BASE_URL)
    ├─► brain-retrieve-context  (injeta lições relevantes no prompt)
    ├─► correction-detect       (detecta correções do usuário)
    └─► active-research-detect  (detecta necessidade de pesquisa)
    │
    ▼
Claude Code envia request → Model Router (localhost:13456)
    │
    ├─► Sticky Router: classifica 1x → fixa modelo
    ├─► Fallback: passthrough → se 429 → NVIDIA/BYOK
    ├─► BYOK: roteia p/ endpoint próprio
    └─► Anthropic direto (modo off)
    │
    ▼
Response → User
    │
    ▼
Stop Hook
    │
    ├─► stop-dispatcher.js (coordena detectors)
    ├─► curation-detect (detecta comandos repetidos)
    ├─► decision-detect (detecta decisões)
    ├─► failure-detect (detecta falhas)
    ├─► capture-dispatch (oferece captura de lição)
    └─► policy-enforce (enforça policies glob/glob)
```

---

## 4. Configuração e Dados

### Estrutura de Diretórios

```
~/.claude/
├── plugins/
│   ├── data/
│   │   └── claude-code-boss/
│   │       ├── model-router/
│   │       │   ├── user-config.json     # Config do usuário (NVIDIA key, toggles)
│   │       │   ├── metrics.json         # Métricas de economia/uso
│   │       │   ├── router.log           # Log do proxy
│   │       │   └── state.json           # Estado do daemon (pid, port, fingerprint)
│   │       └── brain/
│   │           ├── *.sqlite             # SQLite DB (KB)
│   │           └── embeddings/          # Cache de embeddings
│   ├── cache/
│   │   └── allansantos-plugins/
│   │       └── claude-code-boss/        # Cache do marketplace
│   └── marketplaces/
│       └── allansantos-plugins/
│           └── claude-code-boss/        # Fonte do plugin
├── settings.json                        # Claude Code settings (ANTHROPIC_BASE_URL injetado aqui)
├── model-router-url.txt                 # URL do proxy p/ shim (Windows)
└── claude-code-boss/                    # Configs globais do plugin
    ├── brain-config.json
    ├── hooks-config.json
    └── router-config.json               # Defaults shipped
```

### Configurações Principais

#### `router-config.json` (shipped defaults)

```json
{
  "enabled": false,                    // Routing per-turn (deprecated)
  "sticky": { "enabled": false, "ttlMs": 21600000 },
  "fallback": { "enabled": false, "triggerStatuses": [429] },
  "contextTuning": { "enabled": false },
  "byok": { "enabled": false, "mode": "on-limit" },
  "nim": { "apiKey": "", "classifyRemote": false },
  "routing": { "ceiling": true, "catalog": { "enabled": true } }
}
```

#### `user-config.json` (persiste escolhas do usuário)

```json
{
  "enabled": false,
  "stickyEnabled": true,
  "fallbackEnabled": true,
  "byok": {
    "enabled": false,
    "mode": "on-limit",
    "baseUrl": "https://api.openrouter.ai",
    "headers": { "Authorization": "Bearer sk-...", "HTTP-Referer": "..." }
  },
  "contextTuning": { "enabled": false },
  "nim": { "apiKey": "nvapi-..." },
  "acceptedTerms": true
}
```

> Formato de persistência real (aninhado). As chaves planas (`byokEnabled`, `byokMode`…) existem apenas no **body do POST** `/api/router/apply`; `byokEnabled`/`byokMode` são aceitas como fallback legado, `byokBaseUrl`/`byokHeaders` são ignoradas.

#### Variáveis de Ambiente Injetadas

| Variável | Quando | Valor |
|----------|--------|-------|
| `ANTHROPIC_BASE_URL` | Router ativo | `http://127.0.0.1:13456` |
| `ENABLE_TOOL_SEARCH` | contextTuning ou router ativo | `true` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | contextTuning ou router ativo | `200000` |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | Router ativo | `0` |

---

## 5. Regras de Negócio Críticas

| Regra | Descrição | Onde Aplicada |
|-------|-----------|---------------|
| **Ceiling** | Nunca escala acima do modelo escolhido no dropdown | `router-config.json: routing.ceiling` |
| **Sticky = cache-safe** | Modelo fixo = prompt cache preservado | `sticky.enabled` |
| **Fallback 429 apenas** | Não troca modelo, só intervém no rate limit | `fallback.triggerStatuses: [429]` |
| **BYOK headers preservados** | Trocar modo não apaga headers/baseUrl | `writeRouterOverride` merge |
| **headers: null = limpar** | Limpeza explícita de credenciais | `byokInput.headers === null → {}` |
| **Ceiling BYOK** | BYOK não sobe acima do ceiling | `resolveMode` precedence |
| **Ceiling NVIDIA** | NVIDIA fallback não sobe acima do ceiling | `resolveMode` precedence |
| **Ceiling contextTuning** | contextTuning não afeta modelo, só tokens | Variáveis de ambiente |

---

## 6. Métricas e Observabilidade

### Métricas Coletadas (`metrics.json`)

| Métrica | Descrição |
|---------|-----------|
| `totalRequests` | Total de requests roteados |
| `downgrades` | Quantas vezes desceu modelo (haiku/sonnet) |
| `ceilingHits` | Quantas vezes ceiling impediu upgrade |
| `planBRequests` | Requests via NVIDIA/BYOK (grátis) |
| `estimatedSavingsUSD` | Economia estimada vs baseline |
| `classified` | Requests classificados |
| `servedClaude` | Requests servidos direto Anthropic |

### Logs

| Arquivo | Conteúdo |
|---------|----------|
| `model-router/router.log` | Requests, classificações, fallbacks, erros |
| `dashboard.js` stdout | API calls, errors, ensure spawns |
| Hooks stderr | Detecções, injeções, erros de hook |

---

## 7. Segurança e Privacidade

> 💰 Cobrança assinatura-vs-API com o router: ver [features/ROUTER-BILLING.md](./features/ROUTER-BILLING.md).

| Aspecto | Implementação |
|---------|---------------|
| **NVIDIA Key** | Armazenada em `user-config.json` (0600), nunca logada |
| **BYOK Headers** | Armazenados em `user-config.json` (0600), nunca logados |
| **ANTHROPIC_BASE_URL** | Apenas localhost, injetado via settings.json escopo Claude |
| **Shim Windows** | Wrapper `claude.exe` substitui binário, fail-open se proxy cai |
| **NVIDIA Classify** | Opt-in explícito (`classifyRemote: true`), ~500 chars/request |
| **Brain KB** | Local-first (SQLite), opcional MCP Memory Server remoto |
| **Nenhum dado sai** | Exceto: NVIDIA classify (opt-in), BYOK endpoint (usuário configura) |

---

## 8. Troubleshooting Comum

| Sintoma | Causa Provável | Solução |
|---------|----------------|---------|
| **Router não sobe** | Porta 13456 ocupada | `netstat -ano | findstr 13456` → kill PID |
| **429 não cai no fallback** | `fallback.enabled: false` | `/dashboard` → Fallback ON |
| **Sticky não fixa modelo** | `sticky.enabled: false` | `/dashboard` → Sticky ON |
| **BYOK não autentica** | Headers inválidos | Verificar `Authorization: Bearer ...` |
| **NVIDIA classify falha** | `classifyRemote: false` | `/dashboard` → NVIDIA Classify ON |
| **Settings.json corrupto** | Escrita concorrente | `disableRoutingFootprintAtomic` recupera |
| **Shim não remove** | Windows lock no binário | Fechar todas janelas Claude Code |

---

## 9. Roadmap / Features Planejadas

| Feature | Status | Descrição |
|---------|--------|-----------|
| **Brain MCP Server** | ✅ Done | MCP Memory Server para KB remoto |
| **Router Catalog** | ✅ Done | Catálogo dinâmico via `/v1/models` Anthropic |
| **Context Tuning UI** | ✅ Done (ADR-008) | Toggle na aba Router + kill de órfão no SessionStart (ADR-009) + série histórica |
| **BYOK Classify** | ✅ Done (ADR-010) | Classificação remota via endpoint BYOK (opt-in, gate on-limit) |
| **Multi-tenant Router** | ✅ **Done (ADR-011, 2026-08-23)** — header `X-CCB-Tenant` via `ANTHROPIC_CUSTOM_HEADERS` por projeto; sticky pins/métricas/histórico isolados; [dossiê](./backlog/PHASE-E-multi-tenant-router.md) |
| **Cost Dashboard** | 📋 Backlog | Gráficos de economia por projeto/modelo |
| **Brain Web UI** | 🟢 [Backlog pronto](./backlog/PHASE-F-brain-web-ui.md) (design ADR-012) |

---

## 10. Referências Rápidas

### Comandos Úteis

```bash
# Ver status do router
curl http://127.0.0.1:13456/health

# Ver config efetiva
curl -H "x-dashboard-token: $TOKEN" http://127.0.0.1:13456/api/router/config

# Ver métricas
curl -H "x-dashboard-token: $TOKEN" http://127.0.0.1:13456/api/router/metrics

# Ver log do router
tail -f ~/.claude/plugins/data/claude-code-boss/model-router/router.log

# Health check completo
/doctor

# Recarregar plugins sem reiniciar
/reload-plugins
```

### Arquivos-Chave para Debug

| Arquivo | Para que serve |
|---------|----------------|
| `scripts/model-router-ensure.js` | Garante proxy vivo, injeta env vars |
| `servers/model-router/index.js` | Proxy HTTP, classificação, fallback |
| `scripts/dashboard.js` | API HTTP, persistência config |
| `scripts/model-router-ensure.js:754` | Bloco `mode === 'off'` (cleanup) |
| `scripts/dashboard.js:1426` | `applyRouter` endpoint |
| `dashboard/index.html:1405` | `disableAllRouter()` function |

---

## 11. Glossário

| Termo | Definição |
|-------|-----------|
| **Sticky Router** | Roteador que classifica 1x por sessão e fixa o modelo |
| **Ceiling** | Teto de modelo — nunca escala acima do dropdown do usuário |
| **Fallback 429** | Rede de segurança: passthrough Anthropic, só intervém no rate limit |
| **BYOK** | Bring Your Own Key — endpoint Anthropic-compatível do usuário |
| **Context Tuning** | Variáveis de ambiente que reduzem tokens (tool-search + auto-compact) |
| **Brain KB** | Base de conhecimento semântica com loop de aprendizado |
| **Curadoria** | Pipeline: detecta repetição → gera wrapper → shell curado |
| **Shim** | Wrapper do `claude.exe` (Windows) que injeta `ANTHROPIC_BASE_URL` |
| **DATA_DIR** | `~/.claude/plugins/data/claude-code-boss/` — dados persistentes |
| **ROUTER_USER_CONFIG** | `DATA_DIR/model-router/user-config.json` — config do usuário |

---

*Documentação mantida pelo time do claude-code-boss. Atualize ao adicionar features.*