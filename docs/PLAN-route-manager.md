# PLAN — Route Manager Declarativo (model-router)

> **Slug:** `route-manager` · **Status:** completed · **Data:** 2026-05-14 · **Concluído:** 2026-09-11
> **Owner:** sdd-planner (subagent) · **Escopo:** `claude-code-boss/{config/router-config.json, servers/model-router/index.js}`
> **Branch base:** `main` @ `15e47bb` · **Working dir:** diff não commitado (DEFAULT_ROUTES + resolveRoutes + passthroughGeneric)

---

## Frontmatter (SDD)

```yaml
plan: route-manager
version: 1.0
status: completed
created: 2026-05-14
source: SDD Step 2 — sdd-planner
input: research real (codebase + router-config.json + git diff) + briefing DoD
output: docs/PLAN-route-manager.md (living doc) + docs/plans/route-manager.md (mirror, repo convention)
taxonomy: sdd-phase-execute (PLANNED / READY / to-verify / UNVERIFIED / completed)
```

---

## 1. Objetivo

Entregar um **gerenciador declarativo de rotas** no proxy `model-router` onde o shipping versionado define o default e o overlay local do usuário estende/substitui/desabilita rotas por path, sem reimplementar o código já existente em working dir — apenas fechar gaps de divergência, validação, auth e cobertura.

---

## 2. Contexto (grounded — research real)

### 2.1 Intenção / DoD (briefing)

- **Shipping versionado:** `config/router-config.json#routes` define o DEFAULT (versionado) — 7 rotas:
  | path | method | upstream | auth |
  |------|--------|----------|------|
  | `/health` | GET | `local:health` | `none` |
  | `/metrics` | GET | `local:metrics` | `none` |
  | `/metrics/reset` | POST | `local:metricsReset` | `loopback` |
  | `/catalog` | GET | `local:catalog` | `none` |
  | `/v1/messages` | POST | **divergente (ver G1)** | `signature` |
  | `/v1/messages/count_tokens` | POST | `passthrough` | `signature` |
  | `/v1/models` | GET | `passthrough` (GENÉRICO, sem exceção) | `signature` |
  - `_comment` orienta overlay para `local:catalog` via `DATA_DIR/model-router/user-config.json` (`_comment_upstream` em `/v1/models`).
- **Overlay local:** `DATA_DIR/model-router/user-config.json#routes` via `mergeUserConfig` shallow por rota — `null`/`false` desabilita, `undefined`/ausente = default, `object` = spread `{...def, ...ov}`. Caminho via `routerUserConfigPath()` global estável. Nunca versionado.
- **Código (working dir, não commitado — `git diff`):**
  - `servers/model-router/index.js:177` `DEFAULT_ROUTES` — espelho do shipping (7 entradas).
  - `servers/model-router/index.js:187` `resolveRoutes(cfg)` — pura, implementa shallow-merge + null/false.
  - `servers/model-router/index.js:2212` `passthroughGeneric(method,rawBody,...)` — genérico (method-aware, body opcional, `content-length` condicional, `BYOK_UPSTREAM_TIMEOUT_MS` vs `UPSTREAM_TIMEOUT_MS`).
  - `servers/model-router/index.js:2447-2518` `createServer` dispatch early declarativo com `405`/`404`, `passthrough`/`maybeWarmCatalog` com `byok.resolveUpstream` + `UPSTREAM_FALLBACK` + `cooldownActive`.
- **Estado atual:** implementação JÁ em working dir não commitada (`git diff --stat` = 12 files, `router-config.json +10`, `index.js +155/-67`). Plano cobre o existente + fecha gaps **sem reimplementar do zero**.

### 2.2 Mapa de código verificado em disco

| Artefato | Path | Linhas | Estado |
|----------|------|--------|--------|
| Shipping routes | `claude-code-boss/config/router-config.json` | 171–180 | Commitado com diff: 7 rotas + `_comment` |
| `mergeUserConfig` | `servers/model-router/index.js` | 156–171 | Estendido: `routes` no shallow-merge whitelist |
| `DEFAULT_ROUTES` | `servers/model-router/index.js` | 173–185 | Novo, espelho do shipping |
| `resolveRoutes` | `servers/model-router/index.js` | 187–202 | Novo, puro |
| `passthrough` (legado) | `servers/model-router/index.js` | 2191–2210 | Mantido p/ compat `count_tokens` |
| `passthroughGeneric` | `servers/model-router/index.js` | 2212–2234 | Novo, genérico |
| `createServer` early dispatch | `servers/model-router/index.js` | 2442–2539 | Reescrito declarativo |
| `routerUserConfigPath()` | `scripts/lib/router-config-path.js` | — | Reuso (global estável) |
| `byok.resolveUpstream`/`buildHeaders` | `servers/model-router/byok.js` | — | Reuso |
| `catalog.getSnapshot`/`maybeWarmCatalog` | `servers/model-router/catalog.js` | — | Reuso |

