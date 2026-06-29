/**
 * model-router-patcher.js
 *
 * Carregado via NODE_OPTIONS=--require antes de qualquer código do Claude Code.
 * Sobrescreve ANTHROPIC_BASE_URL no processo Node.js antes que o SDK Anthropic
 * inicialize — contorna o problema de o Claude Desktop App herdar a URL original.
 *
 * Este arquivo é a FONTE versionada. O model-router-ensure.js copia-o para
 * ~/.claude/model-router-patcher.js (local estável), pois NODE_OPTIONS é uma
 * variável de ambiente persistente do usuário e não pode apontar para o diretório
 * versionado do cache do plugin (que muda a cada atualização).
 *
 * Falha silenciosa: se algo der errado, Claude Code continua normalmente.
 */
'use strict';

(function () {
  try {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');

    const STATE_FILE = path.join(
      os.homedir(), '.claude', 'plugins', 'data',
      'claude-code-boss', 'model-router', 'state.json'
    );

    if (!fs.existsSync(STATE_FILE)) return;

    let state;
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
    catch (err) { void err; return; }

    if (!state || !state.port) return;

    const proxyUrl = `http://127.0.0.1:${state.port}`;
    const original = process.env.ANTHROPIC_BASE_URL || '';

    // Só sobrescreve se não for já o proxy (evita loop se patcher rodar duas vezes)
    if (original === proxyUrl) return;

    process.env.ANTHROPIC_BASE_URL = proxyUrl;

    // Log no arquivo do router
    try {
      const LOG_FILE = path.join(
        os.homedir(), '.claude', 'plugins', 'data',
        'claude-code-boss', 'model-router', 'router.log'
      );
      const ts = new Date().toISOString();
      fs.appendFileSync(LOG_FILE,
        `[${ts}] [PATCH] ANTHROPIC_BASE_URL: "${original || '(vazio)'}" → "${proxyUrl}"\n`
      );
    } catch (err) { void err; /* log best-effort */ }

  } catch (err) {
    void err; // Nunca lança — Claude Code não pode ser bloqueado pelo patcher
  }
})();
