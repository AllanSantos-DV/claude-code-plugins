<!-- ⚠️ HISTÓRICO / OBSOLETO (pré slim-down 2026-05-29). Este roadmap descreve o
     port original VS Code→plugin (Boss/Party/Discovery), grande parte REMOVIDA na
     refatoração slim-down. Estado e direção atuais:
       • O que ficou e por quê → `claude-code-boss/REFACTOR-PLAN.md`
       • Plano de novas features (Brain hygiene, integração c/ memória nativa)
         → `claude-code-boss/FEATURES-PLAN.md` -->

# Plano de Implementação — copilot-delegate como Plugin do Claude Code

## Visão Geral

Empacotar os sistemas do **copilot-delegate** (Boss, Brain, Party, Discovery) como um **plugin Claude Code**,
permitindo rodar tudo via CLI (`claude --plugin-dir ./plugin`) sem depender do VS Code.

---

## Mapeamento Componente → Formato Plugin

| Sistema VS Code | Formato Plugin Claude Code |
|---|---|
| `.agent.md` files (octopus, tech-lead, qa-lead, etc) | `agents/*.agent.md` (subagents nativos) |
| `respond_boss` tool + multi-dev registry | MCP Server (`copilot-delegate-boss`) |
| ACK hooks, report guard, disciplina | `hooks/hooks.json` (lifecycle hooks) |
| Brain research dispatcher | MCP Server (`copilot-delegate-brain`) |
| Brain source researchers | agents (subagents) + skills |
| Skills/disciplinas (multidev-lead-protocol, etc) | `skills/*/SKILL.md` |
| Party system (DSTP gates) | `skills/party-*/SKILL.md` |
| Shell router | `hooks/hooks.json` + MCP |
| Project discovery | MCP Server (`copilot-delegate-discovery`) |
| Scripts/hooks auxiliares | `hooks/*.js` + `bin/` |

---

## FASE 1 — Estrutura do Plugin + Port dos Agentes

### Estrutura de diretórios

```
copilot-delegate-plugin/
├── .claude-plugin/
│   └── plugin.json              # Manifesto do plugin
├── agents/                      # Subagent definitions
│   ├── octopus.agent.md         # Smart router (orquestrador principal)
│   ├── tech-lead.agent.md       # L2 Tech Lead
│   ├── product-lead.agent.md    # L2 Product Lead
│   ├── qa-lead.agent.md         # L2 QA Lead
│   ├── facilitator.agent.md     # L2 Facilitator
│   ├── implementor.agent.md     # L3 Dev implementador
│   ├── researcher.agent.md      # L3 Pesquisador
│   ├── reviewer.agent.md        # L3 Revisor
│   ├── debugger.agent.md        # L3 Debug
│   ├── documenter.agent.md      # L3 Documentação
│   ├── planner.agent.md         # L3 Planejador
│   ├── tester.agent.md          # L3 Testes
│   ├── validator.agent.md       # L3 Validador
│   └── profiles/                # Perfis de comportamento
│       ├── observe.agent.md
│       ├── alert.agent.md
│       ├── strike.agent.md
│       └── stealth.agent.md
├── skills/                      # Skills
│   ├── boss-discipline/
│   │   └── SKILL.md             # Disciplina do boss (nunca implementar)
│   ├── multidev-lead-protocol/
│   │   └── SKILL.md             # Protocolo de comunicação lead→boss
│   ├── brain-research-v2/
│   │   └── SKILL.md             # Instruções de pesquisa ativa
│   └── party-gates/
│       └── SKILL.md             # Validação DSTP
├── hooks/                       # Lifecycle hooks
│   ├── hooks.json               # Registro dos hooks
│   ├── multidev-ack.js          # ACK tracking hook
│   ├── boss-discipline.js       # Disciplina do boss
│   ├── multidev-report-guard.js # Valida relatório ao finalizar
│   ├── refine-mode-context.js   # Contexto de refine
│   ├── refine-mode-guard.js     # Guard de refine
│   ├── refine-research-enforcer.js # Pesquisa ao finalizar
│   ├── read-before-edit.js      # Hook de leitura antes de editar
│   ├── confirm-delegate.js      # Confirmação de delegação
│   ├── post-edit-lint.js        # Lint após edição
│   ├── contract-check.js        # Verificação de contratos
│   ├── octopus-discipline.js    # Disciplina do octopus
│   └── android-bridge-stop.js   # Stop hook Android
├── mcp/                         # MCP Servers
│   ├── boss-server/             # Boss system MCP server
│   │   ├── package.json
│   │   ├── index.js
│   │   └── ...
│   ├── brain-server/            # Brain research MCP server
│   │   ├── package.json
│   │   ├── index.js
│   │   └── ...
│   └── discovery-server/        # Project discovery MCP server
│       ├── package.json
│       ├── index.js
│       └── ...
├── sources.json                 # Registry de fontes do Brain
├── settings.json                # Default settings do plugin
└── README.md
```

