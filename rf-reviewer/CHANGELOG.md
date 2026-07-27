# Changelog

Todas as mudanças relevantes do **rf-reviewer** são documentadas aqui. O formato
segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); a versão vive
em `servers/rf-engine/rf_engine/__init__.py` (`__version__`).

## [0.2.4] - 2026-07-24

### Added — auto-reinício do daemon quando o plugin atualiza

- `ensure_daemon` agora compara a versão do daemon vivo (via `/health`) com a do código
  instalado: se estiver **obsoleta** (após um update do plugin), encerra o daemon antigo e
  sobe o novo **automaticamente** — o update passa a valer sem reinício manual da máquina.
  Antes, um daemon já em memória continuava servindo o código velho até o usuário reiniciar.
- **Fail-loud:** se o daemon obsoleto não puder ser encerrado (sem pid, sem permissão ou
  porta que não libera), o erro sobe explícito — nunca se segue servindo código velho como
  se estivesse tudo certo. Rede de segurança contra `EADDRINUSE` transitório no religamento.

## [0.2.3] - 2026-07-24

### Changed — perfis custom num lar GLOBAL, fora do plugin (à prova de update)

- Os perfis registrados via `rf_perfil_definir` agora persistem em
  `~/.rf-engine/profiles_custom.json` — no diretório **global por-usuário** (junto do
  token/lock do daemon), **fora da pasta do plugin**. Antes ficavam dentro do código do
  plugin e se perdiam a cada atualização. Novo módulo `rf_engine.paths` centraliza esse
  "lar único"; `http_transport` reutiliza a mesma fonte (sem duplicação).
- **Migração automática (one-shot):** no primeiro boot após o update, se existir um
  `profiles_custom.json` antigo dentro do plugin, ele é movido para o lar global (com log
  no stderr). Fail-loud: erro de I/O na migração propaga — nunca é mascarado.

## [0.2.2] - 2026-07-24

### Changed — remoção do último resíduo de plataforma de cliente

- Removida a última referência a plataforma de cliente do motor: a detecção da coluna
  de plataforma passa a ser genérica (`plataforma`/`platform`/`compatib`) e a variável
  interna foi renomeada. O plugin agora é **100% agnóstico de cliente** — zero nome de
  cliente/plataforma em código, docs ou página.

## [0.2.1] - 2026-07-24

### Changed — plugin 100% agnóstico de cliente

- **Removidos todos os dados de cliente** do plugin (código, docs e página): o motor
  e os exemplos ficam genéricos. A configuração específica de cada cliente (perfil de
  colunas, cabeçalho do Resumo, `project_id` da memória) é registrada por quem usa
  (via `rf_perfil_definir` e parâmetros), nunca embutida no plugin.
- **Saída genérica:** o Resumo Executivo não injeta mais nome de cliente; o sufixo do
  arquivo revisado passa a ser `_revisado_vN.xlsx`.
- **Perfis embutidos:** só o `rf-end` (genérico) vem de fábrica; perfis específicos de
  cliente são registrados em runtime (`rf_perfil_definir`).
- **`project_id` sem default de cliente:** as tools de memória (`rf_brain_*`) usam o
  `project_id` que você passar.

### Fixed — página do plugin

- **Versão determinística:** a versão exibida nas páginas vem do `plugin.json`
  (`.github/scripts/version-stamp.mjs`) — não é mais hardcoded na mão.
- **Layout:** corrigido texto que vazava das células/caixas (overflow) e o acento
  lateral grosso de card.

## [0.2.0] - 2026-07-24

### Changed — transporte MCP: stdio → Streamable HTTP (daemon único)

- **BREAKING (transporte):** o `rf-engine` deixa de rodar como servidor **stdio**
  (1 processo Python por sessão) e passa a servir MCP por **Streamable HTTP** a
  partir de um **daemon único compartilhado**. As sessões do Claude Code conectam
  como clientes HTTP finos (`.mcp.json` `type:http`), **sem 1 processo por sessão**.
  O contrato das **9 tools** (nomes/inputs/outputs) é **idêntico** — só o transporte
  mudou; nenhuma mudança no fluxo de revisão.
- **Ganho de memória medido:** 8 sessões saíam de ~489 MB (8 processos stdio) para
  ~87 MB (1 daemon) — **−403 MB (~82%)**, 7 processos a menos.
- **Ciclo de vida:** um hook **SessionStart** sobe/garante o daemon (idempotente,
  porta fixa `127.0.0.1:19847`); o Claude reconecta sozinho (backoff) se o daemon cair.
