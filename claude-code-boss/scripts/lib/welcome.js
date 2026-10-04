'use strict';
/**
 * welcome.js — one short "it works" message on the first prompt after installing.
 *
 * Someone who just installed the plugin got no sign that anything happened. This tells
 * them once what changed and the two commands worth knowing. Shown through the
 * UserPromptSubmit `systemMessage` — measured on Claude Code 2.1.283: a UserPromptSubmit
 * systemMessage reaches the user ("UserPromptSubmit says: …"), a SessionStart one does not.
 *
 * Once per machine: the marker lives in the global dir (survives plugin updates) and is
 * CLAIMED with O_EXCL, so two sessions starting together still show it once. When the
 * marker cannot be written the message is not shown (it would repeat on every prompt).
 */
const fs = require('fs');
const path = require('path');

const MESSAGE = [
  'claude-code-boss está ativo ✓ A partir de agora o Claude Code lembra o que deu certo e errado em cada projeto, resume a saída de comandos repetidos e guarda uma lição sempre que você o corrige.',
  'Abra o painel com /dashboard · escolha o perfil com /boss-profile (o padrão, standard, trabalha em silêncio) · nada mais a configurar.',
].join(' '); // one line: Claude Code prefixes EACH line with "UserPromptSubmit says:"

function markerPath(dir) {
  return path.join(dir || require('./data-dir.js').globalDir(), 'welcome.json');
}

/**
 * The welcome text if this call claims the first showing on this machine, else null.
 * @param {{ prompt?: string, dir?: string, now?: number }} [opts]
 */
function takeWelcome({ prompt, dir, now = Date.now() } = {}) {
  // A sub-agent's <task-notification> is not the user typing — never greet it.
  if (require('./prompt-kind.js').isSyntheticPrompt(prompt)) return null;
  const file = markerPath(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ shownAt: new Date(now).toISOString() }));
    fs.closeSync(fd);
    return MESSAGE;
  } catch (err) {
    if (err.code !== 'EEXIST') console.error(`[welcome] could not claim ${file}: ${err.message}`);
    return null;
  }
}

module.exports = { takeWelcome, markerPath, MESSAGE };
