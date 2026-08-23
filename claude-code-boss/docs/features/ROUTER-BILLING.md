# Model Router & Cobrança — assinatura vs API

> Quando o uso continua na sua assinatura Claude e quando pode virar cobrança de API. Fontes oficiais citadas.

## Resumo em 30 segundos

O router vem **desativado por padrão**. Ligar qualquer modo coloca um proxy local (`127.0.0.1:13456`) no caminho entre o Claude Code e a Anthropic. Segundo a documentação oficial, um proxy com **apenas** `ANTHROPIC_BASE_URL` **preserva a cobrança da sua assinatura** — desde que os headers de OAuth cheguem intactos ao upstream (o nosso repassa; ver tabela abaixo). Os cenários que REALMENTE viram cobrança de API são outros — e estão listados aqui.

## Tabela de cenários

| Cenário | Cobrança | Por quê |
|---------|----------|---------|
| Router OFF (default) | ✅ Assinatura | Conexão direta, sem proxy |
| Router ON, passthrough/sticky/fallback → Anthropic | ✅ Assinatura* | Doc oficial: *"setting only ANTHROPIC_BASE_URL... a saved claude.ai login stays the active credential"* |
| Rota BYOK (on-limit ou always) | ❌ **Endpoint do usuário** | O router remove a credencial da assinatura e envia só seus headers configurados (`byok.js:120-127`) — é o propósito do BYOK |
| Fallback NVIDIA (429) | ❌ NVIDIA (grátis/conta própria) | Request vai à NVIDIA, não à Anthropic |
| `ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN` no ambiente | ❌ **API pay-as-you-go** | Env vence a assinatura — causa nº 1 de cobrança inesperada ([Help Center](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code)) |
| Bug silencioso upstream (#65227) | ⚠️ Pode virar API após update/re-auth | Reportado pela comunidade; re-login restaura. Não é causado pelo proxy |

\* *Condição oficial: o gateway deve repassar a OAuth capability no header `anthropic-beta`. Nosso router repassa `anthropic-beta`, `authorization` e `x-api-key` intactos na rota Anthropic (`servers/model-router/byok.js:118,129-131`).*

## Como auditar SUA cobrança hoje

1. **Anthropic Console → Usage**: se sessões interativas aparecem lá, algo está billando API — sob assinatura elas NÃO aparecem
2. `/status` dentro do Claude Code: confira o método de autenticação ativo
3. Ambiente: `Get-ChildItem Env: | Where-Object Name -like "ANTHROPIC*"` — nenhuma `*_API_KEY`/`AUTH_TOKEN` deve existir se você quer assinatura
4. Spend limit no Console como rede de segurança (o bug #65227 só foi notado porque havia limit)

## Checklist para ficar na assinatura com o router ligado

```
[ ] Sem ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN no env do usuário/sistema
[ ] byok.enabled = false (ou mode on-limit sem endpoint configurado)
[ ] /status mostra login de assinatura ativo
[ ] API Usage dashboard não mostra sessões interativas
[ ] Após updates/re-auth do CC: reconfira 1-3 (bug #65227 é silencioso)
```

## Por que o router é opt-in

Mesmo preservando assinatura nos caminhos Anthropic, o proxy adiciona uma superfície (daemon na porta fixa, shim no Windows) e o ganho de custo depende do seu mix de tarefas. Por isso ele nasce desligado: ligue se quiser sticky-routing/fallback/BYOK — por conta e risco, com restart do Claude Code para aplicar.

## Fontes oficiais

- [Gateways — code.claude.com](https://code.claude.com/docs/en/gateways): *"The exception is setting only ANTHROPIC_BASE_URL, with no gateway credential... subscription's usage limits and billing apply"*
- [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway): exigência de forward da OAuth capability em `anthropic-beta`
- [Managing API key environment variables](https://support.claude.com/en/articles/12304248): env key vence a assinatura
- [anthropics/claude-code#65227](https://github.com/anthropics/claude-code/issues/65227): troca silenciosa pós-update/re-auth