### 2.3 Gaps de research a endereçar (input do briefing)

| ID | Severidade | Gap |
|----|------------|-----|
| **G1** | **alta** | Divergência shipping vs código em `/v1/messages`: shipping diz `passthrough`, código diz `routed` (`DEFAULT_ROUTES['/v1/messages'].upstream === 'routed'`). Decidir e alinhar — um dos dois está errado. |
| **G2** | média | `auth` declarativo (`none`/`loopback`/`signature`) não é enforceado fora de `health`/`metricsReset`. `signature` não valida `x-api-key`/`authorization`; `loopback` só em `/metrics/reset`; demais rotas ignoram o campo. |
| **G3** | média | Falta validação de schema no overlay: `upstream`/`method`/`auth` sem enum, `path` sem normalização, user pode injetar `{method:"DELETE", upstream:"local:health"}` ou `upstream:"passthrough "` com typo silencioso. |
| **G4a** | cobertura | Duplicação `DEFAULT_ROUTES` vs `router-config.json#routes` sem teste de paridade — drift silencioso futuro. |
| **G4b** | cobertura | Hot-reload ausente: `config` capturado no closure de `createServer`; edição de `user-config.json#routes` exige restart do daemon. |
| **G4c** | cobertura | Early vs late tenant: `cfgEarly = effectiveConfig(config, tenantEarly)` no early dispatch vs `cfg = effectiveConfig(config, tenant)` no late handler — dois `resolveRoutes` por request, risco de divergência se `effectiveConfig` não for idempotente. |
| **G4d** | cobertura | Duplicidade `passthrough` legado (`rawBody` fixo `POST` + retry) vs `passthroughGeneric` (`method` genérico, sem retry, `content-length` condicional) — contratos diferentes, 2 caminhos p/ mesmo upstream. |
| **G4e** | cobertura | `405` vs `404` vs legado `req.url.includes('/messages')` fallback — early dispatch responde `405` mas late fallback ainda usa `includes('/messages')` substring, que casa `/v1/messages_fake`. |

---

## 3. DoD — Critérios verificáveis (todos devem passar p/ shippar)

| # | Critério | Verificação |
|---|----------|-------------|
| D1 | `config/router-config.json#routes` contém exatamente 7 rotas com `method`/`upstream`/`auth` completos (strip `_comment*` recursivo) conforme tabela canônica após G1 | `node -e "const j=require('./claude-code-boss/config/router-config.json'); const s=require('./claude-code-boss/scripts/test-helpers/strip-comments'); assert.deepStrictEqual(s(j.routes), EXPECTED_7)"` com `EXPECTED_7` contendo 7 objetos completos |
| D2 | `DEFAULT_ROUTES` em `index.js:177` deepEqual ao shipping após strip `_comment*` recursivo (todas as chaves `^_comment` em qualquer profundidade removidas) | Teste de paridade em `claude-code-boss/scripts/test-units.js:route-parity` compara `DEFAULT_ROUTES` vs `stripComments(require(router-config.json).routes)` |
| D3 | `resolveRoutes(cfg)` + `validateRoute` puro: `undefined→default`, `null/false→omit`, `object→spread`, custom `method+upstream→add`; `validateRoute` retorna `{warnings}` e `resolveRoutes` só ignora rota inválida com warn injetável | Teste unitário em `test-units.js:resolveRoutes` com 6+ casos (incl. desabilitar + custom) + asserts em `warnings[]` |
| D4 | `/v1/messages` tem upstream canônico único (G1 decidido) em shipping E código | `grep -n "v1/messages" config/router-config.json servers/model-router/index.js` converge |
| D5 | `auth` declarativo é enforceado: `none` = passa, `loopback` = `isLoopbackHost` → 403, `signature` = exige `x-api-key` ou `authorization` → 401 | Teste de integração HTTP: `GET /health` sem header → 200; `POST /metrics/reset` remoto → 403; `POST /v1/messages` sem `x-api-key` → 401 |
| D6 | Overlay com `upstream`/`method`/`auth` inválido é rejeitado (warn + ignora rota, não crasha) | Teste: `user-config.json {routes:{"/x":{method:"FOO",upstream:"bad"}}}` → rota ignorada, log warn, demais rotas intactas |
| D7 | `passthrough` legado é alias fino `passthroughGeneric('POST',...)` + `passthroughGeneric` genérico (2 definições canônicas, sem impl duplicada) | `grep -c "function passthrough" servers/model-router/index.js` → 2 (alias + generic); `passthrough` body = single return para `passthroughGeneric` |
| D8 | `405 Method Not Allowed` para method mismatch + `Allow` header (`Allow: <route.method>`); `404` para path sem rota (dispatch usa `pathnameEarly` exato, não `req.url.includes('/messages')`) | Teste HTTP real: `GET /v1/messages` → 405 + `Allow: POST`; `GET /v1/messages_fake` → 404; `GET /nope` → 404 |
| D9 | Restart-required documentado (MVP) + `effectiveConfig` idempotente provado; hot-reload `fs.watch` movido para backlog | Teste: `effectiveConfig(effectiveConfig(c,t),t) deepEqual effectiveConfig(c,t)` + `user-config.json#routes` exige restart do daemon (doc em `_comment`) |
| D10 | Nenhuma rota é versionada fora de `router-config.json`; `user-config.json` em `globalDir()/model-router/user-config.json` fora do worktree (não versionado) | `grep -q "user-config" .gitignore` + prova `routerUserConfigPath()` fora do repo (teste hermético isola `HOME` em `mkdtemp`) |

