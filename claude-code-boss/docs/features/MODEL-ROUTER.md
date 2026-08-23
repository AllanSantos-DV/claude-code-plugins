# Model Router — Guia Completo (Usuario)

> Economize API e sobreviva ao rate-limit sem perder a sessao. Internos tecnicos: [servers/model-router/README.md](../../servers/model-router/README.md).

## Qual modo escolher?

```
Quer economizar dinheiro mantendo o Claude?        -> Sticky Router
Só quer não travar no 429?                         -> Fallback de limite
Tem endpoint próprio (OpenRouter, proxy, etc)?     -> BYOK
Usa modelos 1M e quer janela cheia + economia?     -> Router OFF + contextTuning
Nada acima?                                        -> Router OFF (default)
```

## Modos em Detalhe

### Sticky Router (RECOMENDADO)

- Classifica seu prompt UMA vez (primeiro turno — sem cache, custo zero) e FIXA o modelo da sessao.
- Modelo constante = prompt cache quente = cada turno custa ~0.1x do input.
- Nunca escala acima do modelo do dropdown (ceiling); so rebaixa p/ esticar a janela.
- No 429, aciona o plano B automaticamente.

### Fallback de Limite (429)

- Proxy em passthrough byte-idêntico: NAO classifica, NAO troca modelo, cache preservado.
- So intervem quando a Anthropic devolve 429. Cadeia completa do plano B: **BYOK endpoint (se mode on-limit) -> NVIDIA (se chave) -> mensagem orientando /dashboard**.
- Circuit breaker: le o reset exato dos headers/corpo da Anthropic; 429 de concorrencia (sem reset) nao arma cooldown falso.

### BYOK (Bring Your Own Key)

| Campo | O que colocar |
|-------|---------------|
| Base URL | So o host. Path sempre `/v1/messages`, formato Anthropic nativo |
| Headers | Um por linha (`Nome: valor`). Ex.: `Authorization: Bearer sk-...` |
| Quando usar | `on-limit` = so no 429 (Claude primeiro); `always` = endpoint atende tudo |

Seguranca: seu token da assinatura Claude NUNCA vai ao endpoint — so os headers configurados. Guardado local (0600), nunca commitado. Erro de config (401/404) aparece na hora (fail-loud), nao cai em silencio para a NVIDIA.

### contextTuning (sem proxy)

Grava `ENABLE_TOOL_SEARCH=true` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` no settings.json SEM publicar ANTHROPIC_BASE_URL. Ganho de token (~50k deferidos/request + teto de contexto ativo) mantendo a janela de 1M disponivel. Ideal para quem usa Opus/Sonnet 1M.

## Chave NVIDIA

Gratis em build.nvidia.com. Cole no dashboard. Por padrao ela serve SO para geracao no plano B (429). Classificacao remota (`classifyRemote`) e opt-in explicito de privacidade: envia ~500 chars/prompt para escolher tier.

## Botao "Desligar tudo"

O master-off na aba Router:
1. Zera os 4 toggles + contextTuning
2. Grava user-config atomicamente
3. Executa cleanup SINCRONO: remove ANTHROPIC_BASE_URL do settings.json, mata o daemon do proxy, libera a porta 13456, remove o shim Windows
4. Responde "ok" somente apos limpeza completa
5. Reinicie o Claude Code uma vez para voltar 100% direto

## Como saber se esta funcionando

- `/dashboard` -> Router: card hero mostra modo atual (verde sticky, azul fallback, roxo byok, cinza off)
- Dot verde pulsando = roteando agora
- Metricas: requests, downgrades, ceiling hits, economia estimada
- Log: `~/.claude/plugins/data/claude-code-boss/model-router/router.log` ou aba Logs (apos consolidacao de data-dirs, a pasta ativa pode ser um sibling `claude-code-boss*` — o dashboard Logs sempre mostra o certo)

## Aviso importante (janela 1M)

Com QUALQUER proxy no caminho (ANTHROPIC_BASE_URL custom), o cliente Claude Code orca a sessao em 200K mesmo em modelos 1M — limitacao do cliente atras de gateway, documentada pela Anthropic. Precisa de 1M? Deixe o router em OFF e use contextTuning (o ganho de token vem do env, nao do proxy).

## Cobranca: assinatura vs API

O router nasce desativado por padrao; ligar e opt-in por conta e risco. Passthrough/sticky na rota Anthropic preserva a assinatura (repassamos `anthropic-beta` + credencial intactos); a rota BYOK e o fallback NVIDIA cobram o endpoint; `ANTHROPIC_API_KEY` no ambiente vira API pay-as-you-go. Tabela completa de cenarios, auditoria e fontes oficiais: [ROUTER-BILLING.md](./ROUTER-BILLING.md).
