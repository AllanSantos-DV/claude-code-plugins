'use strict';

// ── Router mode: fonte ÚNICA de verdade ───────────────────────────────────────
//
// O proxy model-router tem TRÊS interruptores independentes no router-config.json:
//   - `sticky.enabled`   → roteador STICKY cache-safe (RECOMENDADO). Classifica UMA
//                          vez por sessão (turno 0, sem cache = grátis) e FIXA o
//                          modelo pelo resto da sessão — modelo constante preserva
//                          o prompt cache. Inclui o 429→plano B. OFF por padrão.
//   - `enabled`          → cost-routing per-turn (DEPRECADO). Reescreve o modelo a
//                          CADA request: rotear por-modelo QUEBRA o prompt cache da
//                          Anthropic (cache é POR MODELO). OFF por padrão. Prefira
//                          `sticky.enabled`. Ver _comment_enabled.
//   - `fallback.enabled` → rede de segurança de LIMITE (429). OFF por padrão.
//                          Roda o proxy como PASSTHROUGH cache-safe (NUNCA troca
//                          modelo/effort, NÃO classifica) e só intervém no 429 do
//                          upstream para acionar o plano B (NVIDIA ou aviso).
//
// resolveMode() deriva UM modo a partir dos flags — usado pelo ensure (que decide
// publicar/limpar o footprint ANTHROPIC_BASE_URL) e pelo server (que decide
// inicializar o classificador e se classifica ou repassa cada request). Manter a
// regra aqui evita divergência entre os dois processos.
//
//   'off'           → todos os flags !==true (totalmente inerte)
//   'sticky-tier'   → sticky.enabled===true (roteador cache-safe; inclui 429→plano B)
//   'routing'       → enabled===true (cost-routing per-turn DEPRECADO; inclui 429→plano B)
//   'fallback-only' → só fallback.enabled===true (passthrough + 429)
//
// PRECEDÊNCIA: `sticky.enabled` VENCE `enabled` VENCE `fallback.enabled`. Em
// sticky-tier e routing o 429→plano B já está embutido, então ligar o fallback
// junto é redundante (não muda o comportamento).
function resolveMode(config) {
  const c = config || {};
  const st = (c.sticky && typeof c.sticky === 'object') ? c.sticky : {};
  if (st.enabled === true) return 'sticky-tier';
  if (c.enabled === true) return 'routing';
  const fb = (c.fallback && typeof c.fallback === 'object') ? c.fallback : {};
  if (fb.enabled === true) return 'fallback-only';
  return 'off';
}

// ── Apresentação do modo (rótulo/cor) ────────────────────────────────────────
//
// Metadados PUROS por modo — fonte ÚNICA para o dashboard/UI não divergirem do
// que o server realmente roda. `i18n` é a chave do rótulo (resolvida no client),
// `color` mapeia o dot do status card e `deprecated` marca o modo per-turn.
//   off           → cinza  (proxy fora / inerte)
//   fallback-only → azul   (passthrough + 429)
//   sticky-tier   → verde  (roteador cache-safe RECOMENDADO)
//   routing       → âmbar  (per-turn DEPRECADO)
const MODE_META = {
  'off':           { i18n: 'mode.off',          color: 'grey',  deprecated: false },
  'fallback-only': { i18n: 'mode.fallbackOnly', color: 'blue',  deprecated: false },
  'sticky-tier':   { i18n: 'mode.stickyTier',   color: 'green', deprecated: false },
  'routing':       { i18n: 'mode.routing',      color: 'amber', deprecated: true  },
};

// Devolve os metadados de um modo; desconhecido/ausente → 'off' (fail-safe).
function modeMeta(mode) {
  return MODE_META[mode] || MODE_META.off;
}

module.exports = { resolveMode, modeMeta, MODE_META };
