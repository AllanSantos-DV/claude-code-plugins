'use strict';

const anthropic = require('./anthropic.js');
const openai = require('./openai-chat.js');

const ADAPTERS = { anthropic, openai };

function getAdapter(wireProtocol) {
  const adapter = ADAPTERS[wireProtocol];
  if (!adapter) throw new Error(`Wire protocol não suportado: ${JSON.stringify(wireProtocol)}`);
  return adapter;
}

module.exports = { getAdapter };
