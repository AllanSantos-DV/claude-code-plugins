# API Reference

> Superfícies HTTP e payloads para integradores.

## Model Router (porta fixa 13456)

### `GET /health`

Liveness — **sempre 200**, mesmo sem autenticação:

```json
{ "status": "ok", "pid": 19324, "mode": "sticky-tier", "authenticated": false }
```

`authenticated: true` só com o router token correto (verify-before-trust: um squatter na porta nunca recebe `authenticated: true`).

### `POST /v1/messages` e `POST /v1/messages/count_tokens`

Formato Anthropic nativo, repasse verbatim do campo `model`. **O router só aceita POST com `/messages` na URL** — fora isso (exceto os endpoints de observabilidade abaixo: `/health`, `/metrics`, `/metrics/reset`, `/catalog`) responde 404; o catálogo de modelos é consumido internamente do upstream, nunca exposto via API. Comportamento por modo:

| Modo (`resolveMode`) | Comportamento |
|------|---------------|
| `off` | Server não deveria estar no caminho |
| `fallback-only` | Passthrough byte-identical à Anthropic (credencial repassada); só intervém no 429 |
| `sticky-tier` / `routing` | Reescreve `model`/`effort` conforme classificação + ceiling |
| 429 | Cadeia: BYOK endpoint → NVIDIA → mensagem orientando |
| `byok-direct` | Headers configurados no lugar; token da assinatura removido |

## Dashboard HTTP API (127.0.0.1, porta efêmera)

**Auth em todas as rotas `/api/*`:** header `x-dashboard-token` com o token de sessão (injetado no HTML como `window.__DASHBOARD_TOKEN__`). Sem o header ou token errado → recusado.

### Router

| Rota | Método | Descrição |
|------|--------|-----------|
| `/api/router/config` | GET | Flags efetivos (shipped ⊕ override): enabled, stickyEnabled, fallbackEnabled, byok, acceptedTerms, hasNvidiaKey, nimMasked, routing, shippedPort. Headers BYOK mascarados (`••••`) |
| `/api/router/config` | POST | **Só grava o override** (sem spawn do ensure, sem mutex) — mudança aplica no próximo hook/boot |
| `/api/router/apply` | POST | Grava user-config (`writeJsonAtomic`) + spawn SÍNCRONO do ensure (`BOSS_ROUTER_FORCE_RESTART=1`, timeout 30s SIGTERM→SIGKILL). Mutex in-memory: chamada concorrente → **409** |

Body de apply (BYOK usa shape **aninhado** — chaves planas `byokBaseUrl`/`byokHeaders` são ignoradas):

```json
{
  "enabled": false,
  "stickyEnabled": false,
  "fallbackEnabled": false,
  "byokEnabled": false,
  "byok": { "mode": "on-limit", "baseUrl": "", "headers": null },
  "acceptedTerms": true,
  "contextTuningEnabled": false
}
```

> `byok.headers: null` é a limpeza EXPLÍCITA das credenciais; omitir preserva as existentes.

Resposta só chega após o ensure exit 0 (cleanup completo) — `{ ok: true, restartRequired: true }`.

## Brain HTTP daemon (`~/.mcp-memory/run/daemon.json`)

- Registry com `{url, port, ...}` (campos extras escritos pelo daemon Java); descoberta automática quando `serverUrl` vazio. O lock do brain-server Node é arquivo distinto (`brain-http.lock.json`)
- Auth: Bearer token (arquivo ao lado do lock); `/health` aberto para supervisão
- Origin guard + loopback-only
- Protocolo MCP sobre Streamable HTTP (`POST /mcp`, sessão via header `Mcp-Session-Id`)
- Cliente (`scripts/mcp-client.js`): detecção de sessão evictada (HTTP 400 `-32600` → código `SESSION_EXPIRED`) com reconnect mutexado e retry exatamente uma vez; falha de reconnect embrulhada com `originalError` + `reconnectError`

## Hook Events (payloads que o plugin consome)

| Evento | Campos usados |
|--------|---------------|
| SessionStart / UserPromptSubmit | `session_id`, `hook_event_name`, `prompt`, `cwd` |
| PreToolUse / PostToolUse | `tool_name`, `tool_input`, `tool_response` |
| PostToolUseFailure | `tool_name`, erro/failure payload |
| Stop | transcript path (ingest/capture-queue), `stop_hook_active` |

Saída de hook suportada: `hookSpecificOutput.hookEventName` (deve ecoar o evento real) + `additionalContext`; bloqueio via `decision: block`.

## Formatos de Arquivo

| Arquivo | Formato |
|---------|---------|
| `user-config.json` (router/hooks/brain) | JSON, merge raso shipped⊕user, permissão 0600 best-effort |
| `shells.json` | `{version, shells:[{id, scriptPath, aliases[], outputLines...}]}`, pretty-printed 2-space |
| `state.json` (router) | `{pid, port, mode, startedAt, configFingerprint}` |
| `metrics.json` (router) | contadores de requests/downgrades/economia/cache |
| `.memory/project.json` | identidade de projeto (`metadata.defaults.project_id`) |