---

## 4. Decisões e rationale

| Decisão | Escolha | Por que | Alternativa descartada |
|---------|---------|---------|------------------------|
| **D-G1: `/v1/messages` = `routed`** | Código está certo; shipping será alinhado para `upstream:"routed"` | `forwardRequest` + `classify`/teto/routing existe só para `/v1/messages` (custo/janela); `passthrough` perderia todo o valor do proxy. O diff de `router-config.json` atual marca `passthrough` — foi erro de copia da rota `count_tokens`. | Manter shipping `passthrough` exigiria reescrever `forwardRequest` como rota `passthrough` + feature flag, quebrando `ceiling`/`sticky`/`nim`. |
| **D-G2: `signature` = gate leve (presença)** | Enforcea presença de `x-api-key` OU `authorization` (case-insensitive), não valida valor — proxy nunca tem segredo; upstream valida. | Proxy não deve conhecer token da Anthropic (BYOK já remove `authorization` leak). Validar presença evita request anônima chegar ao upstream e vazar timing. | Validar valor exigiria secret no proxy; não enforcear nada mantém gap de anon. |
| **D-G3: validação fail-open por rota** | Overlay com rota malformada → `logger.warn` + ignora só essa rota; demais rotas + defaults seguem. | Evita que 1 typo em `user-config.json` derrube `/health`/`/metrics`. Consistente com `mergeUserConfig` best-effort. | Fail-closed (rejeitar arquivo inteiro) quebraria liveness por erro de usuário. |
| **D-G4a: teste de paridade** | Teste unitário que carrega ambos e `deepEqual` após `stripComments`. Roda no `npm test` e no `pre-merge-commit`. | Única forma de impedir drift entre `router-config.json` e `DEFAULT_ROUTES` sem gerar código. | Geração de `DEFAULT_ROUTES` a partir do JSON em runtime — adiciona I/O no boot e quebra export p/ testes herméticos. |
| **D-G4d: unificar passthrough** | `passthrough` legado vira alias fino `passthroughGeneric('POST', ...)` ou é removido; `count_tokens` passa a usar `passthroughGeneric`. | Elimina 2 caminhos com retry/timeout divergentes. `passthroughGeneric` já trata `GET` sem body corretamente. | Manter 2 funções duplica `byok.resolveUpstream` + `UPSTREAM_FALLBACK` paths e confunde `maybeWarmCatalog`. |
| **D-Paridade `_comment*`** | Comparação de paridade ignora chaves `^_comment` | Shipping usa `_comment*` como doc; `DEFAULT_ROUTES` não precisa delas. | Copiar `_comment` para `DEFAULT_ROUTES` polui runtime. |
| **D-Hot-reload** | Fase 4 implementa `fs.watch`/`readFile` re-load de `USER_CONFIG_FILE` com debounce 300ms; se não viável, documenta `restart required` e testa `effectiveConfig` idempotente | Editar `user-config.json` sem restart é UX esperado do overlay. | Hot-reload com `require` cache — `require` cacheia JSON, precisa `fs.readFileSync` + `JSON.parse`. |

