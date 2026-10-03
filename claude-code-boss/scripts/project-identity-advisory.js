#!/usr/bin/env node
/**
 * project-identity-advisory.js — SessionStart hook (strict project-id gate, 2.29.1).
 *
 * The client resolves the project id by a STRICT ladder (lib/project-id.js: env
 * `CCB_PROJECT_ID` → `.memory/project.json` → legacy `.claude-boss-project` → git
 * remote → nothing). With no id, memory is OFF for the folder: capture-dispatch and
 * conversation-ingest already refuse to write, brain_retrieve_context returns nothing,
 * and the KB tools refuse a `cwd` without id. Before 2.29.1 this hook was a
 * consent-first nudge with a 7-day cooldown that still recommended the legacy marker —
 * so exploratory folders kept pulling weak, unrelated recall and agents wrote lessons
 * under invented basename ids (spike S0, 2026-09-25).
 *
 * Now (same model as the copilot-memory plugin): every session in a folder without id
 * gets a VISIBLE notice — memory is off, and the agent must ask the user for the
 * project name and create `.memory/project.json`. No cooldown; the Stop detector
 * (project-id-stop.js) repeats it until the id exists. Opt-out:
 * `onboarding.projectIdentity: false`.
 */
'use strict';

const { runTextCli } = require('./lib/hook-io.js');
const { tryResolveProjectId, memoryOptedOut } = require('./lib/project-id.js');
const { getOnboarding, load: loadBrainConfig } = require('./lib/brain-config.js');

/**
 * PURE-ish — does this folder lack a project id (strict ladder)? `resolve` is a test
 * seam (defaults to tryResolveProjectId with the real env/fs/git). A folder the user
 * explicitly kept memory-off (.memory/memory-off.json) is settled — no notice.
 */
function needsProjectId(cwd, resolve = tryResolveProjectId, optedOut = memoryOptedOut) {
  return !resolve({ cwd }) && !optedOut({ cwd });
}

/** `backend.mcpMemory.projectId` from the config, if set (it no longer enables a folder). */
function configProjectId() {
  try {
    const c = loadBrainConfig();
    const v = c && c.backend && c.backend.mcpMemory && c.backend.mcpMemory.projectId;
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  } catch (err) {
    console.error(`[project-identity-advisory] config read: ${err.message}`);
    return '';
  }
}

/** The notice (pt-BR, user-facing via the agent). Shared with project-id-stop.js. */
function buildNotice(cwd, cfgId = configProjectId()) {
  const where = cwd ? ` (\`${cwd}\`)` : '';
  return `[PROJETO] ERRO: esta pasta${where} não tem project id — a memória do Brain está DESLIGADA aqui: `
    + 'nenhum recall é injetado e nada é salvo (capture_lesson/brain_store recusam quando recebem o `cwd` — passe sempre). '
    + 'Avise o usuário e pergunte o nome do projeto (ex.: "owner/repo"). Com a resposta, crie '
    + '`.memory/project.json` na raiz do projeto com '
    + '`{"version":"1","metadata":{"defaults":{"project_id":"<nome>"}}}` '
    + '— ou trabalhe num repositório git com remote origin. '
    + 'NÃO chame brain_store/capture_lesson com um `project` inventado enquanto isso. '
    + 'Este aviso se repete a cada prompt até o id existir. Se o usuário RECUSAR definir um id para esta pasta, '
    + 'crie `.memory/memory-off.json` com `{"memory":"off"}` na pasta: a memória fica desligada aqui e o aviso para.'
    + (cfgId ? ` Nota: \`backend.mcpMemory.projectId\` ("${cfgId}") na config NÃO liga mais a memória de uma pasta — o id precisa ser da pasta, como acima.` : '');
}

async function run(event, { resolve } = {}) {
  if (!getOnboarding().projectIdentity) return null;     // opted out
  const cwd = (event && typeof event.cwd === 'string' && event.cwd) ? event.cwd : process.cwd();
  if (!needsProjectId(cwd, resolve)) return null;
  return buildNotice(cwd);
}

function main() { return runTextCli(run, 'PROJECT-IDENTITY', 'SessionStart'); }

if (require.main === module) {
  main(); // runTextCli never rejects: it logs and emits {} itself
}

module.exports = { needsProjectId, buildNotice, run };
