# Getting Started — claude-code-boss

> Tempo estimado: 5-10 minutos

## Pré-requisitos

| Requisito | Mínimo | Como verificar |
|-----------|--------|----------------|
| **Node.js** | 22.13+ | `node --version` |
| **Claude Code** | 2.1.x | Instalado e autenticado |
| **Java** (opcional) | 21+ | Só para backend `mcp-memory` |
| Git | qualquer | Para instalação via marketplace |

## Instalação

### Opção A — Marketplace local (recomendado)

1. Adicione o marketplace no `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "allansantos-plugins": {
      "source": {
        "source": "git",
        "url": "https://github.com/AllanSantos-DV/claude-code-plugins.git"
      }
    }
  },
  "enabledPlugins": {
    "claude-code-boss@allansantos-plugins": true
  }
}
```

2. Reinicie o Claude Code (feche e abra).

### Opção B — Desenvolvimento local (checkout do repo)

```powershell
git clone https://github.com/AllanSantos-DV/claude-code-plugins.git
cd claude-code-plugins\claude-code-boss
npm install          # roda postinstall: deps + warm do modelo de embedding
npm run gate         # valida lint + version sync + testes
```

Force-instale na cache do Claude Code Desktop:

```powershell
node .claude/scripts/install-local.mjs --dirty
# depois, dentro do Claude Code: /reload-plugins
```

## Verificação (30 segundos)

Dentro de uma sessão Claude Code:

```
/dashboard          → abre o dashboard web no navegador
node scripts/doctor.js   → health check completo do plugin (rode da pasta claude-code-boss)
```

## Primeiros Passos por Feature

### Brain KB (memória semântica)

Funciona **automaticamente** após instalação:

1. Trabalhe normalmente; ao corrigir um erro, o plugin oferece capturar a lição
2. Na próxima sessão, lições relevantes são injetadas automaticamente no prompt
3. Busca manual: `brain_search` via MCP tool ou `/dashboard` → aba Brain KB

### Model Router (economia de API)

**Desligado por padrão.** Para ativar:

1. `/dashboard` → aba **Router**
2. Ligue **Sticky Router** (recomendado — preserva prompt cache)
3. Clique **Salvar & aplicar**
4. Reinicie o Claude Code uma vez para o roteamento engatar

Opcional: cole uma chave NVIDIA grátis (`build.nvidia.com`) para fallback no 429.

### Curadoria (shells curados)

Também automática:

1. Rode o mesmo comando Bash 3+ vezes em sessões
2. O plugin oferece gerar um wrapper `.ps1`
3. Nas próximas vezes, o comando é redirecionado ao wrapper automaticamente

## Configuração Mínima Recomendada

Nada é obrigatório. Os defaults são conservadores (tudo OFF, opt-in). Se quiser economizar token sem proxy, grave no **caminho global estável** `~/.claude/claude-code-boss/model-router/user-config.json`:

```json
{
  "contextTuning": { "enabled": true }
}
```

> A chave é aninhada (`contextTuning.enabled`) — uma chave plana é silenciosamente ignorada.

Isso grava `ENABLE_TOOL_SEARCH=true` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` no settings.json — ganho de token sem publicar `ANTHROPIC_BASE_URL` (preserva a janela de 1M dos modelos que a suportam).

## Gotchas Comuns

| Problema | Solução |
|----------|---------|
| Hooks não disparam | Reinicie o Claude Code **completamente** (não só reload) |
| Node não encontrado pelo hook | Node deve estar no PATH **do sistema**, não só do terminal |
| Porta 13456 ocupada | `netstat -ano \| findstr 13456` → mate o PID intruso |
| Embedding baixando na 1ª execução | Normal (~100-200MB, uma vez só) |
| Duas pastas `claude-code-boss*` em plugins/data | Fragmentação — rode o consolidador (`node scripts/consolidate-datadirs.js --apply`) |

## Próximos Passos

- [CONFIGURATION.md](./CONFIGURATION.md) — todas as opções de config
- [features/MODEL-ROUTER.md](./features/MODEL-ROUTER.md) — guia completo do router
- [features/BRAIN-KB.md](./features/BRAIN-KB.md) — guia completo do Brain
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — FAQ e problemas conhecidos

> Nota: os guias de features e troubleshooting são entregues em fases — verifique se o arquivo já existe.