### Plugin Manifest

```json
// .claude-plugin/plugin.json
{
  "name": "copilot-delegate",
  "description": "Multi-agent orchestration system with hierarchical delegation, active research, and party workflows",
  "version": "1.0.0",
  "author": { "name": "allansantos-dv" },
  "icon": "icon.png",
  "homepage": "https://github.com/AllanSantos-DV/copilot-delegate",
  "skills": {
    "brain-research-v2": { "description": "Active multi-source web research with consolidation" },
    "multidev-lead-protocol": { "description": "Boss→Lead communication protocol with ACK tracking" },
    "party-gates": { "description": "DSTP validation gates for party workflow" },
    "boss-discipline": { "description": "Hard rules for the octopus boss orchestrator" }
  }
}
```

### Port dos Agentes

Cada `.agent.md` existente em `resources/agents/` precisa ser adaptado de agente VS Code Copilot para subagent Claude Code:

| Mudança necessária | Copilot Chat | Claude Code |
|---|---|---|
| Tool sets | `tools: [search, read, edit, terminal]` | `tools: Search, Read, Edit, Bash` |
| Handoffs | `handoffs:` field | Não suportado nativamente (usa `@agent-name`) |
| Hooks frontmatter | `hooks:` em `.agent.md` | `hooks:` em `.agent.md` (suportado) |
| Mode | `mode: agent` | `permissionMode: auto` |
| Delegation | `delegate_child({ agent: "..." })` | `Agent(agent-name)` tool |
| Invocação | User-invocable + mode picker | `@agent-name` ou `claude --agent name` |

### Exemplo: octopus.agent.md convertido

```markdown
---
name: octopus
description: "Smart router — classifies requests and routes to the most efficient path. Orquestrador principal do sistema multi-agente."
model: sonnet
permissionMode: auto
tools: Agent, Search, Read, Bash
skills:
  - boss-discipline
  - multidev-lead-protocol
hooks:
  UserPromptSubmit:
    - type: command
      command: "node hooks/octopus-discipline.js"
  PreToolUse:
    - type: command
      command: "node hooks/read-before-edit.js"
    - type: command
      command: "node hooks/confirm-delegate.js"
  PostToolUse:
    - type: command
      command: "node hooks/post-edit-lint.js"
    - type: command
      command: "node hooks/contract-check.js"
  Stop:
    - type: command
      command: "node hooks/android-bridge-stop.js"
      timeout: 10
    - type: command
      command: "node hooks/refine-research-enforcer.js"
      timeout: 5
---
```

### Exemplo: implementor.agent.md convertido

```markdown
---
name: implementor
description: "Disciplined implementation agent. Plans before coding, reasons at decisions, verifies external facts. Full tool access."
tools: Search, Read, Edit, Bash, Glob, Grep
skills:
  - multidev-lead-protocol
---

# Implementor body (mesmo conteúdo do original)
```

### Hooks que precisam ser criados/adaptados

Os hooks atuais do projeto estão definidos nos `.agent.md` (referenciam `~/.copilot/hooks/`). Precisamos:
1. Recriar cada hook script em JS
2. Colocar em `hooks/` dentro do plugin
3. Referenciar como `node hooks/nome.js` (path relativo ao plugin)

Lista de hooks a criar:
- `hooks/multidev-ack.js` — ACK mecânico para mensagens [boss:task]
- `hooks/boss-discipline.js` — Impede o boss de implementar
- `hooks/multidev-report-guard.js` — Valida relatório no Stop
- `hooks/refine-mode-context.js` — Injeta contexto no UserPromptSubmit
- `hooks/refine-mode-guard.js` — Guard no PreToolUse
- `hooks/refine-research-enforcer.js` — Força pesquisa no Stop
- `hooks/read-before-edit.js` — Obriga ler antes de editar
- `hooks/confirm-delegate.js` — Confirma antes de delegar
- `hooks/post-edit-lint.js` — Roda lint após edição
- `hooks/contract-check.js` — Verifica contratos
- `hooks/octopus-discipline.js` — Disciplina do octopus
- `hooks/android-bridge-stop.js` — Stop hook Android

---

## FASE 2 — MCP Server: Boss System

### O que expor como MCP tools

O sistema Boss (multi-dev) que hoje são LM tools do VS Code precisa virar um MCP server standalone:

