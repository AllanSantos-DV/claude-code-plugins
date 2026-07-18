#!/usr/bin/env node
'use strict';
/**
 * profile-set.js — switch the active hooks profile, update-safe.
 *
 * Writes the choice to globalDir()/hooks/user-config.json (never the shipped
 * file), so a plugin auto-update never reverts it. Backs the `/boss-profile`
 * command.
 *
 *   node scripts/profile-set.js            # print current profile + options
 *   node scripts/profile-set.js <name>     # set dev | standard | free
 */
const hooksCfg = require('./lib/hooks-config.js');

const DESCRIPTIONS = {
  dev: 'tudo ligado: constrói a KB e enforça (curadoria escala até 3x). Para quem estende o plugin.',
  standard: 'silencioso: só a curadoria dá 1 aviso soft; nudges de dev e blockers extras desligados.',
  free: 'passa tudo: nenhum bloqueio no Stop. O retrieval de contexto no prompt continua.',
};

function summary() {
  return {
    profile: hooksCfg.getProfile(),
    curationStop: hooksCfg.getCurationStop(),
    refineResearch: hooksCfg.getRefineResearch().enabled,
    failureRetro: hooksCfg.getFailureRetro().enabled,
    researchFollowup: hooksCfg.getResearchFollowup().enabled,
    autoContinue: hooksCfg.getAutoContinue().enabled,
    sessionSummary: hooksCfg.getSessionSummary().enabled,
    patternDetect: hooksCfg.getPatternDetect().enabled,
    verifyNudge: hooksCfg.getVerifyNudge().enabled,
    selfReview: hooksCfg.getSelfReview().enabled,
  };
}

function main() {
  const valid = hooksCfg.profileNames();
  const name = String(process.argv[2] || '').trim().toLowerCase();

  if (!name) {
    process.stdout.write(`Perfil atual: ${hooksCfg.getProfile()}\n\n`);
    for (const p of valid) process.stdout.write(`  ${p.padEnd(9)} ${DESCRIPTIONS[p] || ''}\n`);
    process.stdout.write(`\nUso: node scripts/profile-set.js <${valid.join('|')}>\n`);
    return;
  }

  if (!valid.includes(name)) {
    process.stderr.write(`Perfil inválido '${name}'. Válidos: ${valid.join(', ')}\n`);
    process.exit(1);
  }

  const written = hooksCfg.saveProfile(name);
  process.stdout.write(`[boss] perfil = ${name}\n`);
  process.stdout.write(`${DESCRIPTIONS[name] || ''}\n`);
  process.stdout.write(`(gravado em ${written} — sobrevive a updates do plugin)\n\n`);
  process.stdout.write(`Efeito:\n${JSON.stringify(summary(), null, 2)}\n`);
}

main();