---

## 5. Reuse ledger — o que NÃO reinventar

| Reuso | Onde vive | Como este plano reutiliza | Não fazer |
|-------|-----------|---------------------------|-----------|
| `routerUserConfigPath()` | `scripts/lib/router-config-path.js` | Único caminho global estável p/ `USER_CONFIG_FILE`; já usado em `index.js:55` | Não criar novo `path.join(DATA_DIR, ...)` local |
| `mergeUserConfig(base, override)` | `servers/model-router/index.js:156` | Já estendido com `routes` no whitelist shallow; `resolveRoutes` consome `cfg.routes` pós-merge | Não reimplementar merge; só adicionar validação em `resolveRoutes` |
| `byok.resolveUpstream(config, {onLimit}, UPSTREAM_FALLBACK)` | `servers/model-router/byok.js` | `passthroughGeneric` já usa; manter para todo `passthrough`/`routed` | Não hardcodar `api.anthropic.com` |
| `byok.buildHeaders(originalHeaders, upstreamTarget)` | `servers/model-router/byok.js` | Sanitiza `authorization`/`x-api-key` leak em BYOK; já usado em ambos passthrough | Não copiar header manualmente |
| `UPSTREAM_FALLBACK` | `servers/model-router/index.js` (const) | Fallback Anthropic quando BYOK não ativo | Não duplicar URL |
| `cooldownActive(config)` / `cooldownCfg` / `clearCooldown` | `servers/model-router/index.js` | Gate `on-limit` para `passthroughGeneric` já correto | Não reimplementar breaker |
| `catalog.getSnapshot()` / `maybeWarmCatalog(headers, cfg)` / `catalogEnabled(cfg)` | `servers/model-router/catalog.js` | `local:catalog` handler + warm no `passthrough` early; manter | Não re-buscar catálogo inline |
| `resolveTenant(headers)` / `effectiveConfig(config, tenant)` | `servers/model-router/index.js` | Early tenant `tenantEarly` + late `tenant`; unificar p/ 1 chamada se possível | Não duplicar lógica de tenant |
| `isLoopbackHost(req)` | `servers/model-router/index.js:2428` | Já enforcea `loopback` em `local:metricsReset`; estender p/ genérico `auth:loopback` | Não reimplementar check de host |
| `routerTokenMatches` / `routerToken` | `servers/model-router/index.js` | `/health` `authenticated` já usa; não tocar | Não mudar semântica de `/health` |
| `configFingerprint` | `scripts/lib/router-fingerprint.js` | Usado p/ state.json; manter p/ hot-reload fingerprint | Não inventar novo hash |
| `requestUpstream` / `sendUpstreamRequest` / `pipeUpstreamResponse` | `servers/model-router/index.js` | `passthroughGeneric` usa `sendUpstreamRequest`; unificar com `passthrough` | Não duplicar pipe |
| `metricsSnapshot` / `resetMetrics` / `metricsOutcome` | `servers/model-router/index.js` | `local:metrics`/`metricsReset` já usam | Não tocar |

---

## 6. Riscos e blast radius

### 6.1 Matriz de riscos