| LM Tool VS Code | MCP Tool |
|---|---|
| `delegate_task` | `boss_delegate_task` |
| `delegate_pipeline` | `boss_delegate_pipeline` |
| `multi_dev_spawn` | `boss_spawn_dev` |
| `respond_boss` | `boss_respond` |
| `multi_dev_send` | `boss_send` |
| `multi_dev_broadcast` | `boss_broadcast` |
| `multi_dev_list` | `boss_list_team` |
| `check_session` | `boss_check_session` |
| `wait_for_session` | `boss_wait_session` |
| `list_sessions` | `boss_list_sessions` |
| `cleanup_session` | `boss_cleanup_session` |
| `resume_session` | `boss_resume_session` |
| `switch_model` | `boss_switch_model` |

### Arquitetura

```
mcp/boss-server/
├── package.json
├── index.js              # Entry point (MCP server)
├── registry.js            # Multi-dev registry (file-based, não globalState)
├── spawner.js             # Spawn de sessões CLI
├── communicator.js        # Send/respond/broadcast
├── pipeline.js            # Pipeline orchestration
├── session-store.js       # Session persistence
└── utils/
    ├── logger.js
    ├── ids.js             # UUID generation
    └── workspace.js       # Workspace hash
```

### Desafios e Adaptações

| VS Code | Claude Code Plugin |
|---|---|
| `globalState` (Memento) | Arquivo JSON em `~/.copilot/delegate/registry.json` |
| `vscode.window.tabGroups.all` (achar chats) | Não existe — usa session IDs |
| `performSend` via chat API | Não disponível — usa comunicação via arquivos ou MCP |
| `focusAndInjectIntoChat` | Não aplicável (CLI) |
| Extension activation | MCP server roda como processo filho |

### .mcp.json

```json
{
  "boss-server": {
    "type": "stdio",
    "command": "node",
    "args": ["mcp/boss-server/index.js"]
  }
}
```

---

## FASE 3 — Hooks do Boss System

### Hook: multidev-ack.js

Função: Detecta mensagens `[boss:task]` no input do terminal e registra ACK automaticamente.

```javascript
#!/usr/bin/env node
'use strict';

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { rawInput += chunk; });
process.stdin.on('end', () => {
  let inputJson;
  try { inputJson = JSON.parse(rawInput); } catch (_) { process.exit(0); }

  // Verificar se é uma ferramenta Bash com mensagem do boss
  if (inputJson.tool_name !== 'Bash' && inputJson.tool_name !== 'run_in_terminal') {
    process.exit(0);
  }

  const cmd = (inputJson.tool_input && inputJson.tool_input.command) || '';
  if (!cmd) process.exit(0);

  // Detectar [boss:task] e extrair messageId
  const match = cmd.match(/\[boss:task\]/);
  if (!match) process.exit(0);

  // Extrair messageId do trailer <!-- multidev-ack-id: ... -->
  const idMatch = cmd.match(/<!-- multidev-ack-id:\s*([a-f0-9-]+)\s*-->/);
  const messageId = idMatch ? idMatch[1] : null;

  // Escrever ACK no arquivo de comunicação
  // ... lógica de ACK ...

  process.exit(0);
});
```

### hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node hooks/multidev-ack.js", "timeout": 5 },
          { "type": "command", "command": "node hooks/read-before-edit.js", "timeout": 5 },
          { "type": "command", "command": "node hooks/confirm-delegate.js", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "node hooks/post-edit-lint.js", "timeout": 15 }
        ]
      }
    ],
    "Stop": [
      { "type": "command", "command": "node hooks/multidev-report-guard.js", "timeout": 10 }
    ],
    "UserPromptSubmit": [
      { "type": "command", "command": "node hooks/octopus-discipline.js", "timeout": 5 },
      { "type": "command", "command": "node hooks/boss-discipline.js", "timeout": 5 }
    ]
  }
}
```

---

## FASE 4 — Brain Research como MCP + Skills

### Arquitetura

O Brain Research v2 atual é um pipeline de fan-out/fan-in que spawna source researchers
e um consolidador. No Claude Code, isso vira:

```
User → @octopus → MCP tool brain_research()
         ↓
  [brain-server MCP dispatcher]
         ↓
  ┌──────────────┬──────────────┬──────────────┐
  v              v              v              v
brave-researcher MDN-researcher github-researcher  ...

         ↓ (cada source researcher: subagent ou skill)
         ↓ (submete resultado via MCP tool brain_submit_source)

         ↓ dispatcher coleta
         ↓

  [consolidator agent: subagent que sintetiza]
         ↓
  Resultado final
