---
description: Abre o dashboard de configuração do plugin (Brain, Hooks, Router) e mostra a URL local.
argument-hint: "(sem argumentos)"
---

<!-- Normalmente este texto NUNCA chega ao modelo: o hook UserPromptExpansion
     (scripts/dashboard-command.js) sobe o dashboard, abre o navegador e bloqueia a
     expansão mostrando a URL — sem LLM. Os passos abaixo só valem se os hooks do
     plugin estiverem desligados. -->

Abra o dashboard local de configuração do plugin para o usuário. Siga estes passos:

1. **Garanta que o dashboard está no ar** rodando o starter idempotente (ele não
   sobe um segundo processo se já estiver rodando e só responde quando a porta
   atende de verdade):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-start.js"
   ```

   Ele imprime uma linha JSON: `{"ok":true,"status":"started|already-running","url":"http://localhost:<port>",…}`
   ou `{"ok":false,"error":"…"}`.

2. **Apresente ao usuário** a `url` como link clicável. Se `ok` for `false`, mostre o
   `error` tal como veio. Não procure arquivos de descoberta nem exponha o token — ele
   é injetado automaticamente na página servida.

3. **Mencione a aba Router**: explique que, além de Brain KB, Hooks, Skills,
   Insights e Logs, há a aba **Router**, onde o usuário pode ativar a reescrita de
   modelo, informar uma chave NVIDIA grátis (opcional, fica só na máquina) e
   aplicar a configuração. Lembre que, ao aplicar, é preciso reiniciar o Claude
   Code para o roteamento entrar em vigor.

Comunique-se no idioma preferido do usuário (padrão pt-BR).