| # | Risco | Prob. | Impacto | Mitigação | Fase que mitiga |
|---|-------|-------|---------|-----------|-----------------|
| R1 | Alinhar G1 errado (escolher `passthrough` p/ `/v1/messages`) quebra `ceiling`/`sticky` e custo explode (cache miss) | Média | **Alto** | Decisão explícita `routed` + review do `forwardRequest` ainda vivo; teste E2E `POST /v1/messages` com mock Anthropic prova que `model` ainda é reescrito | Fase 1 |
| R2 | Validação de overlay muito estrita derruba proxy no boot (user-config malformado) | Média | Alto | Fail-open por rota + `try/catch JSON.parse` + warn; teste com JSON inválido | Fase 2 |
| R3 | Enforcear `signature` quebra clientes que não mandam `x-api-key` (ex.: `curl /health` com token no query) | Baixa | Alto | Só enforcear `signature` em `/v1/*` (onde já é esperado); `health`/`metrics`/`catalog` permanecem `none`; teste cobre 401 só em `/v1/*` | Fase 3 |
| R4 | Unificar `passthrough` remove retry de `count_tokens` e degrada resiliência | Baixa | Médio | Preservar retry 1x em `passthroughGeneric` quando `path.includes('count_tokens')` ou documentar remoção; teste de retry | Fase 4 |
| R5 | Hot-reload com `fs.watch` gera loop/EMFILE em Windows | Média | Médio | Debounce 300ms + `fs.watchFile` fallback; se instável, fallback p/ `restart required` documentado | Fase 4 |
| R6 | `405` quebra compat com clientes que fazem `GET /metrics` com `HEAD` | Baixa | Baixo | `methodOk` já case-insensitive; `405` só quando `routeEarly && !methodOk`; `HEAD` não é rota declarada hoje | Fase 1/3 |
| R7 | Duplicação `DEFAULT_ROUTES` drifta novamente após release | Alta | Médio | Teste de paridade no CI (`release-audit.mjs` ou `pages-guard` like) + `pre-merge-commit` hook | Fase 5 |
| R8 | `req.url.includes('/messages')` legado casa rota custom `/my/messages` e roteia errado | Baixa | Médio | Substituir por `pathname === '/v1/messages'` ou `routesEarly` lookup; teste com path trap | Fase 4 |

### 6.2 Blast radius

- **Porta fixa 13456 + `ANTHROPIC_BASE_URL`**: proxy é MITM do `Claude Code`; bug de rota = credencial vai para upstream errado ou request cai em 404. Mitigação: `byok.buildHeaders` sanitiza leak; `passthroughGeneric` sempre via `resolveUpstream`.
- **BYOK third-party**: `passthrough` genérico com `method` arbitrário pode forwardar `GET /v1/models` com `x-api-key` da assinatura se `auth` mal configurado. Mitigação: `auth:signature` exige `signature` mas `buildHeaders` remove assinatura quando `isByok`.
- **Concorrência no boot**: `maybeWarmCatalog` fire-and-forget + `cooldownActive` compartilhado; rota nova não deve introduzir `await` no early dispatch (que já é `async` mas early handlers são sync). Mitigação: manter `req.on('data'/'end')` pattern.
- **Multi-tenant**: `resolveTenant` roda 2x (early + late); mudança em `effectiveConfig` deve permanecer pura/idempotente.

---

## 7. Fases — sequencialmente ordenadas, cada uma gatable

> Taxonomia `sdd-phase-execute`: `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed`.
> Gate = comando/arquivo objetivo que prova a fase; sem gate não avança.

### Fase 1 — Alinhar G1 + paridade shipping↔código

- **Status:** `PLANNED`
- **Objective:** Resolver divergência `/v1/messages` e garantir que `DEFAULT_ROUTES` e `router-config.json#routes` sejam idênticos (strip `_comment*`).
- **Deliverable:**
  - `claude-code-boss/config/router-config.json:177` — `"/v1/messages": { "method":"POST","upstream":"routed","auth":"signature" }` (trocar `passthrough`→`routed`) + `_comment` atualizado explicando que `routed` = via `forwardRequest`/classificador/teto.
  - `servers/model-router/index.js:177-185` — permanece `routed` (nenhuma mudança), mas `DEFAULT_ROUTES` ganha comentário `// espelho de router-config.json#routes — paridade testada`.
  - Teste `claude-code-boss/tests/route-parity.test.js` (ou `test-units.js`) — `stripComments(routes)` deepEqual entre os dois.
- **Verification:**
  ```bash
  node --test claude-code-boss/tests/route-parity.test.js
  # ou
  node -e "const a=require('./claude-code-boss/config/router-config.json').routes; const b=require('./claude-code-boss/servers/model-router/index.js').DEFAULT_ROUTES; /* strip _comment* + deepEqual */"
  grep -n '"\/v1\/messages"' claude-code-boss/config/router-config.json claude-code-boss/servers/model-router/index.js
  ```
- **Gate criteria:**
  - [ ] `grep '"upstream": "routed"' claude-code-boss/config/router-config.json` casa 1 linha (`/v1/messages`).
  - [ ] `grep "DEFAULT_ROUTES" claude-code-boss/servers/model-router/index.js` casa `routed` p/ `/v1/messages`.
  - [ ] `npm test` passa com `route-parity` verde; `node claude-code-boss/scripts/gate.mjs` passa.
  - [ ] `git diff -- claude-code-boss/config/router-config.json` mostra só G1 fix + comentário.

