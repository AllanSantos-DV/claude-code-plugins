# RF Reviewer — Instalação e Integração

Guia de **instalação, integração e uso** do plugin **rf-reviewer** (revisão de Requisitos
Funcionais em Excel — La Positiva / InsureMO). Faz par com o `README.md` (visão geral) e a
skill `revisar-rf` (fluxo detalhado).

---

## 1. Pré-requisitos

- **Claude Code** com o marketplace **`allansantos-plugins`** conhecido (já vem do
  `claude-code-boss`).
- **Python 3.11+** no PATH. A dependência **openpyxl** é **auto-instalada** pelo MCP na 1ª
  execução (não precisa instalar à mão). Se quiser adiantar: `python -m pip install openpyxl`.
- **Servidor de memória** (MCP Memory) acessível para o passo de referência cruzada
  (`project_id=la-positiva`). Ex.: `http://192.168.18.13:38080` na LAN.

## 2. Instalar / atualizar (via marketplace)

O plugin é distribuído pelo mesmo repositório do `claude-code-boss`
(`AllanSantos-DV/claude-code-plugins`), como **plugin irmão** (escopo segregado).

**Atualizar o clone do marketplace** na máquina (mesmo mecanismo do claude-code-boss):

```powershell
$mk = "$env:USERPROFILE\.claude\plugins\marketplaces\allansantos-plugins"
git -C $mk fetch origin
git -C $mk reset --hard origin/main
```

**Ativar no Claude Code** (por máquina, uma vez):

1. Abra o Claude Code.
2. Rode **`/plugin`**.
3. No marketplace **`allansantos-plugins`**, dê **refresh** (para enxergar o plugin novo).
4. Selecione **“RF Reviewer — Revisão de Requisitos em Excel”** e **Instalar/Ativar**.

O Claude Code registra o plugin, popula o cache e sobe o MCP `rf-engine` automaticamente. A
skill `revisar-rf`, o agente `revisor-rf` e os hooks passam a valer na sessão.

> O `claude-code-boss` **não é afetado** — rf-reviewer é aditivo.

## 3. O que o plugin entrega

- **MCP `rf-engine`** — 9 tools: `rf_perfis_listar`, `rf_perfil_definir`, `rf_prep`,
  `rf_brain_buscar`, `rf_brain_enriquecer`, `rf_apply`, `rf_validar`,
  `rf_verificar_preservacao`, `rf_status`.
- **Skill `revisar-rf`** — conduz o fluxo pelas tools.
- **Agente `revisor-rf`** — persona/disciplina (tool-first).
- **Hooks de enforcement determinístico** (`hooks/`):
  - `rf-remind.js` (UserPromptSubmit) — lembra o fluxo quando o pedido é RF em planilha.
  - `rf-guard.js` (PreToolUse/Bash) — pede confirmação se tentarem editar o `.xlsx` na mão,
    redirecionando para `rf_apply`.

## 4. Configuração do servidor de memória

As tools `rf_brain_*` recebem `url` e `project`. Use o servidor da equipe e o projeto:

```
url = http://192.168.18.13:38080     (ajuste ao endereço acessível na sua rede)
project = la-positiva
```

## 5. Uso (fluxo mínimo)

1. `rf_perfis_listar` → escolha o perfil (ex.: `fernando-siniestros` ou `rf-end`).
2. `rf_prep { xlsx, out_dir, perfil }` → gera o `analysis_json` (esqueleto).
3. (opcional) `rf_brain_enriquecer { analysis_json, url, project }` → evidências do cérebro.
4. **Preencher** as `schema_keys` + `gaps` cruzando com a memória (nada vem do arquivo base).
5. `rf_validar` → corrigir até `aprovado=true`.
6. `rf_apply { extract_json, analysis_json, out_dir, perfil }` → injeta na MESMA planilha.
7. `rf_verificar_preservacao { base_xlsx, out_xlsx }` → veredito `MECANICO E NAO-DESTRUTIVO`.

## 6. Escopo

- **Serve:** planilhas **`.xlsx` / `.csv`** (qualquer assunto — troque o perfil).
- **Não serve:** `.pdf` / `.docx` / `.pptx` (documentos) → outro fluxo (análise de documento).

## 7. Perfis por assunto

`rf_perfis_listar` mostra os disponíveis. Assunto novo com colunas diferentes → crie com
`rf_perfil_definir` (uma vez); a mecânica é a mesma, só muda o molde de colunas. Referência
completa dos perfis embutidos e das colunas/chaves: **[PROFILES.md](./PROFILES.md)**.

## 8. Verificação rápida (opcional, fora do Claude Code)

```powershell
$env:PYTHONPATH = "$env:USERPROFILE\.claude\plugins\cache\allansantos-plugins\rf-reviewer\servers\rf-engine"
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python -m rf_engine.mcp_server
```

Deve responder com `serverInfo` e listar as 9 tools.

## 9. Solução de problemas

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| “openpyxl não encontrado” | 1ª execução ainda instalando | Aguarde; ou `python -m pip install openpyxl` |
| RF Reviewer não aparece no `/plugin` | catálogo em cache | Refresh do marketplace; confirme `git -C <mk> log -1` = último commit |
| `rf_brain_*` sem resultado | url/projeto errados ou servidor fora | Verifique `url`/`project=la-positiva` e o health do servidor |
| Recall vazio numa pasta | falta o marcador de projeto | Garanta `.claude-boss-project=la-positiva` na pasta de trabalho |