```

### MCP Server: brain-server

```json
{
  "brain-server": {
    "type": "stdio",
    "command": "node",
    "args": ["mcp/brain-server/index.js"]
  }
}
```

Tools:
- `brain_research({ query, depth })` — Executa pipeline completo de pesquisa
- `brain_submit_source({ runId, sourceId, result })` — Source researcher submete resultado
- `brain_submit_consolidator({ runId, result })` — Consolidator submete síntese

### Skills

- `skills/brain-research-v2/SKILL.md` — Instruções para o pesquisador usar as MCP tools
- `skills/source-researcher/SKILL.md` — Playbook para cada fonte (MDN, npm, GitHub, etc)

### Fontes Suportadas (da v2)

```json
// sources.json (registro de fontes)
{
  "sources": {
    "github-code": { "enabled": true, "rank": 90 },
    "mdn": { "enabled": true, "rank": 85 },
    "npm-registry": { "enabled": true, "rank": 80 },
    "stackoverflow": { "enabled": true, "rank": 50 },
    "brave": { "enabled": true, "rank": 70 },
    "custom-url": { "enabled": true, "rank": 60 },
    "ddg-html": { "enabled": true, "rank": 65 },
    "workspace-files": { "enabled": true, "rank": 75, "private": true },
    "kb-local": { "enabled": true, "rank": 95, "private": true }
  }
}
```

---

## FASE 5 — Party System como Skills

O sistema DSTP (party) com suas validações vira skills e MCP tools:

| Componente | Formato |
|---|---|
| G1: Anti-vagueness | `skills/party-g1-anti-vagueness/SKILL.md` |
| G2: Zero-ambiguity | `skills/party-g2-zero-ambiguity/SKILL.md` |
| G3: Reality check | `skills/party-g3-reality-check/SKILL.md` |
| G4: AC Coverage | `skills/party-g4-ac-coverage/SKILL.md` |
| G5: Plan-AC Coverage | `skills/party-g5-plan-ac-coverage/SKILL.md` |
| G6: Semantic reality check | `skills/party-g6-semantic-check/SKILL.md` |
| Party template | MCP tool: `party_create_template()` |
| Party store/status | MCP tool: `party_get_status()`, `party_update_state()` |

---

## FASE 6 — Discovery + Shell Router

### Discovery como MCP

```json
{
  "discovery-server": {
    "type": "stdio",
    "command": "node",
    "args": ["mcp/discovery-server/index.js"]
  }
}
```

Tools:
- `discover_project({ workingDirectory, sources })` — Análise multi-fonte
- `discover_incremental({ workingDirectory })` — Incremental sobre cache anterior

### Shell Router como Hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/shell-router.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

O hook `shell-router.js` analisa o comando Bash e decide:
- Comandos de build/lint/test → permite
- Comandos perigosos (rm -rf, curl, wget) → bloqueia ou pede confirmação
- Git push/tag → pede confirmação

---

## FASE 7 — Teste e Distribuição

### Teste local

```bash
# Desenvolvimento
claude --plugin-dir ./copilot-delegate-plugin

# Com várias instâncias
claude --plugin-dir ./copilot-delegate-plugin --plugin-dir ./outro-plugin
```

### Testar cada componente

```bash
# Ver agentes
claude -p "/agents"

# Ver hooks
claude -p "/hooks"

# Ver MCP tools
claude -p "/mcp list"

# Testar skill
claude -p "/copilot-delegate:brain-research-v2 Como fazer X?"

# Testar agente como sessão principal
claude --agent octopus
```

### Distribuição

1. **Git repo** privado para o time
2. **Marketplace da comunidade** via `claude.ai/settings/plugins/submit`
3. **Marketplace próprio** (team) via `.claude-plugin/marketplace.json`

---

## Resumo das Fases

| Fase | O que | Depends on | Esforço |
|---|---|---|---|
| 1 | Plugin skeleton + agentes .md convertidos | — | M |
| 2 | MCP Boss Server (multi-dev registry, delegate_task, spawn, respond) | Fase 1 | G |
| 3 | Hooks (ACK, disciplina, report guard, lint) | Fase 1 | M |
| 4 | MCP Brain Server + research skills | Fases 1-2 | G |
| 5 | Party skills + MCP tools | Fase 1 | P |
| 6 | Discovery MCP + shell router hook | Fase 1 | M |
| 7 | Testes, ajustes, distribuição | Todas | P |

**Legenda:** P=pequeno, M=médio, G=grande

---

## Próximos Passos Imediatos

1. ✅ Revisar este plano
2. Criar estrutura de diretórios do plugin (Fase 1)
3. Criar `plugin.json`
4. Converter os `.agent.md` de `resources/agents/` para formato Claude Code
5. Escrever hooks JS
6. Criar MCP servers
7. Testar com `claude --plugin-dir`


