# CLI Reference

> Todos os comandos slash, scripts Node e tools MCP do plugin.

## Comandos Slash (dentro do Claude Code)

| Comando | Descrição |
|---------|-----------|
| `/dashboard` | Inicia o dashboard web (127.0.0.1, porta efêmera) e imprime a URL |
| `/boss-profile <standard\|dev\|free>` | Troca o perfil de hooks; persiste em user-config (sobrevive a updates) |
| `/policy-adjudicate` | Fluxo de adjudicação de políticas glob/shadow via subagente `policy-auditor` |
| `/policy-tune` | Ajustes de tuning das policies com base nas dispositions |

> Não há `/doctor` como slash command deste plugin — o health check é CLI: `node scripts/doctor.js`.

## Scripts Node (da pasta `claude-code-boss/`)

### Diagnóstico & manutenção

```powershell
node scripts/doctor.js              # health check completo (Node, data-dirs, daemon, hooks)
node scripts/consolidate-datadirs.js            # dry-run do plano de consolidação
node scripts/consolidate-datadirs.js --apply    # consolida siblings claude-code-boss* (transacional)
node scripts/consolidate-datadirs.js --apply --active-dir <path>   # pinna o alvo
node scripts/brain-consolidate.js               # dry-run do merge de near-duplicates da KB
node scripts/brain-consolidate.js --apply       # aplica (transação atômica, SEM backup)
node scripts/brain-reembed.js                   # re-embeda toda a KB após trocar modelo (obrigatório)
```

### Dev loop

```powershell
npm test                # test-hooks.js + test-units.js
npm run gate            # eslint (--max-warnings=0) + version sync + testes
npm run doctor          # atalho para scripts/doctor.js
node .claude/scripts/install-local.mjs --dirty   # (raiz do repo) força HEAD na cache do CC Desktop
```

## Tools MCP (servidor `plugin:claude-code-boss:brain-server`)

### Knowledge Base

| Tool | Descrição |
|------|-----------|
| `brain_search` | Busca semântica (vetorial) com fallback por keyword; `scope: project/user/both` |
| `brain_store` | Salva entrada estruturada (title, summary, detail, type, tags). **Sem dedup/merge** — grava incondicionalmente; use `capture_lesson` quando quiser dedup automático |
| `brain_count` | Nº de entradas da KB (por projeto ou global) |
| `brain_related` | Grafo de citações: entradas relacionadas a um id |
| `brain_retrieve_context` | Retrieval adaptativo para UserPromptSubmit (gate de relevância) |

### Captura de lições

| Tool | Descrição |
|------|-----------|
| `capture_lesson` | Curadoria de licao pós-mortem (fecha a review-window como captured) |
| `capture_ack` | Fecha review-window quando NÃO há licao a capturar |

### Pesquisa web

| Tool | Descrição |
|------|-----------|
| `research_query` | Pesquisa multi-fonte com citações (`depth: quick/thorough`) |
| `research_status` | Cache hit/miss de uma query |

### Curadoria & policies

| Tool | Descrição |
|------|-----------|
| `curation_mark_oneoff` | Marca comando volumoso como one-hit (exige `sigs` verbatim do review-block) |
| `curation_register_shell` | Cria wrapper curado + registra no shells.json (atômico) |
| `policy_activate` / `policy_deactivate` / `policy_list` | Ciclo de vida de standing policies |
| `policy_shadow_report` | Medição local de shadow-assertion policies |
| `policy_adjudication_prepare/record/purge/report` | Bundles de evidência + verdicts do auditor |
| `policy_self_update_report` / `policy_apply_candidate` | Advisory CAS de demote-to-advisory |
| `policy_trigger_evidence_purge` | Eraser de trigger evidence capturada |

### Graph (código semântico)

| Tool | Descrição |
|------|-----------|
| `graph_analyze` / `graph_ingest` / `graph_status` | Indexa/consulta o grafo do repo (hubs PageRank) |
| `graph_search` / `graph_symbols` | Busca semântica / símbolos por nome |
| `graph_callers` / `graph_references` | Inbound calls / tudo que aponta para um nó |

> Graph tools falham aberto quando o daemon está offline — mensagem orientando, zero throw. Em backend `local` nem chegam a contatar o daemon (gate de backend: retornam orientação).
