# Examples & Use Cases

> Cenários reais de uso, ponta a ponta.

## 1. Onboarding em projeto legado

**Situação:** você entrou num codebase novo e o agente repete os mesmos erros dos primeiros dias.

```
Semana 1: agente erra PowerShell (head não existe), você corrige
          → capture_lesson registra a lição automaticamente
Semana 2: prompt parecido → lição injetada no contexto (brain_retrieve_context)
          → agente já nasce sabendo
Mês 2:    .memory/project.json commitado → colegas resolvem o MESMO projectId
          → para compartilhar as lições de fato, apontem todos para o mesmo
          backend mcp-memory (ou exportem/importem a KB manualmente)
```

## 2. Erro recorrente eliminado

**Situação:** todo `npm test` falha porque falta uma env var que só você sabe.

1. O agente roda, falha, você corrige → correction-detect oferece captura
2. Lição do tipo `lesson` salva com tags `[env, npm-test]`
3. Na próxima sessão qualquer pessoa: a instrução aparece antes do erro acontecer

## 3. Corte de custo de API

**Situação:** conta da Anthropic alta, maioria dos turnos é tarefa simples.

- `/dashboard` → Router → **Sticky Router ON** → Salvar & aplicar → reiniciar CC
- Turno 0: classificador local MiniLM decide o tier (sem custo, sem egress)
- Modelo fixado na sessão → cache quente → turnos seguintes ~0.1x no input
- Ceiling garante: nunca mais caro que o modelo do seu dropdown

Resultado medido pelo plugin: métricas de downgrades + economia estimada na aba Router.

## 4. Sobrevivendo ao fim da janela (429)

**Situação:** dia pesado, a janela de acesso esgota no meio de uma refatoração.

- Com Fallback ON + chave NVIDIA: request vai para o fallbackModel automaticamente
- Circuit breaker lê o reset exato dos headers — quando a janela reabre, volta sozinho pro Claude
- Sem chave: mensagem orientando em vez de erro opaco

## 5. Endpoint próprio (BYOK)

**Situação:** você tem crédito num gateway Anthropic-compatível.

1. `/dashboard` → Router → BYOK ON → mode `on-limit` (Claude primeiro) ou `always`
2. Base URL = só o host; headers colados (`Authorization: Bearer ...`)
3. Token da assinatura Claude é removido na rota BYOK — só seus headers seguem
4. Erro de config (401/404) aparece na hora — fail-loud, sem queda silenciosa

## 6. Janela de 1M preservada com economia

**Situação:** Opus/Sonnet 1M, mas o router orçaria a sessão em 200K.

```json
// ~/.claude/claude-code-boss/model-router/user-config.json
{ "contextTuning": { "enabled": true } }
```

Router fica OFF (base_url nunca publicada) mas `ENABLE_TOOL_SEARCH` + auto-compact entram no settings.json → economia de token com janela cheia.

## 7. Comando repetitivo vira wrapper

**Situação:** você roda a mesma suíte de testes 10x/dia com output gigante.

1. PostToolUse detecta volume; Stop hook oferece wrapper
2. Aprovado → `.vscode/scripts/meu-teste.ps1` + entrada em `.vscode/shells.json`
3. Chamadas exatas seguintes são redirecionadas ao wrapper — output dentro do budget

## 8. Debugando o próprio plugin

**Situação:** você mantém o claude-code-boss.

- `/boss-profile dev` → tudo on, escalonamento 3x
- Hooks isolados com payload fake via stdin (ver DEBUGGING.md)
- `install-local.mjs --dirty` força seu HEAD na cache do CC Desktop
- Aba Logs do dashboard mostra hook-errors ao vivo
