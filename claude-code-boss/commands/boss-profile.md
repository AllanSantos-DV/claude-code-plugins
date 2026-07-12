---
description: Troca o perfil de hooks do claude-code-boss (dev | standard | free) de forma que sobrevive a updates.
argument-hint: "[dev|standard|free]  (vazio = mostra o atual)"
---

O usuário quer ver ou trocar o **perfil de hooks** do plugin claude-code-boss.
O argumento é: `$ARGUMENTS`

Os três perfis:
- **dev** — tudo ligado: constrói a KB e enforça (a curadoria escala até 3x). Para quem desenvolve/estende o plugin.
- **standard** — silencioso (padrão de fábrica): só a curadoria dá **1 aviso soft**; os nudges de dev e os blockers extras do Stop (refine-research, failure-retro, research-followup, auto-continue) ficam desligados.
- **free** — passa tudo: **nenhum bloqueio** no Stop. O retrieval de contexto no início do turno continua (é read-only e barato).

Faça:

1. Rode o script (ele grava em `DATA_DIR/hooks/user-config.json`, então **sobrevive a updates** — nunca edite o arquivo shipped):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/profile-set.js" $ARGUMENTS
   ```

   Em Windows, use a ferramenta de PowerShell.

2. Se `$ARGUMENTS` estiver vazio, o script apenas mostra o perfil atual e as opções — repasse isso ao usuário e pergunte se ele quer trocar.

3. Se um perfil foi definido, confirme ao usuário o novo perfil e resuma em uma frase o que muda (use a saída "Efeito" do script). Lembre que a troca vale a partir do **próximo turno** (os hooks releem a config a cada disparo; não precisa reiniciar o Claude Code).

Comunique-se no idioma preferido do usuário (padrão pt-BR).
