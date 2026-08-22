# Hooks Development Guide

> Como adicionar, modificar e testar hooks do plugin.

## Registro

Todo hook vive em `hooks/hooks.json`. Formatos aceitos:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/meu-hook.js"], "timeout": 5 }
```

Também existe o tipo `"type": "mcp_tool"` (ex.: `brain_retrieve_context` no UserPromptSubmit), que invoca uma tool do MCP server em vez de um comando.

Eventos em uso: `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse` (com `matcher`), `PostToolUse`, `PostToolUseFailure`, `Stop`.

**Regra:** cada script novo precisa (1) entrada no hooks.json, (2) documentação no README do plugin — CI (`release-audit.mjs → hooks-doc-drift`) bloqueia drift.

## Contrato de execução

- **Entrada:** JSON no stdin (`session_id`, `hook_event_name`, `prompt`, `tool_input`, ...). Leia tolerante a stdin ausente/TTY:
  ```js
  function readHookInput() {
    try {
      if (process.stdin.isTTY) return {};
      const raw = fs.readFileSync(0, 'utf-8');
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  ```
- **Saída informativa:** `{ hookSpecificOutput: { hookEventName: <evento real>, additionalContext: "..." } }` — o nome deve ecoar o evento que disparou (nome fixo = hook rejeitado pelo CC)
- **Bloqueio:** `decision: block` com reason (PreToolUse guards, Stop dispatchers)
- **Fail-open sempre:** qualquer erro → loga e exit 0; hook NUNCA derruba o Claude Code
- **Timeouts curtos:** 5–15s por hook; trabalho pesado vai para daemon/spawn detached

## Convenções obrigatórias

| Regra | Por quê |
|-------|---------|
| Sem `catch {}` vazio | eslint `no-empty` bloqueia |
| Catch que retorna precisa logar/`void err` | regra custom `local/no-silent-return-catch` |
| Fail-loud em config inválida | nunca fallback silencioso mascarando erro |
| Escrita atômica (`lib/atomic-write.js`) | Windows EPERM retry; estado compartilhado |
| DATA_DIR via `lib/data-dir.js` | ponteiro de consolidação; nunca `env \|\| fallback` cru |

## Adicionar um detector ao stop-dispatcher (padrão atual)

1. Crie o detector como módulo com `run(ctx)` retornando block ou `{}`
2. Registre no array `DETECTORS` de `scripts/stop-dispatcher.js` como `{ name, mod }`; a prioridade vive no mapa `PRIORITY` separado (`'curation-stop': 0, 'failure-retro': 1`, demais caem em `DEFAULT_RANK`)
3. Respeite os invariants testados: merge determinístico, detector com erro → `onError` sem bloquear, perfil `free` gateia tudo
4. Teste em `test-units.js` cobrindo: dispara, não dispara, erro interno, ordem no merge

## Testar seu hook

```powershell
# Suíte de hooks (payloads reais)
npm run test:hooks
# Um hook específico à mão
'{"hook_event_name":"Stop"}' | node scripts/seu-hook.js
```

Veja [TESTING.md](./TESTING.md) para convenções completas (withTempHome, fake daemons, failing-first).
