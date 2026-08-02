'use strict';

// ── Fingerprint da config efetiva (shipped ⊕ user) ───────────────────────────
//
// O daemon do model-router é DETACHED: carrega a config UMA vez no boot
// (loadConfig) e nunca a relê enquanto o processo viver. O ensure, no entanto,
// roda a cada SessionStart/UserPromptSubmit e no "Salvar & aplicar" do dashboard.
// Para o ensure saber se o daemon serve a MESMA config que está no disco AGORA
// (e decidir derrubá-lo e ressuscitá-lo), ambos precisam concordar num
// fingerprint determinístico da config efetiva — é o que este módulo entrega.
//
// Uso em dois lugares (fonte única, sem divergência):
//   - server  → grava `configFingerprint` no state.json ao subir;
//   - ensure  → computa o fingerprint da config ATUAL e compara com o do state;
//               se divergir (ou o state não tiver fingerprint — daemon de versão
//               anterior), o daemon está desatualizado e é reiniciado.
//
// A ordenação recursiva das chaves garante que a ORDEM de escrita do JSON não
// mude o hash (JSON.parse preserva a ordem do arquivo, que pode variar).

function sortKeys(node) {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).sort()) out[k] = sortKeys(node[k]);
    return out;
  }
  return node;
}

// SHA-256 hex da config EFETIVA (shipped ⊕ user, já mesclada) com chaves
// ordenadas. Determinístico entre processos: mesma config → mesmo hash.
function configFingerprint(config) {
  const stable = JSON.stringify(sortKeys(config || {}));
  const { createHash } = require('crypto');
  return createHash('sha256').update(stable).digest('hex');
}

module.exports = { configFingerprint, sortKeys };
