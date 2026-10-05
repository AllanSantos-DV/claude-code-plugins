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
  // A repo with a git remote names itself (host/owner/repo — the same project on any machine
  // or path). This notice is for folders without one: the AGENT finds out what the folder is
  // and asks the user in plain words — never "owner/repo" jargon, never a made-up name.
  return `[PROJETO] A memória do Brain está DESLIGADA nesta pasta${where}: ela não tem project id `
    + '(não é um repositório git com remote, nem tem nome de projeto definido), então nada é lembrado nem salvo aqui. '
    + 'NÃO chame brain_store/capture_lesson com um `project` inventado. Resolva assim, sem jargão para o usuário: '
    + '(1) olhe a pasta (README, package.json/pom.xml, nomes das pastas) para entender que projeto é; '
    + '(2) chame `project_list` para ver os projetos que já existem na memória; '
    + '(3) explique ao usuário, em uma frase, que a memória está desligada aqui porque a pasta ainda não tem nome de projeto, '
    + 'e pergunte se é um projeto NOVO ou a continuação/migração de um projeto que já existe — se algum da lista parece ser este '
    + '(pelo conteúdo da pasta), sugira-o pelo nome; '
    + '(4) com a resposta, chame `project_set` com só o nome (ex.: "loja-online"; não peça dono/organização) e, se o usuário confirmou '
    + 'que é um projeto existente, `link: true`. Não aceite nomes genéricos ("nova pasta", "teste") sem confirmar que é isso mesmo. '
    + 'Sem a tool, grave `.memory/project.json` com `{"version":"1","metadata":{"defaults":{"project_id":"<nome>"}}}`. '
    + 'Este aviso se repete a cada prompt até o id existir. Se o usuário NÃO quiser memória nesta pasta, '
    + 'crie `.memory/memory-off.json` com `{"memory":"off"}`: a memória fica desligada aqui e o aviso para.'
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
