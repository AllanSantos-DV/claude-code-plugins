# Security & Privacy

> O que o plugin coleta, onde guarda, o que sai da máquina.

## Princípio

**Local-first.** Nenhum dado sai da máquina por padrão. As únicas exceções são opt-in explícito: classificação remota NVIDIA e endpoint BYOK (que você mesmo configura).

## Credenciais

| Credencial | Armazenamento | Exposição |
|------------|---------------|-----------|
| Chave NVIDIA (`nim.apiKey`) | `<globalDir>/model-router/user-config.json`, permissão 0600 best-effort | Nunca logada, nunca commitada; dashboard não a reenvia a cada toggle |
| Headers BYOK (`byok.headers`) | Mesmo arquivo 0600 | Idem; `headers: null` limpa explicitamente |
| Token da assinatura Claude | Só no processo do CC | **Nunca** vai ao endpoint BYOK — na rota BYOK é removido; só headers configurados seguem |

## Superfícies de rede locais

| Serviço | Bind | Auth |
|---------|------|------|
| Model Router (:13456) | loopback | `/health` aberto (liveness); demais rotas exigem router token — squatter na porta nunca é trusted |
| Dashboard | `127.0.0.1`, porta efêmera | Token de sessão por boot + allowlist de **Host header** (anti DNS-rebinding) |
| Brain daemon | loopback, porta efêmera | Bearer token + origin guard; `/health` aberto p/ supervisão |

Nenhuma variável é gravada em escopo User/sistema do Windows — roteamento vive só no bloco `env` do settings.json do Claude Code (resíduos globais de versões antigas são limpos pelo self-heal).

## Dados de prompt

| Fluxo | O que sai | Quando |
|-------|-----------|--------|
| Classificação local (default) | **Nada** — MiniLM embarcado roda offline | Sempre |
| `nim.classifyRemote` | ~500 chars do prompt → NVIDIA | Opt-in explícito (`true`) |
| BYOK | Requests completas → seu endpoint | Você configurou o endpoint |
| Fallback NVIDIA (429) | Request completa → NVIDIA | Só quando a janela Claude esgota e há chave |
| Brain KB | Nada sai (SQLite local); backend mcp-memory é seu daemon local | — |

## Redação e sanitização

- KB em escopo `user` (global): paths/emails/nome de projeto sanitizados antes de persistir
- Secrets detectados em entrada com scope=user → entrada rejeitada
- Trigger evidence de shadow policies: snippet redacionado + capped; purgável via tool dedicada
- Bundles de adjudicação são efêmeros e consumidos (deletados) no record
- Telemetria de Stop hooks mede contagens/tamanhos, nunca texto

## Supply chain

- Dependências mínimas: `@modelcontextprotocol/sdk` + `@huggingface/transformers`
- SQLite = `node:sqlite` builtin (zero compile nativo)
- Updater legado removido; downloads atuais verificados por digest (fail-closed sem digest)
- CI gates mecânicos (release-audit, pages-guard, release-guard) sem AI/quota

## Windows shim

O wrapper do `claude.exe` injeta apenas a URL do proxy lida de `model-router-url.txt`. É fail-open: router morto → Claude direto. Nunca manipula credenciais.
