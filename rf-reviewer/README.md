# RF Reviewer — plugin Claude Code

Motor determinístico para **revisar entregáveis de Requisitos Funcionais (RF) em Excel**
do projeto La Positiva / InsureMO. Faz a **parte mecânica** (extrair a planilha, montar as
colunas de análise, **injetar de volta** na MESMA planilha do cliente, validar, versionar)
como um **MCP**; deixa para o agente **só o julgamento** (preencher a análise cruzando com a
memória do projeto — o servidor de conhecimento, `project_id=la-positiva`).

Plugin **irmão** do `claude-code-boss` no mesmo marketplace (`allansantos-plugins`), mas com
**escopo segregado**: aqui é conversão/anotação de Excel; lá é conhecimento de sessão.

## O que entrega
A **mesma planilha do cliente** + as colunas de análise anexadas (perfil escolhido),
versionada (`_revisado_fernando_vN.xlsx`). O original fica **100% intacto** (prova por
comparação célula a célula).

## Componentes
- **MCP `rf-engine`** (`servers/rf-engine/`, Python + openpyxl) — 9 tools:
  `rf_perfis_listar`, `rf_perfil_definir`, `rf_prep`, `rf_brain_buscar`, `rf_brain_enriquecer`,
  `rf_apply`, `rf_validar`, `rf_verificar_preservacao`, `rf_status`.
  Servido por **Streamable HTTP** a partir de um **daemon único** (`.mcp.json` `type:http`,
  `127.0.0.1:19847`) — as sessões conectam como clientes finos, **sem 1 processo por sessão**.
- **Skill `revisar-rf`** — dispara em tarefa de RF em Excel e conduz o fluxo pelas tools.
- **Agente `revisor-rf`** — persona/disciplina para operar o motor sem depender do agente
  principal.
- **Hooks de enforcement (determinístico)** — `hooks/`:
  - **SessionStart** (`servers/rf-engine/plugin_daemon.py`): sobe/garante o **daemon HTTP
    único** do `rf-engine` no início da sessão (idempotente; porta `127.0.0.1:19847`). É o que
    permite o transporte HTTP com daemon compartilhado, sem 1 processo por sessão.
  - `rf-remind.js` (UserPromptSubmit): quando o pedido é de RF em planilha, injeta no
    contexto o fluxo do RF Reviewer (rf_prep → … → rf_apply) — lembra sempre, não depende
    do modelo "lembrar".
  - `rf-guard.js` (PreToolUse/Bash): se o agente tentar mexer no `.xlsx` na mão
    (openpyxl/pandas gravando workbook), pede confirmação e redireciona para `rf_apply`.
    Não bloqueia leitura nem a CLI legítima do próprio motor.

## Requisitos
- **Python 3.11+** no PATH e **openpyxl** (`pip install openpyxl`). O servidor HTTP é stdlib
  (nenhuma dependência além do openpyxl). O daemon único sobe pelo hook **SessionStart**; o
  `.mcp.json` (`type:http`) só aponta a URL do daemon (`http://127.0.0.1:19847/mcp`).
- Requer um Claude Code que consuma servidor MCP **HTTP** no `.mcp.json` (`type:http`, o
  transporte remoto recomendado). Rollback para a versão stdio anterior:
  `/plugin install rf-reviewer@rf-v0.1.1`.

## Escopo (importante)
- **Serve:** arquivos **tabulares** — `.xlsx` (núcleo) e `.csv`. **Qualquer assunto** via
  perfil de colunas.
- **Não serve:** `.pdf` / `.docx` / `.pptx` (documentos) — outro fluxo (análise de
  documento). Injetar coluna só faz sentido em tabela.

## Fluxo
`rf_perfis_listar` → `rf_prep` → (agente preenche) → `rf_validar` → `rf_apply` →
`rf_verificar_preservacao`. Detalhe na skill `revisar-rf`.

## Mais
- **[INSTALL.md](./INSTALL.md)** — instalação, configuração do servidor de memória, uso e troubleshooting.
- **[PROFILES.md](./PROFILES.md)** — perfis de coluna (`rf-end`, `fernando-siniestros`) e como criar um novo.
- **[CHANGELOG.md](./CHANGELOG.md)** — histórico de versões.
