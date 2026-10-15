# Motor compartilhado (engine core)

O núcleo do Boss que não depende do Claude Code — memória (KB, embedder, recall), métricas,
id de projeto, primitivas de curadoria, políticas e o cliente MCP — mora em `engine/` e é
listado em [`ENGINE-MANIFEST.json`](../ENGINE-MANIFEST.json), para outros hosts (codex-boss,
OpenCode, Copilot) usarem os mesmos arquivos em vez de reimplementá-los.

## Fronteira

- A pasta é a fronteira: todo arquivo listado mora em `engine/` (a exceção são os dois arquivos
  de `scripts/lib/mcp-bootstrap/` que o cliente MCP usa — essa pasta já é vendorizada por conta
  própria, com URL pública fixa), e nada em `engine/` fica fora da lista.
- Nenhum arquivo da lista puxa, nem por dependência, um adaptador do Claude Code
  (`hook-io`, `hook-context`, `hook-tools`, `hook-prefix`, `hook-owner`, `session-root`,
  `crash-evidence`).
- `process.env.CLAUDE_*` só é lido pelos dois pontos de configuração do host:
  - `engine/lib/data-dir.js` — diretório de dados (abaixo);
  - `engine/lib/brain-config.js` — caminho da config de fábrica (`CLAUDE_PLUGIN_ROOT`, com o
    diretório do próprio arquivo como padrão).
- O formato do transcript e do payload de hook é do Claude Code e fica fora do motor
  (adaptador por host).

## Parâmetros do host

- **Diretório de dados, por chamada.** Os stores recebem `dataDir` na chamada:
  `brain-store`/`brain-index`/`brain-graph` em `init({ project, dataDir })` (e
  `brain-store.searchIsolated(project, vec, { dataDir })`), `metrics-store` em
  `init({ project, dataDir })`, nas leituras isoladas e em `listProjects({ dataDir })`,
  `recall-health` em `record(reason, detail, ms, arms, { dataDir })` / `getStatus({ dataDir })`,
  `scope-search.userDbExists({ dataDir })`. Sem `dataDir`, cada módulo resolve `dataDir()` no
  primeiro uso e mantém (um daemon não segue um ponteiro movido no meio da vida).
  `data-dir.setDataDir(dir)` continua valendo como padrão do processo inteiro.
- **Raiz do projeto, por chamada.** `metrics.record(event, payload, { projectRoot })`;
  `project-id` já recebe `cwd`/`env`/`sessionRoot` por parâmetro em cada função.
- **Env da chamada.** `engine/lib/host-env.js` devolve o env que o motor lê (`process.env` por
  padrão). Um host que atende várias sessões num processo registra uma visão por chamada com
  `setHostEnv(fn)` — o adaptador do Claude Code (`scripts/lib/hook-context.js`) faz isso ao ser
  carregado; o motor nunca o exige.

Os testes `engine:` em `scripts/test-units.js` provam a fronteira, o fechamento de `require`,
o `dataDir` por chamada e o `host-env`.

## Vendorização

O mesmo mecanismo do `lib/mcp-bootstrap/`, generalizado para qualquer lista de arquivos:

```
node scripts/lib/mcp-bootstrap/sync.js stamp --manifest ENGINE-MANIFEST.json      # upstream, depois de editar um arquivo listado
node scripts/lib/mcp-bootstrap/sync.js check --manifest ENGINE-MANIFEST.json [--upstream <url|caminho>]
```

`check` falha (saída 1) com os arquivos editados, ausentes ou atrás do upstream; CRLF não conta.
Uma cópia nunca é editada no lugar: copie de novo do upstream.
