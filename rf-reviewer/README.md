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
- **Skill `revisar-rf`** — dispara em tarefa de RF em Excel e conduz o fluxo pelas tools.
- **Agente `revisor-rf`** — persona/disciplina para operar o motor sem depender do agente
  principal.

## Requisitos
- **Python 3.11+** no PATH e **openpyxl** (`pip install openpyxl`). O `.mcp.json` aponta o
  `PYTHONPATH` para `servers/rf-engine`; o interpretador global fornece o openpyxl.

## Escopo (importante)
- **Serve:** arquivos **tabulares** — `.xlsx` (núcleo) e `.csv`. **Qualquer assunto** via
  perfil de colunas.
- **Não serve:** `.pdf` / `.docx` / `.pptx` (documentos) — outro fluxo (análise de
  documento). Injetar coluna só faz sentido em tabela.

## Fluxo
`rf_perfis_listar` → `rf_prep` → (agente preenche) → `rf_validar` → `rf_apply` →
`rf_verificar_preservacao`. Detalhe na skill `revisar-rf`.