- **Segurança:** loopback (`127.0.0.1`) + validação de `Origin` (anti DNS-rebinding);
  token é opt-in via `RF_ENGINE_HTTP_TOKEN`.
- **Sem dependência nova:** o servidor HTTP é `http.server` da stdlib; segue só `openpyxl`.
- **Rollback:** fixe a versão anterior com `/plugin install rf-reviewer@rf-v0.1.1`.

### Added

- `servers/rf-engine/rf_engine/http_transport.py` (daemon HTTP), `ensure_daemon.py`
  (supervisor idempotente), `dispatch.py` (núcleo JSON-RPC agnóstico de transporte) e
  `servers/rf-engine/plugin_daemon.py` (launcher chamado pelo hook SessionStart).
  `mcp_server.py` vira entry-point fino que delega ao daemon HTTP.

## [0.1.1] - 2026-07-12

### Fixed

- **`rf_validar` não varre mais dado ORIGINAL do cliente ao checar termos
  proibidos/erros de fórmula** — `validate_xlsx` escaneava o workbook inteiro;
  um requisito de negócio legítimo (ex.: "el sistema debe usar inteligencia
  artificial...") ou uma fórmula quebrada preexistente no arquivo do cliente
  podia reprovar o gate por algo fora do escopo da tool e que o princípio
  não-destrutivo proíbe corrigir. Agora a varredura fica restrita às colunas
  que a própria tool anexou + às abas geradas (Resumo/Leyenda) — nunca aos
  dados originais do cliente. Validado com teste funcional (apply real +
  validate) confirmando ambos os lados: termo original ignorado, termo em
  coluna nova continua detectado.
- Removido código morto em `formatting.py` (`copy_sheet_full`,
  `scrub_workbook`) — nenhum dos dois era chamado; `apply.py` usa uma
  estratégia mais simples e segura (abre o workbook original e só ANEXA
  colunas, nunca recria células), então a rotina de cópia célula-a-célula
  nunca foi necessária. O docstring do módulo foi corrigido para refletir o
  que de fato acontece.

## [0.1.0] - 2026-07-10

Release inicial — motor determinístico de revisão de Requisitos Funcionais (RF)
em Excel para projetos com entregáveis tabulares, distribuído como plugin irmão do
`claude-code-boss` no marketplace `allansantos-plugins`.

### Added — motor `rf-engine` (MCP, Python + openpyxl)

- **9 tools** que fazem a parte mecânica e deixam ao agente só o julgamento:
  `rf_perfis_listar`, `rf_perfil_definir`, `rf_prep`, `rf_brain_buscar`,
  `rf_brain_enriquecer`, `rf_apply`, `rf_validar`, `rf_verificar_preservacao`,
  `rf_status`.
- **Fluxo não-destrutivo**: extrai a planilha do cliente, monta as colunas de
  análise do perfil escolhido e **injeta de volta na MESMA planilha**, gerando
  uma versão (`_revisado_..._vN.xlsx`) com o original **100% preservado** — prova
  por comparação célula a célula (`rf_verificar_preservacao`).
- **Perfis de coluna por assunto** (trocáveis): o mesmo motor serve qualquer
  assunto tabular; assunto novo = novo perfil via `rf_perfil_definir`.
- **Referência cruzada com a memória** (`rf_brain_*`): consulta um servidor
  MCP Memory (`project=<seu-projeto>`) para embasar a análise.
- **Escopo explícito**: arquivos tabulares (`.xlsx` núcleo, `.csv`). Documentos
  (`.pdf`/`.docx`/`.pptx`) ficam fora — injetar coluna só faz sentido em tabela.

### Added — skill + agente

- **Skill `revisar-rf`** — dispara em tarefas de RF em Excel e conduz o fluxo
  pelas tools na ordem correta.
- **Agente `revisor-rf`** — persona/disciplina tool-first para operar o motor sem
  depender do agente principal.

### Added — hooks de enforcement determinístico

- **`rf-remind.js`** (UserPromptSubmit) — quando o pedido é de RF em planilha,
  injeta o fluxo do RF Reviewer no contexto; não depende do modelo "lembrar".
- **`rf-guard.js`** (PreToolUse/Bash) — se o agente tentar gravar o `.xlsx` na mão
  (openpyxl/pandas), pede confirmação e redireciona para `rf_apply`. Não bloqueia
  leitura nem a CLI legítima do próprio motor.

### Docs

- `README.md` — visão geral, componentes, escopo e fluxo.
- `INSTALL.md` — instalação via marketplace, configuração do servidor de memória,
  uso passo a passo, perfis, verificação fora do Claude Code e troubleshooting.
