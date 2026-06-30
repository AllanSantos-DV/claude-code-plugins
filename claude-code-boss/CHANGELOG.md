# Changelog

## [Unreleased]

### Added — model-router: roteamento de modelo por peso do prompt (proxy local)

Um proxy HTTP local (`servers/model-router/`) que fica **entre o Claude Code e a
API da Anthropic**: classifica o "peso" de cada prompt com um embedder MiniLM local
e reescreve o campo `model` para rotear **haiku / sonnet / opus** dentro da própria
assinatura do usuário — o objetivo é **esticar a janela de acesso**, gastando opus só
quando o trabalho realmente pede.

- **Engine** (`servers/model-router/index.js`, `wrapper.cs`): bind em
  porta configurável (13456, com retry até +10), classificação local por âncoras de
  cosseno e estado/log em `DATA_DIR/model-router/`. A redireção é **isolada no Claude
  Code** pelo wrapper do `claude.exe` (C#), que injeta `ANTHROPIC_BASE_URL` **só no
  próprio processo**, lendo a URL de `~/.claude/model-router-url.txt` — porque o Claude
  Desktop ignora o bloco `env` do `settings.json` e **variáveis globais vazariam para
  outros apps**.
- **Ativação por hook** (`scripts/model-router-ensure.js`, `model-router-wrapper-install.js`):
  SessionStart + UserPromptSubmit compilam/instalam o wrapper, publicam a URL do proxy e
  sobem o servidor de forma idempotente — **sem nunca tocar em variáveis de ambiente globais**.
- **Dashboard + ativação guiada**: nova aba **Router** (toggle, chave NVIDIA mascarada,
  aceite de termos, status e banner de restart), rotas `/api/router/{config,status,apply}`,
  o slash command **`/dashboard`** e um aviso de primeira execução. A chave da NVIDIA
  vive **somente** em `DATA_DIR/model-router/user-config.json` (nunca versionada); a API
  devolve apenas `hasNvidiaKey` + os últimos 4 dígitos.
- **Plano B no limite excedido**: quando a janela do Claude esgota (HTTP 429), o proxy
  **não propaga o erro** — com chave NVIDIA, roteia para a NVIDIA NIM (OpenAI-compat),
  traduzindo Anthropic↔OpenAI em streaming e não-streaming, **sempre com um aviso de
  que a resposta veio da NVIDIA, não do Claude**; sem chave, devolve uma mensagem no
  formato Anthropic orientando rodar `/dashboard`. Configurável em `config.fallback`.
- **Classificador opus-averse** (`config.classifier`): calibrado com tráfego real, evita
  mandar prompt trivial pra opus (que era eleito quando nada casava). Piso de confiança
  global, barra mais alta para opus (score absoluto + margem) e rebaixamento para o
  melhor tier não-opus; tudo ajustável sem código.
- **Circuit breaker no limite excedido** (`config.fallback.cooldown`): evita a rajada de
  429 sem prender o usuário no plano B quando o Claude volta. **Reset determinístico,
  multi-fonte** (na ordem): headers do 429 (`retry-after` → `anthropic-ratelimit-unified-reset`
  → buckets) **e** — caso típico da **assinatura** (Claude Pro/Max) — o **reset embutido no
  CORPO da resposta**: o evento `rate_limit_event` (`rate_limit_info.status:"rejected"` +
  `resetsAt` em epoch) ou o marcador `Claude AI usage limit reached|<unix>[|tipo]`. O proxy
  agora faz um **"tee" leve do stream 200** (repassa verbatim ao cliente **e** escaneia esse
  sinal), porque a assinatura sinaliza a janela esgotada **dentro de um 200**, não só via 429.
  Achando o reset (header **ou** corpo), espera **exatamente** até lá (`source:'body'`/`'header'`).
  Só quando **nada** legível existe é que o 429 vira **esporádico** (janela deslizante): um 429
  isolado cai no plano B só naquela request e a **próxima já testa o Claude**; após `tripAfter`
  429s **seguidos** arma um cooldown **curto** (`noHeaderMs`, padrão 15s) e re-sonda —
  **qualquer resposta do Claude zera o contador** e retoma na hora. Todo 429 registra **captura
  diagnóstica** (todos os headers `anthropic-ratelimit-*` + preview do corpo) p/ travar a forma
  real no próximo limite. Estado persistido em `DATA_DIR/model-router/cooldown.json` (sobrevive a
  restart). Mensagens de plano B com dica **honesta**: "Claude volta ~HH:MM" quando há reset real
  (header/corpo); senão "reavaliando o Claude em ~Ns". Ajustável (`enabled`, `noHeaderMs`,
  `tripAfter`, `minMs`, `maxMs`).
- **Teto de modelo** (`config.routing.ceiling`, padrão ligado): o modelo escolhido no
  dropdown do Claude Code vira um **teto**, não uma sugestão. O classificador pode
  **rebaixar** livremente p/ economizar (ex.: opus→haiku num rename trivial), mas **nunca
  escala acima** do que o usuário pediu — se o prompt pareceria opus mas o usuário escolheu
  sonnet, mantém **exatamente** o modelo do usuário. Modelo desconhecido no dropdown → sem
  teto (segurança). Desligável com `routing.ceiling:false` (volta ao roteamento livre).
- **Telemetria de economia** (endpoint `/metrics`, aba **Router** do dashboard): contadores
  de requisições roteadas, classificadas, rebaixadas, bloqueadas pelo teto, servidas pelo
  Claude vs. plano B, cooldowns e tokens; e uma **economia estimada** por pesos de custo
  (proxy dos preços públicos: opus ~15× haiku, em `config.routing.costWeights`) — `baseline`
  = sempre o modelo do dropdown, `actual` = só o que o Claude de fato serviu (plano B conta
  custo-Claude zero). Persistida em `DATA_DIR/model-router/metrics.json` (sobrevive a restart),
  com `POST /metrics/reset` p/ zerar. Os pesos afetam **só o relatório**, nunca o roteamento.

### Fixed — model-router: 429 de concorrência não trava mais o plano B com o Claude vivo

- **Falso-positivo do cooldown de palpite** (`config.fallback.cooldown.probeSuppressMs`,
  padrão 30s): o Claude Code dispara **várias requisições em paralelo** por turno e a
  Anthropic devolve **429 de concorrência** (corpo `rate_limit_error` genérico, **sem**
  reset em header/corpo) p/ algumas enquanto **serve 200** p/ outras. O heurístico
  headerless contava esses 429 como "janela esgotada" e, após `tripAfter`, armava um
  cooldown que mandava **tudo** pro plano B por ~15s — e re-armava a cada turno, deixando
  o usuário **preso no plano B mesmo com o Claude disponível**. Agora há dois guardas: (1)
  um 429 **sem reset legível** é **ignorado** (não conta, não arma) se o Claude respondeu
  **200 nos últimos `probeSuppressMs`** — é concorrência, não janela; (2) um **200 limpo**
  **derruba na hora** um cooldown de **palpite** já armado por uma rajada concorrente. Os
  cooldowns **autoritativos** (reset real via header/corpo) seguem armando **imediatamente**
  e **não** são afetados — só a heurística de último recurso deixou de dar falso-positivo.
- **Parâmetro `effort` reconciliado por modelo ao rebaixar** (corrige `400 ... does
  not support the effort parameter` e o erro de valor inválido entre modelos): o
  `effort` (Anthropic) vive em **`body.output_config.effort`** e tem **escala própria
  por modelo** — pela doc oficial, **Opus 4.8/4.7** têm `xhigh`; **Sonnet 4.6/Opus 4.6**
  têm `max` mas **não** `xhigh`; **Haiku 4.5 não suporta `effort`**. Quando o usuário
  escolhe Opus 4.x com nível de _effort_ e o router **rebaixa** o modelo (teto/economia),
  não dá p/ "passar reto" (Sonnet rejeita `xhigh`) nem "stripar cego" (jogaria fora um
  `effort` válido no Sonnet). Agora `reconcileEffort` resolve contra o **modelo de
  destino**: **mantém** se o destino aceita o valor, **clampa** p/ o maior suportado
  (ex.: Opus `xhigh` → Sonnet `high`) quando suporta `effort` mas não aquele valor, e
  **remove** só quando o destino não tem `effort` (Haiku). Modelo **mantido** pelo teto
  preserva o `effort` intacto. A matriz é **configurável** (`routing.effort.{order,support}`,
  match por prefixo cobre sufixo de data) e a decisão é logada (`Roteado.effort`). O plano
  B já era imune (monta o próprio body OpenAI).
- **Isolamento total no Claude Code (sem vazamento global)**: o mecanismo antigo definia
  `NODE_OPTIONS` e `ANTHROPIC_BASE_URL` no **escopo User do Windows** — variáveis
  **machine-wide** que **vazavam para outros apps** (ex.: GitHub Copilot/hermes) e corrompiam
  o launch deles (`NODE_OPTIONS` com aspas quebrava `--settings`; `ANTHROPIC_BASE_URL` apontando
  p/ porta morta gerava "Solicitação falhou"). Agora o roteamento é **exclusivo do Claude Code**:
  o `ensure.js` publica a URL do proxy em `~/.claude/model-router-url.txt` e o **wrapper do
  `claude.exe`** injeta `ANTHROPIC_BASE_URL` **apenas no próprio processo** (lendo esse arquivo).
  O hook **nunca** define env global e ainda faz **self-heal**, removendo qualquer
  `NODE_OPTIONS`/`ANTHROPIC_BASE_URL` global residual e o patcher órfão de versões antigas;
  quando o router para ou é desabilitado, o arquivo de URL é **apagado** (o wrapper nunca injeta
  porta morta — auto-cura). O mecanismo `patcher.js`/`NODE_OPTIONS` foi **aposentado**
  (sem nenhum `require` vivo; substituído pelo wrapper). O **quoting de argumentos** do
  wrapper foi corrigido para o algoritmo canônico `CommandLineToArgvW`, preservando o JSON
  de `--settings` (antes uma flag com espaços/aspas era remontada errada).

## [1.10.0] — 2026-06-15

### Added — curation "one-hit" marking with a recurrence ceiling

The curation Stop hook re-fired on **one-hit** commands (single-use, e.g. a one-off
`git log`): detection was output-VOLUME only, with no notion of recurrence, and the
only sanctioned "skip" — a text-only "it's one-shot, moving on" reply — was treated
as no-progress and escalated. So a genuinely single-use command got blocked up to
`maxAttempts` times, every time it appeared.

Now the agent can **mark a command one-hit** so the Stop hook stops asking to curate
it — but it can't become a cheap bypass:

- **Added** the `curation_mark_oneoff` MCP tool — the agent passes the command's
  `aliases` (the SAME forms it would register when curating, so marking costs the
  same work as doing it right). A 1-token alias (e.g. `git`) is rejected — it would
  silence unrelated subcommands.
- **Added** `scripts/lib/command-signature.js` — a canonical signature that
  normalizes `cd …`, env assignments, wrappers (`bash -c`, `pwsh -File`, …), pipes
  and flags, so the same command isn't fragmented by cwd or masked by variation
  (`cd /p && git --no-pager log -5` → `git log`).
- **Added** `scripts/lib/oneoff-store.js` — a per-project store (in the data dir,
  not the versioned `shells.json`) counting every matching invocation in a sliding
  window. Past the configurable ceiling the marking is **refused** — a recurring
  command must be curated; one-hit can't silence it forever. Overlapping markings
  merge (no count fragmentation); cold entries are pruned.
- **Changed** `curation-detect.js` — counts recurrence and **suppresses** valid
  one-hit markings at the source (they never reach the Stop list).
- **Changed** `curation-stop.js` — the block reason is now **oriented**: each
  command shows its signature and `count/ceiling`, plus the two ways out (curate or
  `curation_mark_oneoff`), so the agent decides on data, not a guess.
- **Added** `curation-session.js` (SessionStart) — prunes cold entries and injects a
  short curation panorama (how many curated scripts + one-hits the project tracks).
- **Config** `curation.oneHitMaxRecurrence` (default 3) + `curation.oneHitWindowDays`
  (default 90) in `brain-config.json`.

### Changed — unified quality gate (`npm run gate`)

Local and CI now run the **same** gate (`npm run gate`): ESLint over `scripts/` AND
`servers/`, version-sync, and the test suite. The catch-masking checks moved from
GNU-only CI greps to an AST ESLint rule (`no-silent-return-catch`) — cross-platform
and finally covering the brain-server. The CI workflow just calls the gate, so "lint
passed locally but a separate CI grep failed" can't happen again.

### Fixed

- Return-only `catch { return … }` blocks in the brain-server daemon + `searchIsolated`
  now log/acknowledge the error before returning (CI gate).
- Plugin README: the hooks table referenced the deleted `brain-retrieve-prompt.js`;
  it now points to the `mcp_tool` → `brain_retrieve_context` warm retrieval. Added a
  dedicated `servers/brain-server/README.md` (transports, daemon, config).

## [1.9.0] — 2026-06-14

### Added — brain-server can run as a long-lived HTTP service (additive, opt-in)

The brain-server (MCP) was stdio-only: every host connection spawned its own
process + ~118MB model, all competing for the same SQLite, and external consumers
(e.g. OpenCode) had to point at the rotating-SHA plugin cache (unstable; the brain
vanished when the SHA was cleaned). It can now ALSO run as a single long-lived HTTP
daemon (StreamableHTTP, **stateful**) shared by N workspaces/clients — one model,
one SQLite.

**stdio stays the default and behaves exactly as before** — no reinstall and no
`.mcp.json` change for Claude Code users.

- **Added** `servers/brain-server/lib/mcp-server.js` — `createBrainServer()`, the
  transport-agnostic MCP assembly (tools + handlers) reused by both transports. An
  async mutex serializes the KB tools so concurrent HTTP sessions can't corrupt the
  process-singleton DB. Tool logic is a faithful move from `index.js` (no stdio
  behavior change).
- **Added** `servers/brain-server/lib/http-daemon.js` — `--http` daemon: stateful
  StreamableHTTP (a per-session `createBrainServer` keyed by `mcp-session-id`),
  `/health`, `/mcp`, port-as-singleton-lock, idle-session reaper, graceful
  `/shutdown` (forces keep-alive connections closed).
- **Added** `servers/brain-server/lib/daemon-supervisor.js` + `daemon-common.js` —
  the stdio launcher best-effort auto-starts the daemon (detached, survives the
  host) and, on a plugin update, **version-swaps a stale daemon for the new one**
  (lock in `DATA_DIR` + `/health` `pluginRoot` check). Disable with
  `BRAIN_HTTP_AUTOSTART=0`.
- **Changed** `servers/brain-server/index.js` — now a thin transport selector:
  stdio by default (`StdioServerTransport`); `--http [--port N | env
  BRAIN_HTTP_PORT]` runs the daemon. Project scoping: **stdio infers from CWD
  (unchanged); HTTP requires an explicit `project`** and rejects otherwise (never
  falls back to `'default'`).

**Migration — point an external consumer (e.g. OpenCode) at the daemon:** set
`BRAIN_HTTP_PORT` to a known value, then configure the consumer with a remote MCP
endpoint `http://127.0.0.1:<port>/mcp` (and always pass an explicit `project` per
call). Claude Code keeps using stdio via the unchanged `.mcp.json`. The two modes
share the same SQLite/KB.

### Added — warm adaptive retrieval auto-injected on every prompt

The Brain now feeds relevant lessons into context automatically. A new
`brain_retrieve_context` tool — called by a `mcp_tool` `UserPromptSubmit` hook —
embeds the prompt in the warm server (~26 ms), vector-searches behind an adaptive
relevance gate, federates `project` + `__user__` scopes, dedups by title, and
injects a short `[BRAIN]` block. No per-tool-call cold retrieval.

- **Added** `scripts/lib/retrieve-core.js` + the `brain_retrieve_context` brain-server
  tool (embed → two-pass scope search → relevance gate → title-dedup →
  `hookSpecificOutput.additionalContext` envelope, the only form a UserPromptSubmit
  `mcp_tool` hook injects).
- **Changed** `hooks/hooks.json` — `UserPromptSubmit` calls the `mcp_tool` hook
  against `plugin:claude-code-boss:brain-server` (warm embedder) instead of a cold
  per-call script. The relevance gate was calibrated (`0.45 → 0.20`, measured against
  the embedder's real score distribution) and retrieval now federates the global
  `__user__` scope (parity with `brain_search`, via an isolated read connection so
  the warm server's singleton isn't churned).

### Fixed — KB entries vectorized by title+summary, not the (diluting) detail

Including the long, dense `detail` in the embed text diluted the vector below the
retrieval gate (measured cos **0.51** for `title+summary` vs **0.13** for
`title+summary+detail` on the same entry/query) — so even an exact-title match
wasn't retrieved.

- **Added** `scripts/lib/embed-text.js` (`buildEmbedText`) as the single canonical
  embed-text builder, used by `capture_lesson`, `brain_store`, `brain-index-native`,
  and `brain-reembed`. `detail` is still stored and shown on retrieval; it just no
  longer steers the vector. Existing entries migrate by re-running `brain-reembed`.

## [1.8.3] — 2026-06-13

### Fixed — hooks now use exec form so plugin paths survive Windows shells

Every handler in `hooks/hooks.json` was in **shell form**
(`"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/x.js\""`). On Windows, Claude
Code runs shell-form hook commands through **Git Bash** (or PowerShell when Git
Bash is absent), which tokenizes the string and can mangle `${CLAUDE_PLUGIN_ROOT}`
or a path containing spaces. Per the Claude Code hooks reference, the fix is
**exec form**: set `args`, and `command` is spawned directly with no shell, so each
path is passed verbatim on every platform.

- **Changed** `hooks/hooks.json` — all 27 handlers converted to exec form
  (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/x.js"]`). No shell
  tokenization on any platform; `node` is a real binary that resolves on PATH
  everywhere.
- **Changed** `scripts/config-testers/hooks.js` — the validator now extracts the
  script path from `args` (exec form) as well as the `command` string (shell form),
  so the on-disk/syntax checks still cover every hook.
- **Changed** `scripts/dashboard.js` — the Hooks tab parses both forms (shared
  `hookScriptPath` / `hookDisplayCmd` helpers); previously exec-form hooks showed
  as inactive with no script name.
- **Added** exec-form coverage to `scripts/test-units.js`.

### Added — brain-health surfaces the JSON-fallback (degraded SQLite) state

When neither `node:sqlite` (Node < 22.13) nor `better-sqlite3` is available, the
Brain silently falls back to a JSON store (no metrics, dashboard count = 0). The
SessionStart probe now reports this via `getSqliteBackend() === 'none'` with the
running Node version and the upgrade path. (A *missing* Node can't be detected by
a Node hook — if `node` is off PATH the hook never spawns; see
anthropics/claude-code#66183, #35175 — that case is covered in docs.)

- **Changed** `scripts/brain-health.js` — adds a degraded-SQLite advisory
  (SessionStart only, ahead of the embedder/pending-drafts notices).

### Docs — Node on the system PATH is the #1 prerequisite

- **Changed** root `README.md`, `claude-code-boss/README.md`, and the
  `plugin-install` skill — lead with **Node ≥ 22.13 on the system `PATH`** and the
  real cause of "it only works on your machine": Claude Code spawns plugin hooks
  and MCP servers with bare `node` from the **system PATH**, not the Node bundled
  in Claude Desktop (anthropics/claude-code#66183, #35175). No system Node → hooks
  no-op and the Brain MCP is DOWN (`spawn node ENOENT`). Added troubleshooting rows
  and corrected the hooks summary (7 events, 24 scripts).

## [1.8.2] — 2026-06-13

### Fixed — brain-index crashed on keywords colliding with `Object.prototype`

`brain-index.js` stored its inverted index in plain objects and tested presence
with `if (!_index.keywords[kw])`. For a keyword equal to an `Object.prototype`
member (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) this returned
the inherited method, skipped the array initialization, and threw
`x.includes is not a function` — silently breaking the keyword index for any entry
whose text contained such a technical term (and thus dropping it from keyword
search).

- **Changed** `scripts/brain-index.js` — the `keywords` / `tags` / `projects` /
  `types` maps are now prototype-less (`Object.create(null)`), both on creation
  and when loading an existing `index.json`, so no keyword can collide with a
  built-in member.

## [1.8.1] — 2026-06-13

### Fixed — Brain MCP was DOWN on fresh install (brain-server deps not installed)

The brain-server is a separate package (`servers/brain-server/`, ESM) whose only
dependency is `@modelcontextprotocol/sdk`. The postinstall installed the plugin
root but never the brain-server, so on any fresh install (marketplace or the
install-local cache) `node_modules` was missing there and the MCP server
(`brain_search` / `brain_store` / `capture_lesson`) failed to start. The
`.mcp.json` `NODE_PATH` points at the root `node_modules`, which does not contain
the SDK either.

- **Changed** `scripts/plugin-setup.js` — postinstall now installs the brain-server
  deps (`npm install` in `servers/brain-server/`) when missing; loud but non-fatal
  on failure. `brain-health` already surfaces the defect, so a miss is visible.

## [1.8.0] — 2026-06-13

### Changed — embedding model is now part of setup (not silently optional)

The embedder powers semantic search **and** the pattern→skill learning loop
(dedup→recurrence needs vectors). It was treated as silently optional: the model
downloaded lazily on first use, into a cache inside `node_modules` (wiped on
reinstall), with no setup step and no health visibility — so the learning loop
could die invisibly. Now it is a verified, durable part of setup.

- **Added** `scripts/brain-warm.js` + `npm run setup:brain` — downloads and
  verifies the model (test embed → checks dimensions). Idempotent; one-time
  migration copies an existing model out of the legacy `node_modules` cache
  instead of re-downloading.
- **Changed** `scripts/plugin-setup.js` (postinstall) — now warms the embedding
  model after deps. Internet is assumed (the plugin was just fetched online).
  Skipped in CI and via `CLAUDE_SKIP_EMBED_WARM=1`; non-fatal but LOUD on failure
  (the model also fetches lazily on first use).
- **Changed** `scripts/brain-embedder.js` — model cache moved to a durable,
  user-level path (`<CLAUDE_PLUGIN_DATA>/models/`) via `transformers env.cacheDir`,
  so it survives `node_modules` deletion/reinstall.
- **Changed** `scripts/brain-health.js` — SessionStart now surfaces a soft advisory
  when the model is not downloaded (cheap filesystem check, no model load),
  instead of skipping the embedder entirely.
- **Docs** — README + `plugin-install` skill reframe the embedder as REQUIRED for
  full value (no longer "optional/degrades"), with the durable cache and
  `npm run setup:brain` documented.
- **Investigated** transformers→`sharp`: confirmed `sharp` is a hard, eagerly-imported
  native dependency of `@xenova/transformers` in **all** versions (v2/v3/v4) — a
  version bump cannot remove it. It ships prebuilts for mainstream platforms (no
  compiler on a normal `npm install`). `brain-warm` now hints at `npm rebuild sharp`
  on a sharp failure, and the `plugin-install` skill documents the `ollama`/`voyage`
  escape hatch for platforms without a prebuilt.

### Changed — SQLite backend is now Node's built-in `node:sqlite` (zero native deps)

Makes the plugin install and run on any machine with a modern Node — no C/C++
build toolchain, no `node-gyp`, no native compilation. Previously the Brain KB
required the native `better-sqlite3` addon, which failed to compile on fresh
machines (no Build Tools) and on newer Node without a prebuilt binary, silently
degrading the KB.

- **Added** `scripts/lib/sqlite-compat.js` — backend-agnostic loader. Prefers the
  built-in `node:sqlite` (Node >= 22.13), falls back to a compiled `better-sqlite3`
  only if already present, then to the JSON store. Bridges the API deltas
  (`readonly` → `readOnly`, no `.pragma()` → routed to `exec`, BLOB → `Uint8Array`)
  and suppresses the benign `node:sqlite` ExperimentalWarning. Never throws.
- **Changed** `package.json` — removed the required native `better-sqlite3`
  dependency and the unused native `sharp` optional dependency; added
  `engines.node >= 22.13.0`. The plugin now declares **no native dependency**.
- **Changed** `scripts/brain-store.js`, `brain-reembed.js`, `dashboard.js`,
  `test-hooks.js` — load SQLite through the adapter. `brain-reembed.js` previously
  hard-required `better-sqlite3` with no fallback; it now works on `node:sqlite`.
- **Fixed** `brain-store.js` `blobToVector` — honors `byteOffset` so Float32
  vectors round-trip correctly from a `Uint8Array` (node:sqlite) as well as a
  `Buffer` (better-sqlite3).
- **Fixed** `brain-store.js` `save()` — now returns the entry id. A latent bug
  returned `undefined`, breaking `brain-backend.saveLocal` (`get(undefined)` under
  the stricter `node:sqlite` binding) whenever the embedder was ready.
- **Changed** `scripts/plugin-setup.js` — reinstalls only when `node_modules` is
  missing (no longer hinges on the optional `sharp` probe); warns on Node < 22.13.
- **Changed** CI — test matrix bumped from Node 20 to Node 22 + 24 (Node 20 lacks
  `node:sqlite`).

### Added — `plugin-install` skill

Clear, machine-agnostic install + troubleshooting workflow: missing `node_modules`,
`gyp ERR` / Build Tools errors (no longer needed), old Node → JSON fallback, and
install verification via `getSqliteBackend()`.

## [1.6.0] — 2026-05-31

### Changed — brain-indexer trigger refactored to in-loop Stop pattern

Replaces the UserPromptSubmit advisory (which the LLM routinely ignored, letting
the pending backlog grow to 389+ payloads) with a blocking Stop hook that emits
`decision:"block" + reason` directly to the main agent. Same pattern as
`pattern-detect.js` and `curation-stop.js`: the main agent has live turn context
and a Task tool, so it can launch `brain-indexer` immediately.

- **Added** `scripts/brain-stop.js` — Stop hook with per-session state file
  (`.runtime/brain-stop-<sid>.json`) tracking `{attempts, lastPendingCount,
  firstBlockedAt}`. Progress detection: if pending dropped vs last block, the
  agent processed payloads — clear state and release. Escalating reason across
  attempts (informative → `[RETRY N/M]` forceful → `[FINAL RETRY]` literal Task
  call). Safety cap via `brainStop.maxAttempts` (default 3) prevents UX
  lock-up.
- **Updated** `agents/brain-indexer.agent.md` — `maxTurns 10 → 20` and
  two-phase workflow (Phase 1 admission triage up to 100 files using Step 0;
  Phase 2 indexes cap 30 admitted files through Steps 1-5).
- **Updated** `scripts/brain-retrieve-prompt.js` — advisory line silenced when
  `pending >= brainStop.threshold` (the Stop hook owns the trigger from there).
- **Config** `config/hooks-config.json` — added
  `brainStop: { enabled: true, threshold: 10, maxAttempts: 3 }`.

### Changed — brain-submit admission gates tightened

Cuts payload volume by rejecting trivial captures before they reach the queue.

- **Added** `TRIVIAL_COMMAND_PREFIXES` blacklist in `scripts/brain-submit.js`
  (git status/log/diff/show/branch/remote, ls/dir/pwd/cd/echo/whoami/date/
  hostname/cat/type/head/tail/less/more/which/where/env/printenv) — rejected
  before any other gate.
- **Wired** `minBashLines: 3` gate (was unused in config).
- **Config** `config/brain-config.json` — `minOutputChars 500 → 1500`.

### Added — dashboard surface for brain-stop

- **`dashboard/index.html`** — replaced the dead "Auto-Trigger de Agentes"
  card with a live "Brain Indexer Auto-Trigger" card bound to
  `brainStop.enabled` and `brainStop.threshold` (render + save handlers).

### Fixed — LLM-facing strings translated to English

Hook `reason` / `additionalContext` fields and skill/agent prose are injected
verbatim into the model's context. Mixed-language injection wastes tokens and
weakens instruction following. Audit pass translated remaining PT-BR strings
to terse English; human-facing docs (README, CHANGELOG, plan files) stay in
PT-BR.

- `scripts/brain-stop.js` — reasons in English, no cost noise.
- `scripts/curation-stop.js` — reason in English.
- `scripts/curation-guard.js` — three block/warn reasons translated; the
  build-tool warning also fixed semantically (it claimed "the system will
  auto-create a curated script", which never happens — now correctly states
  the Stop hook will block and require the agent to create one before ending
  the turn).
- `scripts/brain-retrieve-prompt.js` — "Conhecimento relevante encontrado"
  → "Relevant knowledge found".

### Tests

- `scripts/test-hooks.js` — 37/37 passing. New coverage: 8 brain-stop cases
  (no-pending, below-threshold, first-block, retry-no-progress-escalate,
  retry-progress-detected, max-attempts-relent, disabled) and 4 brain-submit
  trivial/significant/min-lines cases.

## [1.5.0] — 2026-05-31

### Changed — curation loop refactored to in-loop Stop pattern (BREAKING)

Replaces the curation-improver subagent + UserPromptSubmit backlog injection
with an in-loop Stop hook that emits `decision:"block" + reason` directly to
the main agent. Same pattern as `pattern-detect.js` (commit `bff3e40`,
`refactor(brain): in-loop lesson capture`). The main agent has live turn
context — a fresh subagent did not — so it creates better curation scripts.

- **Removed** `agents/curation-improver.agent.md` — subagent eliminated.
- **Removed** `scripts/curation-backlog.js` + its UserPromptSubmit hook entry —
  backlog mechanism no longer needed (no subagent to wake up).
- **Added** `scripts/curation-stop.js` — Stop hook reads per-turn state and
  emits a block+reason instructing the main agent to read the new skill and
  author a `.mjs` curator. Anti-loop via `stop_hook_active` guard.
- **Added** `skills/curation-script-pattern/SKILL.md` — migrated from the
  deleted agent's instructions. Loaded on-demand when the Stop hook references
  it by path; documents the `.mjs` template, OK/FAIL contract, `shells.json`
  schema, and `outputFilter` cheatsheet.
- **Rewrote** `scripts/curation-detect.js` — instead of writing per-event
  payload files to `data/detect-curation/`, appends entries to a single
  per-turn state file at `data/.runtime/curation-turn-<sessionId>.json`.
  Entries dedup'd by `command+reason`, capped at 50/turn.
- **Config** `config/hooks-config.json` — added `curationStop.enabled: true`.

### Migration

The directory `data/detect-curation/` (runtime, outside the repo) is no
longer written or read. Existing payload files there can be deleted; they
were only consumed by the now-removed subagent + backlog hook.

## [1.4.0] — 2026-05-31

### Fixed — hooks correctness pass + MCP brain_store orphan bug

- **`curation-guard.js`** — hook output format was wrong: returned top-level
  `permissionDecision: "allowed"|"denied"` (silently ignored by Claude Code).
  Now returns the correct `hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "allow"|"deny", permissionDecisionReason }` per the official
  hooks reference. Auto-approve of whitelisted commands and deny of blacklisted
  ones likely never worked before. Also removed `pwsh`/`powershell`/`bash` from
  `BUILD_TOOLS` (those are shells, not build tools — were triggering false-positive
  warnings).
- **`brain-retrieve.js`** — `STOP_WORDS` was declared after its first use (TDZ).
- **`refine-research.js`** — rewritten with `EVERY=4` throttle via state file
  (matches `pattern-detect`'s pattern); removed dead ref to deleted `octopus.agent.md`;
  `stop_hook_active` anti-loop guard preserved.
- **`hook-logger.js`** — log rotation switched to probabilistic trim (~1%) instead
  of read+rewrite on every append (was O(n) per log line).
- **`hooks/hooks.json`** — explicit per-hook `timeout` (5–10s) replacing implicit
  defaults; better failure semantics.
- **`servers/brain-server/index.js` `brain_store` handler** — wrong call signatures:
  `kbIndex.index(id, keywords)` and `kbGraph.registerNode(id, type)` were silent
  no-ops (canonical signature is `(entry)`). Entries saved via MCP `brain_store`
  were **orphans** — not in the keyword index, not in the citation graph. Now
  builds embedding upfront and calls `save(entry, vector)` + `index(entry)` +
  `registerNode(entry)` in one pass. `capture_lesson` already used the correct
  signatures.
- **`README.md` (root)** — MCP tool count corrected from 5 to 7 (was omitting
  `research_query` and `research_status`).

### Tests

- `scripts/test-hooks.js` — 26/26 green, covers all hook events including
  `curation-guard` whitelist/blacklist/denyUnknown matrix and `refine-research`
  throttling.

### Added — Brain hygiene + in-loop learning (the differentiator)

- **Admission control (A-MAC)** in `brain-indexer` — admit/merge/skip gate; merge
  bumps a new `recurrence` column (migrated in place). Stops duplicate accumulation.
- **Rerank with decay** in `brain-store.search` — combined score (relevance +
  recency + frequency + confidence), Generative Agents pattern. Configurable via
  `kb.rerank`. Zero schema change.
- **Prune/eviction** (`brain-store.prune`) — graceful archive (not delete) to
  `entries_archive`; stale + over-capacity, utility = AMV-L/Priority Decay.
- **Native memory indexing** (`brain-index-native.js`) — indexes Claude's native
  Auto Memory (`~/.claude/projects/<cwd>/memory/*.md`) into the Brain for semantic
  + cross-project search the native layer lacks.
- **Skill promotion** (`brain-promote.js`) — recurring lessons → global skills
  (Voyager skill-induction); curated: scan→draft(staging)→approve. Never auto-spam.
- **`capture_lesson` MCP tool** — in-loop curated lesson capture with inline
  admission control. Replaces post-hoc transcript-parsing analyzers.

### Removed — token-villain cleanup

- **`pattern-analyzer` + `correction-analyzer` subagents** — re-read raw transcripts
  on a premium model (~50k/run, 96% noise). Replaced by in-loop `capture_lesson`
  (~200 tokens). `correction-detect`/`pattern-detect` are now lean advisory nudges
  (no transcript reading, no payloads). `brain-indexer` pinned to `haiku`.
- **`pattern-detection` skill** + its `hooks-config.json` keys (`patternDetect`,
  `correctionDetect`) — obsolete after the in-loop redesign.

### Changed — slim-down refactor (Brain + Curation focus)

O plugin foi reduzido ao que o Claude Code nativo **não** entrega. A camada de
orquestração (que reimplementava em prompt o Agent/Workflow nativo) foi removida;
ficaram **Brain KB** (busca semântica), **Curation** (anti context-bloat) e a
camada de **aprendizado** (captura advisory de padrões/correções).

- **Removidos (camada A — orquestração):** agente `octopus` (a main session volta
  ao loop nativo), `pipeline-executor`, os 7 agentes-clone (researcher, implementor,
  validator, reviewer, planner, debugger, documenter), `model-router` + `cost-tracker`
  + `ack-tracker` + `discipline-guard`, `boss-server` (MCP), configs
  `model-router.json` / `pipelines.json`, e skills `octopus-coordination`,
  `multidev-orchestration`, `pipeline-delegation`, `billing-awareness`,
  `code-review-standards`.
- **`settings.json`:** removido `"agent": "octopus"` — sem orquestrador próprio.
- **Camada B (aprendizado) — mantida e corrigida:** hooks agora são **advisory**
  (sem "MANDATORY/you MUST") com **backpressure** (cooldown + cap de contagem).
  `lesson-inject` foi fundido em `brain-retrieve-prompt` (injeção de lessons +
  advisory de pendências).
- **Dashboard:** enxugado para 4 abas (Home, Brain KB, Hooks, Logs); não auto-inicia
  mais no SessionStart (lançar sob demanda).
- **hooks.json:** de 6 eventos/15 scripts para 5 eventos/~9 scripts.

### Removed

- **`plugin-updater.js`** and **`plugin-version.json`** — custom plugin update mechanism removed.
  The root cause was a fixed `"version"` string in `plugin.json` that prevented the Claude Code
  native resolver from detecting new commits. Removing that field (D1) makes the official
  `/plugin update` command work correctly — no custom updater needed.

- **`install-local.js`** — replaced by `dev-claude.ps1` / `dev-claude.sh` wrappers that use
  the official `claude --plugin-dir <path>` flag for local development.

### Migration notes for existing installs

If you had a previous version of this plugin installed, you may have orphaned files in
`~/.claude/plugins/data/claude-code-boss/`. These are safe to delete manually:

```
~/.claude/plugins/data/claude-code-boss/updater.lock
~/.claude/plugins/data/claude-code-boss/plugin-update-check.json
~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```

To clean all at once (PowerShell):
```pwsh
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\updater.lock" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\plugin-update-check.json" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.claude\plugins\data\claude-code-boss\.payload-cleaned" -ErrorAction SilentlyContinue
```

Bash/zsh:
```bash
rm -f ~/.claude/plugins/data/claude-code-boss/updater.lock \
      ~/.claude/plugins/data/claude-code-boss/plugin-update-check.json \
      ~/.claude/plugins/data/claude-code-boss/.payload-cleaned
```
