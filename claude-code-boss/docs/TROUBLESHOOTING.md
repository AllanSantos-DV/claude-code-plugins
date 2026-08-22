# Troubleshooting

> Sintoma → causa → solução. Ordenado por frequência.

## Instalação / Boot

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Hooks não disparam | CC não recarregou o plugin | Reinicie o Claude Code **completamente**; após update de versão use `/reload-plugins` |
| Node não encontrado pelo hook | Node fora do PATH do sistema | Instale Node 22.13+ no PATH de máquina (não só do terminal) e reinicie |
| `install-local.mjs` falha com working tree sujo | Script se recusa com mudanças não commitadas | `--dirty` para override, ou commit antes |
| Embedding baixando na 1ª execução | Warm do MiniLM (~100-200MB) | Normal, uma vez só. CI: `CLAUDE_SKIP_EMBED_WARM=1` |
| Duas pastas `claude-code-boss*` em plugins/data | Fragmentação de data-dir | `node scripts/consolidate-datadirs.js --apply` |

## Brain KB

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Busca não acha lições óbvias | `minScoreFast` shipped é 0.50 (calibrado p/ multilingual); ou embedder quebrado | Baixe o score no dashboard; `Test / Install` no embedder |
| Lições "somem" ao trocar de pasta/máquina | projectId resolveu diferente | Fixe via `.memory/project.json` (commitado) ou env `CCB_PROJECT_ID` |
| Erro "Could not resolve project_id" | Fail-loud: pasta não-git sem nenhum marker | Crie `.memory/project.json` ou sete `CCB_PROJECT_ID` |
| MCP DOWN no doctor | Java ausente ou daemon morto (backend mcp-memory) | Troque para backend `local`, ou instale Java 21+ e reinicie o daemon |
| Busca lenta após muitas entradas | Índice vetorial grande | Considere backend mcp-memory; rode consolidação |

## Model Router

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Porta 13456 ocupada por estranho | Squatter no port fixo | `netstat -ano \| findstr 13456` → mate o PID; o ensure nunca publica URL para processo sem o token |
| Router "não aplica" após Salvar | Daemon detached carregou config antiga | O apply atual é síncrono e mata/reinicia o daemon; se persistir, reinicie o Claude Code |
| 429 não cai no fallback | `fallback.enabled: false` ou sem chave NVIDIA/BYOK | `/dashboard` → Fallback ON + credencial |
| BYOK 401/403/404 na tela | Erro de config do endpoint (fail-loud de propósito) | Corriiga Base URL/headers — NÃO cai silencioso para NVIDIA |
| Sticky "troca" modelo no meio da sessão | TTL do pin expirou (6h default) | Aumente `sticky.ttlMs` em user-config |
| Sessão orçada em 200K com modelo 1M | Limitação do cliente atrás de qualquer gateway | Router OFF + `contextTuning.enabled: true` |
| Quero o proxy FORA de vez | — | `/dashboard` → Router → **Desligar tudo** (mata daemon, limpa settings.json) → reinicie o CC |

## Dashboard

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Não abre / token inválido | Servidor reiniciou (token novo por boot) | Rode `/dashboard` de novo |
| Aba em branco | Hook/server com erro | Aba Logs → erros recentes; `hook-errors.jsonl` em `.runtime/` |
| "Operation in progress" no aplicar | Mutex anti-concorrência (2º clique rápido) | Aguarde o 1º apply terminar (~segundos) |

## Curadoria

| Sintoma | Causa | Solução |
|---------|-------|---------|
| Wrapper nunca dispara | Assinatura não bate (flags/cwd/argumentos diferentes) | Confira `.vscode/shells.json`; reescrita automática só p/ alias exato sem args |
| Pedido de curadoria repetitivo chato | Comando é one-off | Marque via `curation_mark_oneoff` (sigs verbatim do review-block) |
| Quero desligar tudo | — | `/boss-profile free` |

## Diagnóstico Geral

```powershell
# Health check completo do plugin
node scripts/doctor.js

# Estado do router
curl http://127.0.0.1:13456/health

# Log do proxy
Get-Content ~\.claude\plugins\data\claude-code-boss\model-router\router.log -Tail 50
```

> Após consolidação de data-dirs, a pasta ativa pode ser um sibling `claude-code-boss*` — confira o ponteiro publicado antes de editar arquivos à mão.
