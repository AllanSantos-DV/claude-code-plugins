---
description: Abre o dashboard de configuração do plugin (Brain, Hooks, Router) e mostra a URL local.
argument-hint: "(sem argumentos)"
---

Abra o dashboard local de configuração do plugin para o usuário. Siga estes passos:

1. **Garanta que o dashboard está no ar** rodando o starter idempotente (ele não
   sobe um segundo processo se já estiver rodando):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-start.js"
   ```

   Em Windows, prefira a ferramenta de PowerShell; em macOS/Linux, o shell padrão.

2. **Descubra a porta e o token** lendo o arquivo de descoberta que o dashboard
   escreve ao subir. O caminho usa o diretório de dados do plugin:

   ```
   ${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/claude-code-boss}/.runtime/dashboard.json
   ```

   No Windows, o equivalente é `%USERPROFILE%\.claude\plugins\data\claude-code-boss\.runtime\dashboard.json`.
   O arquivo é um JSON com `{ "port", "token", "startTime", "pid" }`. Se ele ainda
   não existir, aguarde 1–2 segundos e tente de novo (o servidor acabou de subir).

3. **Apresente ao usuário** uma URL clicável `http://localhost:<port>` (use o
   `port` lido no passo 2). Não exponha o token — ele é injetado automaticamente
   na página servida.

4. **Mencione a aba Router**: explique que, além de Brain KB, Hooks, Skills,
   Insights e Logs, há a aba **Router**, onde o usuário pode ativar a reescrita de
   modelo, informar uma chave NVIDIA grátis (opcional, fica só na máquina) e
   aplicar a configuração. Lembre que, ao aplicar, é preciso reiniciar o Claude
   Code para o roteamento entrar em vigor.

Comunique-se no idioma preferido do usuário (padrão pt-BR).
