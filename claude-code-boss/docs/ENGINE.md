# Motor compartilhado (engine core)

O núcleo do Boss que não depende do Claude Code — memória (KB, embedder, recall), métricas,
primitivas de curadoria, políticas e o cliente MCP — é listado em
[`ENGINE-MANIFEST.json`](../ENGINE-MANIFEST.json), para outros hosts (codex-boss, OpenCode,
Copilot) usarem os mesmos arquivos em vez de reimplementá-los.

## Fronteira

- Nenhum arquivo da lista puxa, nem por dependência, um adaptador do Claude Code
  (`hook-io`, `hook-context`, `hook-tools`, `hook-prefix`, `hook-owner`, `session-root`,
  `crash-evidence`).
- `process.env.CLAUDE_*` só é lido pelos dois pontos de configuração do host:
  - `lib/data-dir.js` — `setDataDir(dir)`: o host passa o próprio diretório de dados uma vez,
    antes de carregar os módulos (vários leem `dataDir()` ao carregar). Com ele definido,
    nenhuma resolução do Claude Code roda (`CLAUDE_PLUGIN_DATA`, ponteiro ativo, consolidação
    de pastas irmãs).
  - `lib/brain-config.js` — caminho da config de fábrica (`CLAUDE_PLUGIN_ROOT`, com o
    diretório do próprio arquivo como padrão).
- O formato do transcript e do payload de hook é do Claude Code e fica fora do motor
  (adaptador por host).

Um teste (`engine:` em `scripts/test-units.js`) prova a fronteira e que o fechamento de
`require` de cada arquivo listado fica dentro da lista.

## Vendorização

O mesmo mecanismo do `lib/mcp-bootstrap/`, generalizado para qualquer lista de arquivos:

```
node scripts/lib/mcp-bootstrap/sync.js stamp --manifest ENGINE-MANIFEST.json      # upstream, depois de editar um arquivo listado
node scripts/lib/mcp-bootstrap/sync.js check --manifest ENGINE-MANIFEST.json [--upstream <url|caminho>]
```

`check` falha (saída 1) com os arquivos editados, ausentes ou atrás do upstream; CRLF não conta.
Uma cópia nunca é editada no lugar: copie de novo do upstream.
