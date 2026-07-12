# Claude Code Plugins

Monorepo de plugins para [Claude Code Desktop](https://claude.ai/download) — desenvolvido por **Allan Santos**.

## Plugins

| Plugin | Versão | O que faz |
| --- | --- | --- |
| [**claude-code-boss**](./claude-code-boss) | 1.28.0 | Brain KB (busca semântica local), execução curada anti context-bloat e aprendizado in-loop. Opcionalmente conecta a um servidor **MCP Memory** externo. |
| [**rf-reviewer**](./rf-reviewer) | 0.1.0 | Motor determinístico que revisa Requisitos Funcionais em Excel: extrai a planilha, o agente analisa cruzando com a memória, e injeta a análise de volta na **mesma** planilha — mecânico e não-destrutivo. |

Cada plugin é independente e vive na sua própria subpasta; instale só o que precisar.

## claude-code-boss

Foco no que o Claude Code nativo **não** entrega. A orquestração fica com as ferramentas nativas (Agent/Workflow); o boss agrega memória, curadoria e aprendizado:

- **Brain KB** — base local (SQLite + embeddings via Transformers.js/Ollama/Voyage), indexação automática de outputs relevantes, recuperação híbrida (vetor + keyword) com rerank por decay, e servidor MCP com as tools de KB e web research.
- **Backend MCP Memory (opt-in)** — em vez do SQLite local, aponte o Brain para um servidor **mcp-memory** externo (seu ou da equipe) pelo dashboard. Ativação **por-usuário** (sobrevive a auto-update), com **ingestão opcional** da conversa para curadoria server-side.
- **Identidade de projeto portável** — o recall é escopado por um `projectId` estável: `CCB_PROJECT_ID` → arquivo `.claude-boss-project` na pasta → nome da pasta. Casa a memória entre máquinas/clones em vez de depender do nome do diretório.
- **Aprendizado in-loop** — tool `capture_lesson` com admission control (mescla duplicatas, incrementa recorrência) e promoção de lições recorrentes a skills.
- **Execução curada + hooks advisory** — bloqueia/redireciona comandos curados, detecta outputs grandes, e injeta contexto de forma informativa (não coercitiva), com backpressure para evitar bloat.
- **Dashboard local** — SPA em `localhost` (token auth), abas Home / Brain KB / Hooks / Logs, lançado sob demanda.

Detalhes, providers de embedding e configuração: **[claude-code-boss/README.md](./claude-code-boss/README.md)** · histórico em **[CHANGELOG.md](./claude-code-boss/CHANGELOG.md)**.

## rf-reviewer

Revisão determinística de **Requisitos Funcionais em Excel** (La Positiva / InsureMO). Faz a parte mecânica como um MCP (`rf-engine`, Python + openpyxl) e deixa para o agente **só o julgamento**:

- **9 tools** (`rf_prep`, `rf_validar`, `rf_apply`, `rf_verificar_preservacao`, `rf_brain_*`, perfis…) que extraem a planilha, injetam as colunas de análise de volta na **mesma** planilha do cliente e provam a preservação célula a célula (original 100% intacto, versionado).
- **Skill `revisar-rf` + agente `revisor-rf`** conduzem o fluxo; **hooks de enforcement** (`rf-remind`, `rf-guard`) garantem o caminho mecânico e evitam edição manual do `.xlsx`.
- **Escopo:** arquivos tabulares (`.xlsx`/`.csv`), qualquer assunto via perfil de colunas. Documentos (`pdf`/`docx`/`pptx`) seguem outro fluxo.

Visão geral: **[rf-reviewer/README.md](./rf-reviewer/README.md)** · instalação e uso: **[rf-reviewer/INSTALL.md](./rf-reviewer/INSTALL.md)**.

## Estrutura

```text
claude-code-plugins/
├── .claude-plugin/
│   └── marketplace.json       # Catálogo do marketplace (allansantos-plugins)
├── claude-code-boss/          # Plugin: Brain KB + curadoria + aprendizado
│   ├── .claude-plugin/        # plugin.json
│   ├── .mcp.json              # MCP: brain-server
│   ├── config/                # brain-config.json, hooks-config.json
│   ├── dashboard/             # SPA (Home / Brain / Hooks / Logs)
│   ├── hooks/                 # hooks.json (5 eventos)
│   ├── scripts/               # hooks + CLI + Brain + Dashboard (Node.js)
│   ├── servers/brain-server/  # MCP server (Node.js ESM)
│   ├── skills/                # skills do Claude Code
│   └── CHANGELOG.md
├── rf-reviewer/               # Plugin: revisão de RF em Excel
│   ├── .claude-plugin/        # plugin.json
│   ├── .mcp.json              # MCP: rf-engine (Python)
│   ├── agents/ · skills/      # revisor-rf · revisar-rf
│   ├── hooks/                 # rf-remind, rf-guard (enforcement)
│   ├── servers/rf-engine/     # MCP server (Python + openpyxl)
│   └── INSTALL.md
├── pages/                     # Landing page de cada plugin (pages/<plugin>/index.html)
└── .github/
    ├── workflows/             # ci.yml · release.yml · pages-guard.yml
    ├── scripts/               # pages-guard.mjs (guard determinístico, zero cota)
    └── agents/                # vitrine.agent.md (redesenha as páginas)
```

## Instalação (via marketplace)

> Requer **Claude Code Desktop**. **Node.js 22.13+ precisa estar no `PATH` do sistema** — o Claude Code dispara hooks e MCP servers com o `node` do PATH, não pelo Node embutido no Desktop ([claude-code#66183](https://github.com/anthropics/claude-code/issues/66183)). Sem Node no PATH, os hooks viram no-op e o MCP fica DOWN (`spawn node ENOENT`). No Windows: instale o MSI oficial e reabra o Claude Code por completo. O `rf-reviewer` também exige **Python 3.11+** no PATH.

No Claude Code, adicione o marketplace uma vez e instale os plugins que quiser:

```text
/plugin marketplace add AllanSantos-DV/claude-code-plugins
/plugin install claude-code-boss@allansantos-plugins
/plugin install rf-reviewer@allansantos-plugins
```

Depois de instalar o `claude-code-boss`, rode `npm install` na pasta dele (dependências do Node) — ou deixe o `postinstall` cuidar disso. Configuração detalhada (providers de embedding, backend MCP Memory, dashboard) em **[claude-code-boss/README.md](./claude-code-boss/README.md)**; setup do rf-reviewer em **[rf-reviewer/INSTALL.md](./rf-reviewer/INSTALL.md)**.

## Páginas dos plugins

Cada plugin tem uma landing page autocontida em `pages/<plugin>/index.html`
([claude-code-boss](./pages/claude-code-boss/index.html) ·
[rf-reviewer](./pages/rf-reviewer/index.html)). Um guard determinístico
(`.github/scripts/pages-guard.mjs`, sem IA, sem cota) garante que a página
acompanhe as fontes do plugin: o CI (`pages-guard.yml`) bloqueia merge com página
desatualizada, e o mesmo check roda como git hook local — ative uma vez por clone
com `git config core.hooksPath .githooks`. Quem redesenha as páginas é o agente
[`vitrine`](./.github/agents/vitrine.agent.md). Detalhes em [AGENTS.md](./AGENTS.md).

## Licença

[MIT](./LICENSE)
