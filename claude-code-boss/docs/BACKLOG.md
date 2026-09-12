# Backlog

Pontos de melhoria identificados fora do escopo do trabalho corrente (ver política de sessão: "ponto óbvio de melhoria encontrado FORA do escopo atual não é implementado na hora").

## Testes

- ~~Cobertura end-to-end de `isCustomEndpoint` → timeout real em `model-router/index.js`~~ — **RESOLVIDO em 2026-09-12**: `router.requestUpstream`/`UPSTREAM_TIMEOUT_MS`/`BYOK_UPSTREAM_TIMEOUT_MS` exportados e cobertos em `scripts/test-units.js` (3 testes, monkey-patch em `https.request` provando o `teto` passado a `req.setTimeout` sem esperar um timeout real).

## Config

- **Endpoint BYOK `test.example.com` configurado e inalcançável, disparando em toda ativação do fallback/plano B**: `router.log` mostra `[ERROR] BYOK — endpoint inacessível {"host":"test.example.com","err":"getaddrinfo ENOTFOUND test.example.com"}` recorrente (dezenas de ocorrências entre 2026-09-11 18h e 2026-09-12 00h33, uma por vez que o fallback de limite dispara). Parece um host de teste/stub deixado configurado em produção no `/dashboard → BYOK` (Base URL). Não é um bug de código — é config do usuário — mas está gerando erro em toda sessão. Observado incidentalmente durante a investigação do bug de auto-restart do router (2026-09-11/12); fora do escopo daquele fix.
