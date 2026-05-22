# Claude Code Plugins

Monorepo de plugins para Claude Code Desktop — desenvolvido por **Allan Santos**.

## Plugins

| Plugin | Versão | Descrição |
|--------|--------|-----------|
| [claude-code-boss](./claude-code-boss) | 0.1.0 | Sistema multi-agente com orquestração Boss + memória Brain, roteamento inteligente e pesquisa em fan-out |

## Estrutura

```
claude-code-plugins/
├── claude-code-boss/          # Multi-agent orchestration system
│   ├── .claude-plugin/        # Plugin manifest
│   ├── .mcp.json              # MCP server definitions
│   ├── servers/               # boss-server + brain-server (Node.js)
│   ├── agents/                # Agent definitions (.agent.md)
│   ├── skills/                # Claude Code skills
│   ├── hooks/                 # Event hooks
│   ├── config/                # Routing, pipelines, brain config
│   ├── scripts/               # Brain CLI utilities
│   └── dashboard/             # HTML monitoring dashboard
└── ...                        # Futuros plugins
```

## Instalação

Cada plugin é instalado individualmente no Claude Code Desktop. Consulte o README de cada plugin para instruções específicas.

## Licença

MIT
