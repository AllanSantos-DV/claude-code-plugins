# ADR-002 — SQLite via node:sqlite builtin (zero deps nativas)

**Status:** Aceito | **Data:** 2026-06 | **Escopo:** Brain KB storage

## Contexto

KB semântica precisa de storage confiável. `better-sqlite3` exige compilação nativa por versão do Node — quebra em updates e ambientes sem toolchain.

## Decisão

Usar o módulo builtin `node:sqlite` (Node 22.13+), com fallback JSON quando indisponível. Única dependência nativa remanescente é transitive (`sharp` prebuilt via transformers).

## Consequências

- `npm install` nunca compila nada; engines pinado `>=22.13.0`
- Fallback JSON mantém a KB funcionando em Node sem sqlite (testes herméticos)
- Consolidações rodam em transação atômica BEGIN/COMMIT
