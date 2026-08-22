# Dashboard — Guia de Uso

> Interface web local do plugin. Abrir com `/dashboard` (slash command).

## Acesso e Seguranca

- Bind em `127.0.0.1`, porta efemera (impressa no terminal)
- Token de sessao injetado no HTML + allowlist de **Host header** (`localhost:<port>` / `127.0.0.1:<port>`) como defesa contra DNS rebinding
- Fechou o servidor? O token morre junto. Cada boot gera um novo.

## Abas

Nav: **Home · Brain KB · Skills · Hooks · Insights · Logs · Router** (7 abas).

### Home

- **Cards de valor** (30 dias): tokens economizados, licoes aprendidas, taxa de citacao do retrieval
- **Recomendacoes de tuning**: regras deterministicas sobre telemetria — recomendam, nunca alteram sozinhas
- **Learning loop**: licoes capturadas vs mescladas por semana (merge caindo = autocrita funcionando)
- **Doctor**: botao "Run check" diagnostica Node, data-dirs, daemon, hooks
- **KB hygiene**: Preview/Apply da consolidacao de near-duplicates

### Brain KB

- **Backend**: `local` (SQLite embutido) ou `mcp-memory` (Java). Botao "Test connection" e "Migrate now" (idempotente)
- **Embedder**: provider/modelo/dims. Trocar modelo exige re-embed (`node scripts/brain-reembed.js`)
- **Orcamento de memoria**: presets lean/balanced/ample + limites finos
- **Identidade do projeto**: fixar projectId (o dashboard grava o marker legacy `.claude-boss-project`, ainda honrado mas deprecado — o mecanismo atual e `.memory/project.json`)

### Router

Ver [features/MODEL-ROUTER.md](./MODEL-ROUTER.md) para o guia completo. Resumo dos controles:

| Controle | Funcao |
|----------|--------|
| Card hero | Modo atual ao vivo (dot colorido + label) |
| Sticky Router | Toggle principal (recomendado) |
| Fallback 429 | Rede de seguranca de limite |
| Routing per-turn | Deprecado (quebra cache) |
| Chave NVIDIA / BYOK | Credenciais locais (0600) |
| **Desligar tudo** | Master-off: zera tudo, mata daemon, limpa settings.json — sincrono |
| Salvar & aplicar | Grava user-config + reinicia daemon com config nova |

Banner "Reinicie o Claude Code" aparece quando a mudanca precisa engatar no proximo boot.

### Skills

- Scan de licoes (lessons + patterns) com recurrence/confianca acima do threshold
- Drafts de SKILL.md em staging: Preview, Approve (instala em `~/.claude/skills/`), Discard

### Hooks

- Perfil ativo (standard/dev/free) + toggles individuais
- Config por hook (ex.: maxLines do memory-rotate)

### Insights

Eventos por dia, log recente, Skill ROI (investimento vs retorno das skills promovidas)

### Logs

Ring buffer (500 entradas), hook-errors.jsonl, auto-refresh, copiar JSON

## Tarefas Comuns

| Quero... | Faca |
|----------|------|
| Economizar API | Router -> Sticky ON -> Salvar & aplicar |
| Sobreviver ao 429 | Router -> Fallback ON (+ chave NVIDIA) |
| Desligar o proxy de vez | Router -> **Desligar tudo** -> restart |
| Ver por que um hook falhou | Logs -> filtrar erros |
| Consolidar KB duplicada | Home -> KB hygiene -> Preview -> Apply |
| Diagnosticar instalacao | Home -> Doctor -> Run check |
