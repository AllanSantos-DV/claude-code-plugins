# Changelog

Todas as mudanças relevantes do **rf-reviewer** são documentadas aqui. O formato
segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); a versão vive
em `servers/rf-engine/rf_engine/__init__.py` (`__version__`).

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
em Excel do projeto La Positiva / InsureMO, distribuído como plugin irmão do
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
  MCP Memory (`project=la-positiva`) para embasar a análise.
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