### Fase 2 — Validação de schema do overlay (G3)

- **Status:** `PLANNED`
- **Objective:** Validar cada entrada de `cfg.routes` (overlay) contra enums e ignorar só a rota malformada com warn.
- **Deliverable:**
  - `servers/model-router/index.js:187` `resolveRoutes(cfg, {warn}={})` — adiciona `validateRoute(path, ov)` puro interno:
    - `method` ∈ `{GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS}` (case-insensitive, normaliza p/ UPPER).
    - `upstream` ∈ `{passthrough, routed, /^local:(health|metrics|metricsReset|catalog)$/}` (allowlist fechada; `local:custom` → warn+ignora).
    - `auth` ∈ `{none, signature, loopback}` (default inferido por `pathname.startsWith('/v1/') ? 'signature' : 'none'` se ausente — valida se presente).
    - `path` normalizado via `new URL(path,'http://x').pathname` e deve começar com `/` (`//v1//messages` rejeitado).
    - Se inválido: `warn(path, reason)` injetável (default `logger.warn`) e `continue` (não adiciona ao `out`); retorna também `warnings[]` para teste hermético.
  - `servers/model-router/index.js:164` comentário de `mergeUserConfig` atualizado p/ mencionar validação downstream em `resolveRoutes`.
- **Verification:**
  ```bash
  node claude-code-boss/scripts/test-units.js 2>&1 | grep -i resolve-routes
  # {"/x":{method:"FOO",upstream:"passthrough"}} → ignorada
  # {"/y":{method:"GET",upstream:"local:health",auth:"bad"}} → ignorada
  # {"/z":{method:"get",upstream:"passthrough"}} → normaliza GET e adiciona
  # {"/health":null} → remove
  ```
- **Gate criteria:**
  - [ ] `resolve-routes.test.js` com ≥6 casos passa (incl. typo, null/false, custom válido, method case).
  - [ ] `logger.warn` chamado exatamente 1x por rota inválida (mock/spy).
  - [ ] `mergeUserConfig` + `resolveRoutes` com overlay malformado não derruba `createServer` (teste de não-throw).
  - [ ] `npm run gate` (lint + no-empty-catch) passa.

### Fase 3 — Auth declarativo enforceado (G2)

- **Status:** `PLANNED`
- **Objective:** Fazer `auth` da rota declarada ser enforceado no early dispatch (além de `loopback` em `metricsReset`).
- **Deliverable:**
  - `servers/model-router/index.js:2442` early dispatch — antes do `switch(upstream)`, inserir gate:
    ```js
    const auth = routeEarly.auth ?? (pathnameEarly.startsWith('/v1/') ? 'signature' : 'none');
    if (auth === 'loopback' && !isLoopbackHost(req)) { 403; return; }
    if (auth === 'signature' && !hasSignature(req.headers)) { res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({error:{type:'auth_error',message:'missing signature'}})); return; }
    // 'none' → passa
    ```
    + método 405 com `Allow: <routeEarly.method>` quando `!methodOk`.
  - Helper `hasSignature(headers)` — `!!(headers['x-api-key'] || headers['authorization'])` (Node lowercases headers; sem `Authorization` morto).
  - `config/router-config.json#routes` — documentar `auth` no `_comment` (já existe, mas alinhar com Fase 1).
- **Verification:**
   ```bash
  node claude-code-boss/scripts/test-units.js 2>&1 | grep -i route-auth
  # 401 para POST /v1/messages sem x-api-key, 200 com x-api-key, 403 para /metrics/reset remoto, 200 para /health sem header
  ```
- **Gate criteria:**
  - [ ] `test-units.js:route-auth` com 5 casos (401/403/200) passa; `Allow` em 405 coberto em 4b (não aqui).
  - [ ] `curl -i http://127.0.0.1:13456/v1/messages -X POST -H 'content-type: application/json' -d '{}'` sem `x-api-key` → `401` (não `404`/`502`).
  - [ ] `GET /health` sem header ainda `200` (regressão).
  - [ ] `isLoopbackHost` continua rejeitando `Origin` não-loopback.

### Fase 4a — Consolidação passthrough (G4d)

