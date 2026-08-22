# Debugging Guide

> Como diagnosticar o plugin quando algo não funciona.

## Primeira parada: doctor

```powershell
node scripts/doctor.js        # ou: npm run doctor
```

Checa: versão do Node, env com placeholder `${...}` não-expandido, data-dirs fragmentados, modelo embedding presente, daemon vivo, eventos de hooks válidos. `criticalFail` no resumo = comece por ali.

## Mapa de diagnóstico por sintoma

### Hook silencioso (não faz nada)

1. O evento está em `hooks/hooks.json`? (ex.: SubagentStart só tem policy-inject)
2. Rode o hook à mão com payload fake:
   ```powershell
   '{"hook_event_name":"UserPromptSubmit","prompt":"teste","session_id":"s1","cwd":"C:\\proj"}' | node scripts/<hook>.js
   ```
3. Procure erros no ring: `DATA_DIR/.runtime/hook-errors.jsonl` (pasta ativa — pode ser sibling)
4. `hookSpecificOutput.hookEventName` precisa ecoar o evento REAL — nome errado = hook inteiro rejeitado pelo CC

### Router

| Verificação | Comando |
|-------------|---------|
| Daemon vivo? | `curl http://127.0.0.1:13456/health` → `authenticated:false` é normal sem token |
| Quem segura a porta? | `netstat -ano \| findstr 13456` |
| Modo efetivo | `/dashboard` → Router (card hero) — mismatch running/configured = reload pendente |
| Por que não aplicou? | `router.log`: procura `[ENSURE]` — kills, fingerprint drift, squatter warnings |
| Config que o server vê | `state.json` tem `configFingerprint`; ensure mata daemon se divergir |

### Brain

| Sintoma | Onde olhar |
|---------|------------|
| Recall vazio | projectId resolveu diferente — `.memory/project.json`, env `CCB_PROJECT_ID` |
| Embedder quebrado | `/dashboard` → Brain → Test/Install; warm cache em `DATA_DIR/models` (pasta ativa — pode ser sibling consolidado) |
| Daemon offline | `~/.mcp-memory/run/daemon.json` + `curl <url>/health` |
| MCP DOWN | Backend mcp-memory sem Java 21+; troque para `local` |

### Dashboard

- Token novo a cada boot — reabra via `/dashboard`
- Erros de API aparecem na aba Logs e no stderr do processo do dashboard
- "Operation in progress" = mutex do apply ativo (aguarde)

### Data-dir confuso

```powershell
node scripts/consolidate-datadirs.js              # dry-run mostra siblings e plano
```

A pasta ATIVA é nomeada pelo ponteiro publicado (`data-dir.js`) — pode ser um sibling `claude-code-boss*`. Nunca edite arquivos sem confirmar qual pasta está ativa.

## Matriz de env vars (debug)

| Env | Efeito no debug |
|-----|-----------------|
| `CLAUDE_PLUGIN_DATA` | Redireciona DATA_DIR (isolamento de teste) |
| `CLAUDE_PLUGIN_ROOT` | Override da raiz do plugin (fallback `__dirname/..`) |
| `BOSS_ROUTER_FORCE_RESTART=1` | Ensure mata daemon órfão mesmo em modo off |
| `BOSS_ROUTER_MODE` | Só diagnóstico (server recomputa da config) |
| `MCP_RUN_DIR` | Registry alternativo do daemon Java |
| `CCB_PROJECT_ID` | Pin de projeto p/ Brain |
| `CLAUDE_SKIP_EMBED_WARM=1` | Pula download do modelo (CI) |

## Logs — onde são

| Fonte | Caminho |
|-------|---------|
| Router proxy + ensure | `DATA_DIR/model-router/router.log` (`[ENSURE]` = hook) |
| Hooks com erro | `DATA_DIR/.runtime/hook-errors.jsonl` |
| Telemetria de Stop | SQLite de métricas (ver aba Insights) |
| Dashboard | stderr do processo; aba Logs (ring 500) |
