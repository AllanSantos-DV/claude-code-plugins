# Hooks Development Guide

> Como adicionar, modificar e testar hooks do plugin.

## Registro

Todo hook vive em `hooks/hooks.json`. Formatos aceitos:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/meu-hook.js"], "timeout": 5 }
```

Também existe o tipo `"type": "mcp_tool"` (ex.: `brain_retrieve_context` no UserPromptSubmit), que invoca uma tool do MCP server em vez de um comando.

### Hooks via `mcp_tool` no daemon (padrão desde a 2.29.1)

A maioria dos hooks não sobe mais um processo Node por disparo: o `hooks.json` aponta para uma tool `hook_<nome>` do brain-server, que roda o mesmo script in-process no daemon HTTP compartilhado (ADR-015).

```json
{ "type": "mcp_tool", "server": "plugin:claude-code-boss:brain-server", "tool": "hook_curation_guard",
  "input": { "session_id": "${session_id}", "tool_input": "${tool_input}", "project_dir": "${CLAUDE_PROJECT_DIR}" }, "timeout": 8 }
```

- As tools são registradas em `scripts/lib/hook-tools.js` (`HOOKS` + `FIELDS`). O Claude Code substitui os campos como **string**; `rebuildEvent` decodifica os campos JSON (`tool_input`, `tool_response`, …) e remonta o evento que o script espera no stdin.
- O script exporta `run(ev)` / `evaluate(ev)` e continua rodável por stdin (`require.main === module`).
- Cada chamada roda num `AsyncLocalStorage` com o env do chamador e invalida os caches de `hooks-config`/`brain-config`. Não guarde estado de sessão em variável de módulo: o daemon atende todas as sessões.
- Nada síncrono e caro no caminho do hook: um `execFileSync` trava o event loop de todas as sessões (por isso o `git rev-parse` de `lib/project-id.js` tem memo de 30 s).
- **Fail-open visível:** exceção na tool → `systemMessage` "[claude-code-boss] hook X degradado no daemon (fail-open): …", sem bloquear. Daemon fora do ar → o Claude Code trata o `mcp_tool` como erro não bloqueante.
- Hooks irmãos no mesmo evento rodam em paralelo; em PreToolUse, `deny` vence.
- **Duas filas no daemon.** Rápida (thread principal): guards de `PreToolUse`, `graph-guard`, detectores de prompt, `policy-glob-inject`, `policy-inject`. Pesada (`lane: 'heavy'`, worker próprio `servers/brain-server/lib/hook-worker.js`, FIFO serial): `Stop` e os hooks de efeito colateral de `PostToolUse` — tudo que faz SQLite síncrono ou I/O de journal/transcript. A FIFO garante que a escrita de um `PostToolUse` cai antes do `Stop` que a lê. Hook novo que faz SQLite/I/O pesado vai para a fila pesada.
- **Fire-and-forget:** hook pesado que sempre devolve `{}` leva `async: true` — responde `{}` na hora e roda em segundo plano na mesma FIFO. Falha dele aparece como `systemMessage` no próximo `Stop` daquela sessão.
- **Prazo:** cada tool tem prazo = `timeout` do `hooks.json` − 1 s. Passou do prazo, responde a mensagem de fail-open visível; na fila pesada o job que ainda nem começou é descartado. Código síncrono não é abortável: um hook que passa do prazo termina em segundo plano.
- Transcript: leia só o final (`lib/transcript-tail.js`), nunca `readFileSync` do arquivo inteiro.
- Ficam como `command` os hooks que precisam funcionar **sem** o daemon: `SessionStart`, `user-prompt-submit-dispatcher` (`brain-daemon-ensure`, `brain-health`, `brain-status`) e `model-router-ensure`.
- Para um hook novo: adicione a entrada em `HOOKS`, a entrada `mcp_tool` no `hooks.json`, o caso de paridade em `test-units.js` (mesma saída via stdin e via tool) e a linha no README.

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