- **Status:** `PLANNED`
- **Objective:** Unificar `passthrough`/`passthroughGeneric` em alias fino; eliminar 2 impls divergentes.
- **Deliverable:**
  - `servers/model-router/index.js:2191` — `passthrough` vira alias: `function passthrough(...a){return passthroughGeneric('POST', ...a)}` (compat com testes que importam `passthrough`).
  - `servers/model-router/index.js:2212` `passthroughGeneric` aceita `_retried` e preserva retry 1x quando `pathOriginal.includes('count_tokens') && !_retried && !res.headersSent`.
- **Verification:**
  ```bash
  node claude-code-boss/scripts/test-units.js 2>&1 | grep -i passthrough
  # passthrough alias + generic, sem 2 bodies divergentes
  ```
- **Gate criteria:**
  - [ ] `grep -c "function passthrough" servers/model-router/index.js` == 2 (alias + generic) com `passthrough` sendo single-return.
  - [ ] `count_tokens` ainda tem retry 1x; `npm run gate` passa.

### Fase 4b — Limpeza de dispatch (G4c + G4e)

- **Status:** `PLANNED`
- **Objective:** Corrigir `includes('/messages')` e provar `effectiveConfig` idempotente; `405` com `Allow`.
- **Deliverable:**
  - Early dispatch usa `pathnameEarly` exato (já existe) e late fallback usa `routeEarly` lookup em vez de `req.url.includes('/messages')` substring; `GET /v1/messages` → 405 + `Allow: POST`, `GET /v1/messages_fake` → 404.
  - Não “extrair 1x” cfg entre early e `req.on('end')` (evita stale); manter `effectiveConfig` 2 chamadas intencionais + teste de idempotência.
- **Gate criteria:**
  - [ ] `grep "includes('/messages')" servers/model-router/index.js` == 0 fora de comentário/teste (ou só em `count_tokens` com `pathname`).
  - [ ] `dispatch-cleanup.test` (ou `test-units.js` http) prova `GET /v1/messages` → 405+Allow, `GET /v1/messages_fake` → 404.
  - [ ] `effectiveConfig(effectiveConfig(c,t),t) deepEqual effectiveConfig(c,t)` verde.

### Fase 4c — Documentar restart-required + idempotência (G4b) — hot-reload backlog

- **Status:** `PLANNED`
- **Objective:** Documentar que `user-config.json#routes` exige restart do daemon (MVP); `fs.watch` vai para backlog.
- **Deliverable:**
  - `_comment` em `router-config.json#routes` e `DEFAULT_ROUTES` doc: “overlay exige restart do model-router (kill + ensure)”.
  - Sem `fs.watch` nesta entrega; backlog mantém hot-reload.
- **Gate criteria:**
  - [ ] Doc atualizado; sem `fs.watch`/`watchFile` no `index.js`.
  - [ ] Teste idempotência `effectiveConfig` verde.

### Fase 4 — DEPRECATED — ver 4a/4b/4c acima (histórico; não executar; sem gate)

### Fase 5 — Cobertura, paridade e hardenings finais

- **Status:** `PLANNED`
- **Objective:** Fechar cobertura de testes do route-manager (paridade, 405/404, null/false, custom, warmCatalog, fingerprint) e garantir `npm run gate` + `release-audit` verdes.
- **Deliverable:**
  - Testes herméticos (em `claude-code-boss/tests/` ou `test-units.js`):
    - `DEFAULT_ROUTES` exportado em `module.exports` (já em `2833: DEFAULT_ROUTES, resolveRoutes, passthroughGeneric`) — teste importa e compara.
    - `resolveRoutes` — 6+ casos (disable, custom, typo, method case, auth).
    - `createServer` — `http.createServer` com `supertest`/`node:http` real: `405` + `Allow`, `404`, `401`/`403`, `local:catalog` em `/v1/models` quando overlay `local:catalog`, `passthrough` BYOK com `cooldownActive`.
    - `maybeWarmCatalog` chamado no `passthrough` early (spy).
  - `release-audit` / `pages-guard` não quebrados: `node .github/scripts/release-audit.mjs check` passa.
  - `docs/plans/route-manager.md` atualizado com decisões finais + DoD checklist marcado.
- **Verification:**
   ```bash
  npm test 2>&1 | tail -n 30
  node .github/scripts/release-audit.mjs check
  node claude-code-boss/scripts/test-units.js 2>&1 | grep -i route
  ```
