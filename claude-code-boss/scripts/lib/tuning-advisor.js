'use strict';
/**
 * tuning-advisor.js — DETERMINISTIC tuning recommendations from telemetry.
 *
 * Zero model, zero quota: pure threshold rules over already-aggregated metrics.
 * This is the "keep the mechanical mechanical" layer — it turns the observability
 * built in 1.25/1.26 (stop.dispatch impact, nudge→capture rate, citation
 * precision) into a short, mechanical conclusion so the human/agent never has to
 * re-derive it. It RECOMMENDS; it never silently changes config.
 *
 * `analyze()` is pure (inputs are pre-aggregated) so it is trivially testable and
 * reused by both the SessionStart advisory hook and the dashboard endpoint.
 */

// Minimum sample sizes before a rule is allowed to fire (avoid advising on noise).
const SAMPLE_MIN = { stops: 20, shadow: 3, nudges: 5, retrievals: 20 };

function ratio(a, b) { return b > 0 ? a / b : null; }
function asPct(x) { return Math.round(x * 100); }

/**
 * @param {{
 *   activeProfile?: string,
 *   impact?: { profiles: Array<{profile,stops,blocked,gated,wouldBlock,shadowSamples}> },
 *   captureRate?: { byKind: Record<string,{nudges,captures,rate}> },
 *   retrieval?: { fired: number, cited: number }
 * }} input
 * @returns {{ recommendations: Array<{id,level,title,detail,evidence}> }}
 *   level: 'warn' | 'suggest' | 'info'
 */
function analyze(input = {}) {
  const recs = [];
  const active = input.activeProfile || 'standard';
  const profiles = (input.impact && Array.isArray(input.impact.profiles)) ? input.impact.profiles : [];
  const cur = profiles.find((p) => p && p.profile === active) || null;

  // ── Profile rules (act on the ACTIVE profile's observed impact) ──────────────
  if (cur && cur.stops >= SAMPLE_MIN.stops) {
    if (active === 'free' && cur.blocked > 0) {
      recs.push({
        id: 'free-leak', level: 'warn',
        title: 'free deixou passar bloqueios',
        detail: `O perfil free é passthrough, mas ${cur.blocked} bloqueio(s) foram aplicados — algo não está respeitando o perfil.`,
        evidence: `blocked=${cur.blocked} em ${cur.stops} stops`,
      });
    }
    if (active === 'dev' && cur.blocked === 0) {
      recs.push({
        id: 'dev-quiet', level: 'suggest',
        title: 'dev não está bloqueando nada',
        detail: 'Neste período o dev não enforçou nenhum bloqueio. standard daria o mesmo resultado com menos ruído.',
        evidence: `blocked=0 em ${cur.stops} stops`,
      });
    }
    const wb = ratio(cur.wouldBlock, cur.shadowSamples);
    if (active === 'standard' && wb !== null && cur.shadowSamples >= SAMPLE_MIN.shadow) {
      if (wb >= 0.5) {
        recs.push({
          id: 'standard-costly', level: 'suggest',
          title: 'o bypass do standard está pulando ação relevante',
          detail: `A amostra sombra indica que ~${asPct(wb)}% do que o standard pula TERIA bloqueado. Se você quer a curadoria trabalhando, dev vale a pena aqui.`,
          evidence: `would-block ${cur.wouldBlock}/${cur.shadowSamples} amostras`,
        });
      } else if (wb <= 0.15) {
        recs.push({
          id: 'standard-good', level: 'info',
          title: 'standard está bem calibrado',
          detail: `O que o standard pula quase nunca bloquearia (~${asPct(wb)}%). Mantenha.`,
          evidence: `would-block ${cur.wouldBlock}/${cur.shadowSamples} amostras`,
        });
      }
    }
  }

  // ── Recall threshold rules (citation precision = cited/fired) ────────────────
  const fired = num(input.retrieval && input.retrieval.fired);
  const cited = num(input.retrieval && input.retrieval.cited);
  const prec = ratio(cited, fired);
  if (fired >= SAMPLE_MIN.retrievals && prec !== null) {
    if (prec < 0.30) {
      recs.push({
        id: 'recall-noisy', level: 'suggest',
        title: 'recall com baixa precisão de citação',
        detail: `Só ${asPct(prec)}% do que o retrieval injeta é citado — provável minScore baixo demais (entra ruído). Suba minScoreFast/Deep um pouco.`,
        evidence: `cited/fired = ${cited}/${fired}`,
      });
    } else if (prec > 0.90 && fired < SAMPLE_MIN.retrievals * 3) {
      recs.push({
        id: 'recall-tight', level: 'info',
        title: 'recall pode estar conservador demais',
        detail: `Precisão altíssima (${asPct(prec)}%) com poucos hits — talvez minScore alto demais esteja deixando contexto útil de fora. Considere baixar um pouco.`,
        evidence: `cited/fired = ${cited}/${fired}`,
      });
    }
  }

  // NOTE: there is intentionally NO "weak nudge → disable" rule here. Recommending
  // that a low-conversion CAPTURE nudge be turned off is the exact anti-pattern that
  // silently killed auto-learning in `standard`. Low conversion means aim/surface the
  // nudge better — never disable learning. (Removed in F1 of the auto-learning review.)

  const rank = { warn: 0, suggest: 1, info: 2 };
  recs.sort((a, z) => (rank[a.level] - rank[z.level]) || a.id.localeCompare(z.id));
  return { recommendations: recs };
}

function num(v) { return Number.isFinite(v) ? v : 0; }

module.exports = { analyze, SAMPLE_MIN };
