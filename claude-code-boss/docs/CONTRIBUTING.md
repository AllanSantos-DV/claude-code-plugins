# Contributing

> Guia para contribuir com o claude-code-plugins (monorepo).

## Estrutura do repo

```
claude-code-plugins/
├── claude-code-boss/        # O plugin (fonte, testes, configs) — versionado
├── rf-reviewer/             # Plugin separado
├── .claude-plugin/          # marketplace.json
├── .github/                 # CI, release guards, scripts de auditoria
├── pages/                   # Landing pages por plugin (vitrine)
└── AGENTS.md                # Convenções do repo — LEIA PRIMEIRO
```

**Scope split estrito:** dev tooling em `.claude/scripts/`, planning em `docs/plans|maps|research/` e `claude-code-boss/docs/*-PLAN.md` são **gitignored**. Docs de produto (`GETTING-STARTED`, `features/`, ADRs...) SÃO versionadas.

## Setup de desenvolvimento

```powershell
git clone https://github.com/AllanSantos-DV/claude-code-plugins.git
cd claude-code-plugins\claude-code-boss
npm install          # postinstall: deps + warm embedding (CLAUDE_SKIP_EMBED_WARM=1 pula)
npm run gate         # deve passar verde antes de qualquer PR
```

Teste suas mudanças num CC Desktop real:

```powershell
node .claude/scripts/install-local.mjs --dirty   # força HEAD na cache; depois /reload-plugins
```

## Convenções de código

| Regra | Enforcement |
|-------|-------------|
| Sem `catch {}` vazio | eslint `no-empty` |
| Catch que retorna precisa logar/`void err` | regra custom `local/no-silent-return-catch` |
| Fail-loud: sem fallback que mascara erro | revisão + skills do repo |
| Escrita atômica via `scripts/lib/atomic-write.js` | teste EXAUSTIVO varre offenders |
| DATA_DIR só via `scripts/lib/data-dir.js` | idem |
| Version sync entre package.json/READMEs | `sync-version.js --check` no gate |

## Testes

- Toda fix entra failing-first (RED→GREEN)
- `npm run gate` verde é pré-requisito de merge — suíte inteira, incluindo falhas pré-existentes
- Features novas merecem gate adversarial: revisor/tester independentes tentando quebrar antes do commit
- Veja [TESTING.md](./TESTING.md)

## Fluxo de release

1. `/release` (slash command em `.claude/commands/release.md`) orquestra
2. CI green **≠** plugin funciona: smoke no CC Desktop real é o gate E2E
3. Auditoria mecânica pré-tag: `node .github/scripts/release-audit.mjs check` (hooks-doc-drift, changelog-current, no-conflict-marks, index-version-current)
4. Auditoria adversarial: agente `release-auditor` revisa diff desde a última tag (advisory, não bloqueia)
5. Tag `v<V>` (boss) ou `rf-v<V>` (rf-reviewer) → workflow publica

## Docs & páginas

- Editou `README.md`/`CHANGELOG.md`/`plugin.json`? O **pages-guard** bloqueia o merge até a landing page ser redesenhada pela agent `vitrine` e re-stampada:
  ```powershell
  node .github/scripts/pages-guard.mjs stamp <plugin>
  node .github/scripts/pages-guard.mjs check   # OK
  ```
- Hook novo no hooks.json precisa estar documentado no README (check `hooks-doc-drift`)
- Mudança arquitetural relevante → escreva um ADR em `docs/adr/`

## Commits

Conventional commits, mensagens em inglês (convenção do repo). O CHANGELOG do plugin segue formato symptom → root cause → fix → verification.