- **Gate criteria:**
  - [ ] `npm test` verde (incl. `route-*` em `test-units.js`).
  - [ ] `node .github/scripts/release-audit.mjs check` → `OK` (ou só warnings advisory).
  - [ ] `test-units.js:route-*` cobre null/false/object/custom/invalid + método case (asserts de branch, sem `c8`).
  - [ ] `git diff --stat` mostra só `router-config.json` (G1) + `index.js` (validação/auth/consolidação) + `scripts/test-units.js` — nenhum arquivo fora do escopo.
  - [ ] Este `PLAN-route-manager.md` movido para `completed` (todas as fases 1/2/3/4a/4b/4c/5 `completed`).

---

## 8. Out of scope — explicit boundaries

- **Dashboard UI para editar `routes`**: fora deste plano; overlay é JSON manual em `DATA_DIR`. Dashboard pode ganhar UI depois (backlog).
- **ACL por tenant em rotas**: `resolveTenant`/`effectiveConfig` já existe (ADR-011), mas per-tenant `routes` não é escopo — `effectiveConfig` mergeia `routes` global, não por tenant.
- **Rate-limit por rota**: não faz parte do route-manager declarativo; `cooldown` continua global.
- **OpenAPI / JSON Schema externo**: validação é enum inline em `resolveRoutes`, não `ajv`/`zod` — evita dependência.
- **Remoção de `local:catalog` em `/catalog`**: `/catalog` permanece `local:catalog`; não migrar para `passthrough`.
- **Mudança de porta fixa**: `port:13456` e `routerToken` continuam como estão.
- **Geração de `DEFAULT_ROUTES` em build**: `DEFAULT_ROUTES` permanece literal em `index.js` + teste de paridade; não gerar em build.

### Backlog (pós-ship, não bloqueia DoD)

- [ ] UI no dashboard para CRUD de `routes` (com validação live).
- [ ] Suporte a `path` com `:param` (ex.: `/v1/models/:id`) — hoje só paths literais.
- [ ] Suporte a `upstream: "byok"` explícito vs `passthrough` genérico.
- [ ] Métrica `metricsSnapshot.routes` com hit count por rota.
- [ ] `ajv` schema formal em `config/router-config.schema.json` se o bloco `routes` crescer.

---

## 9. Provenance — links e fontes

| Fonte | Path/URL | O que prova |
|-------|----------|-------------|
| `router-config.json` shipping | `claude-code-boss/config/router-config.json:171-180` | 7 rotas, `_comment` com overlay docs |
| `DEFAULT_ROUTES` | `servers/model-router/index.js:177-185` | Espelho do shipping, divergência G1 (`routed` vs `passthrough`) |
| `resolveRoutes` | `servers/model-router/index.js:187-202` | Lógica pura de overlay (null/false/object/custom) |
| `mergeUserConfig` | `servers/model-router/index.js:156-171` | Shallow por `routes` |
| `passthroughGeneric` | `servers/model-router/index.js:2212-2234` | Genérico method-aware, `content-length` condicional |
| `createServer` early dispatch | `servers/model-router/index.js:2442-2539` | Declarativo com `405`/`404`, `byok.resolveUpstream` |
| `routerUserConfigPath()` | `scripts/lib/router-config-path.js` | Caminho global estável |
| `git diff` working dir | `git diff --stat` (12 files) + `git diff -- router-config.json/index.js` | Implementação já em working dir não commitada |
| Brain policies citadas | `b1fd6ad350e059bb` (out-of-scope→backlog), `22ddf81071d14a23` (fresh review round) | Injetadas via brain plugin |

---

## 10. Checklist de execução (para `sdd-phase-execute`)

- [ ] Fase 1 `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (G1 + paridade)
- [ ] Fase 2 `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (validação overlay)
- [ ] Fase 3 `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (auth declarativo)
- [ ] Fase 4a `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (consolidação passthrough G4d)
- [ ] Fase 4b `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (limpeza dispatch G4c+G4e, 405 Allow)
- [ ] Fase 4c `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (restart-required + idempotência G4b)
- [ ] Fase 5 `PLANNED` → `READY` → `to-verify` → `UNVERIFIED` → `completed` (cobertura + gate)

> **Regra de ouro SDD:** cada fase só avança se o gate anterior estiver verde com comando reproduzível. O working dir já contém Fase 0 (implementação base); este plano fecha os gaps sem reescrever o que já existe.

---

*Gerado por `sdd-planner` (subagent) — planning subagent for SDD pipeline. Read-only on code, writes `docs/PLAN-*.md`.*
