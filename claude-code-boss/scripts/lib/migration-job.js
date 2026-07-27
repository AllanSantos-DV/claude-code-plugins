'use strict';
/**
 * migration-job.js — máquina de estado do "Migrar agora" (KB local → mcp-memory).
 *
 * NÚCLEO testável e agnóstico de HTTP (o dashboard só faz o wiring das rotas):
 *   start(deps)  — dispara UMA migração em background (fire-and-forget) e devolve na hora
 *                  { started, job }. IDEMPOTENTE: se já há uma correndo, NÃO dispara outra.
 *   status()     — snapshot do job atual (idle | running | done | error) p/ o polling da UI.
 *
 * FAIL-LOUD (skill fail-loud): só roda com backend mcp-memory (senão status:error, sem rodar);
 * `ok:false` da migração OU da verificação vira status:error com as falhas VISÍVEIS; um throw
 * vira status:error com a causa real. Nunca "done" mascarando perda, nunca grava local escondido.
 *
 * Singleton de módulo (o dashboard é single-user/localhost, migração é operação única) —
 * espelha o padrão do ProjectSyncService.globalActiveSyncs do native-java.
 */

let _job = null;       // snapshot corrente/último (null → idle)
let _running = null;    // Promise da corrida em voo (null quando ociosa)

function status() {
  return _job || { status: 'idle' };
}

/**
 * @param {{
 *   peekMode?:()=>string,
 *   migrateLocalToMcp?:(opts:object, deps:object)=>Promise<object>,
 *   verifyMigration?:(perProject:Array<object>)=>Promise<{ok:boolean,checks:Array<object>}>,
 * }} [deps]
 * @returns {{started:boolean, job:object}}
 */
function start(deps = {}) {
  // Idempotência: uma migração de cada vez (o botão não pode empilhar corridas).
  if (_running) return { started: false, job: _job };

  const peekMode = deps.peekMode || (() => require('../brain-backend.js').peekMode());
  const migrate = deps.migrateLocalToMcp
    || ((o, d) => require('../brain-migrate.js').migrateLocalToMcp(o, d));
  const verify = deps.verifyMigration
    || ((perProject) => require('../brain-migrate.js').verifyMigration(perProject));

  // Gate fail-loud: migrar exige o backend mcp-memory (o alvo do daemon). Fora dele,
  // NÃO roda nada (jamais grava no store local em silêncio) e sinaliza o erro.
  const mode = peekMode();
  if (mode !== 'mcp-memory') {
    _job = {
      status: 'error',
      error: `migração exige backend mcp-memory (atual: ${mode}). Troque o backend em Brain → Backend e tente de novo.`,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    return { started: false, job: _job };
  }

  _job = { status: 'running', migrated: 0, total: 0, currentProject: null, failed: [], startedAt: Date.now() };

  _running = (async () => {
    try {
      const result = await migrate({}, {
        onProgress: (ev) => {
          _job.migrated += 1;
          _job.currentProject = ev && ev.project;
        },
      });
      let verifyResult = { ok: true, checks: [] };
      try {
        verifyResult = await verify(result.perProject);
      } catch (e) {
        verifyResult = { ok: false, checks: [], error: (e && e.message) || String(e) };
      }
      const ok = !!result.ok && !!verifyResult.ok;
      _job = {
        status: ok ? 'done' : 'error',
        ok,
        migrated: result.migrated,
        total: result.totalEntries,
        totalProjects: result.totalProjects,
        failed: result.failed || [],
        verify: verifyResult,
        error: ok ? null : buildErrorSummary(result, verifyResult),
        startedAt: _job.startedAt,
        finishedAt: Date.now(),
      };
    } catch (e) {
      _job = {
        status: 'error',
        error: (e && e.message) || String(e),
        migrated: _job.migrated,
        startedAt: _job.startedAt,
        finishedAt: Date.now(),
      };
    } finally {
      _running = null;
    }
  })();

  return { started: true, job: _job };
}

function buildErrorSummary(result, verifyResult) {
  const parts = [];
  if (result && result.failed && result.failed.length) {
    parts.push(`${result.failed.length} entrada(s) falharam ao migrar`);
  }
  if (verifyResult && !verifyResult.ok) {
    parts.push('a verificação pós-migração não bateu (o servidor tem menos do que subimos)');
  }
  return parts.join('; ') || 'migração não concluída';
}

module.exports = {
  start,
  status,
  __testHooks: {
    /** Aguarda a corrida em voo terminar (para testes determinísticos). */
    awaitCurrent: () => _running || Promise.resolve(),
    reset: () => { _job = null; _running = null; },
  },
};
