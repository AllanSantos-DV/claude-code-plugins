'use strict';

// normalize-timeout.js — contrato único de validação de override de timeout (ms),
// compartilhado por servers/model-router/byok.js e scripts/dashboard.js. Antes
// duplicado (mesma lógica copiada nos dois arquivos porque, à época, dashboard.js
// não importava de servers/model-router/* — mas servers/model-router/index.js já
// importa vários módulos de scripts/lib/*, então essa é a direção certa pra um
// util compartilhado). Ver claude-code-boss/docs/BACKLOG.md (Arquitetura) pelo
// histórico do risco de divergência silenciosa que motivou a extração.

/**
 * Número finito >= 0 passa; qualquer outra coisa (ausente, string, negativo,
 * NaN) devolve `undefined` — "sem override, use a constante padrão do módulo".
 * `0` é um valor DIFERENTE de ausente: é o sentinel explícito de "sem timeout
 * de TTFB" (Node desarma o timeout com `req.setTimeout(0, ...)`, então 0 aqui
 * propaga naturalmente até virar "sem limite" de verdade).
 * @param {unknown} v
 * @returns {number|undefined}
 */
function normalizeTimeoutMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}

module.exports = { normalizeTimeoutMs };
