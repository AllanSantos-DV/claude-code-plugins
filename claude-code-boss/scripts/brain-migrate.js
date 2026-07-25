#!/usr/bin/env node
'use strict';
/**
 * brain-migrate.js — migração one-time do KB local (SQLite) → daemon mcp-memory.
 *
 * Motor PURO `migrateLocalToMcp(opts, deps)`: itera PROJETO a PROJETO (o daemon
 * escopa por projectId no handshake do MCP, um por conexão), lê as entradas locais
 * e grava idempotente no daemon (documentId = id → UPSERT, re-run seguro). O daemon
 * re-embeda server-side (add_document só manda content), então os vetores locais são
 * descartados por contrato.
 *
 * FAIL-LOUD (skill fail-loud): uma falha por entrada é COLETADA (com a causa real) e
 * derruba `ok → false` — nunca engolida, nunca vira sucesso falso, nunca cai para o
 * store local em silêncio. Uma falha de LEITURA isola o projeto (marca a falha e segue
 * os demais). Ausência genuína (sem projeto/entrada) é `ok:true, migrated:0`, distinta de erro.
 *
 * As `deps` são injetáveis para testes herméticos (sem disco/rede); os defaults abaixo
 * ligam as primitivas reais (brain-store leitura local + brain-backend escrita no daemon).
 *
 * Uso (CLI, manual): node claude-code-boss/scripts/brain-migrate.js
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {{brainDir?:string}} [opts]
 * @param {{
 *   enumerateProjects?:(opts:object)=>Promise<string[]>,
 *   readEntries?:(project:string, opts:object)=>Promise<object[]>,
 *   writeEntry?:(entry:object, project:string, opts:object)=>Promise<void>,
 *   onProgress?:(ev:{project:string,entryId:*,done:number,total:number})=>void,
 * }} [deps]
 * @returns {Promise<{ok:boolean,totalProjects:number,totalEntries:number,migrated:number,
 *   failed:Array<{project:string,id?:*,phase:string,error:string}>,perProject:Array<object>}>}
 */
async function migrateLocalToMcp(opts = {}, deps = {}) {
  const enumerateProjects = deps.enumerateProjects || defaultEnumerateProjects;
  const readEntries = deps.readEntries || defaultReadEntries;
  const writeEntry = deps.writeEntry || defaultWriteEntry;
  const onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : () => {};

  const projects = await enumerateProjects(opts);
  const perProject = [];
  const failed = [];
  let migrated = 0;
  let totalEntries = 0;

  for (const project of projects) {
    let entries;
    try {
      entries = await readEntries(project, opts);
    } catch (e) {
      // Falha de LEITURA do projeto: isola (marca alto) e segue os demais — não aborta tudo.
      const f = { project, phase: 'read', error: (e && e.message) || String(e) };
      failed.push(f);
      perProject.push({ project, total: 0, migrated: 0, failed: 1, readError: f.error });
      continue;
    }
    totalEntries += entries.length;
    let pOk = 0;
    let pFail = 0;
    for (const entry of entries) {
      try {
        await writeEntry(entry, project, opts);
        migrated++; pOk++;
        onProgress({ project, entryId: entry && entry.id, done: pOk, total: entries.length });
      } catch (e) {
        // Falha de ESCRITA da entrada: coletada com a causa real (fail-loud), segue as outras.
        failed.push({ project, id: entry && entry.id, phase: 'write', error: (e && e.message) || String(e) });
        pFail++;
      }
    }
    perProject.push({ project, total: entries.length, migrated: pOk, failed: pFail });
  }

  return { ok: failed.length === 0, totalProjects: projects.length, totalEntries, migrated, failed, perProject };
}

// ── Deps default (produção) — reusam as primitivas confirmadas ────────────────

function activeBrainDir(opts) {
  if (opts && opts.brainDir) return opts.brainDir;
  const { dataDir } = require('./lib/data-dir.js');
  return path.join(dataDir(), 'brain');
}

/** Enumera os projetos com KB local sob o data-dir ativo (brain/<project>/brain.db). */
async function defaultEnumerateProjects(opts = {}) {
  const brainDir = activeBrainDir(opts);
  let names;
  try { names = fs.readdirSync(brainDir); } catch (e) { void e; return []; }
  return names.filter((n) => {
    try { return fs.existsSync(path.join(brainDir, n, 'brain.db')); } catch (e) { void e; return false; }
  });
}

/** Lê as entradas LOCAIS full-fidelity de um projeto (brain-store, direto no SQLite). */
async function defaultReadEntries(project) {
  const store = require('./brain-store.js');
  await store.init({ project });
  const list = await store.list(null, project);
  const entries = [];
  for (const row of list) {
    const full = store.getRaw(row.id);
    if (full) entries.push(full);
  }
  return entries;
}

/**
 * Grava UMA entrada no daemon mcp-memory ALVO via brain-backend.save (que no modo
 * mcp-memory faz add_document com documentId=id → UPSERT idempotente). Se o backend
 * NÃO estiver em mcp-memory, é ERRO ALTO — jamais grava no store local em silêncio.
 */
async function defaultWriteEntry(entry, project) {
  const backend = require('./brain-backend.js');
  if (backend.peekMode() !== 'mcp-memory') {
    throw new Error(`migração exige backend.type=mcp-memory (alvo do daemon); modo atual: ${backend.peekMode()}`);
  }
  await backend.init({ project });
  await backend.save(entry);
}

module.exports = {
  migrateLocalToMcp,
  __testHooks: { defaultEnumerateProjects, defaultReadEntries, defaultWriteEntry, activeBrainDir },
};

// ── CLI (execução manual) — fail-loud: saída não-zero se qualquer entrada falhou ──
if (require.main === module) {
  (async () => {
    const r = await migrateLocalToMcp({}, {
      onProgress: (ev) => process.stdout.write(`  ${ev.project}: ${ev.done}/${ev.total}\r`),
    });
    console.log(`\nmigração: ${r.migrated}/${r.totalEntries} entrada(s) em ${r.totalProjects} projeto(s); falhas: ${r.failed.length}`);
    if (!r.ok) {
      for (const f of r.failed) console.error(`  FAIL ${f.project}/${f.id || ''} [${f.phase}]: ${f.error}`);
      process.exit(1);
    }
  })().catch((err) => { console.error(`FAIL ${err.message}`); process.exit(1); });
}
