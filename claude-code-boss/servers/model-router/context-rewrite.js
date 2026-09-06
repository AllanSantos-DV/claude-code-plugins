'use strict';
/**
 * context-rewrite.js — reescrita opt-in de `body.messages` p/ reduzir contexto
 * reenviado à Anthropic (Fase 3 do plano de rewrite de contexto).
 *
 * PURO: sem I/O, sem estado global, sem `Date.now()` implícito — tudo que
 * varia entre chamadas é parâmetro. Mesmo padrão de `cache-cycle.js`: reusa a
 * MESMA taxonomia de "lixo" (CLEARABLE_TYPES) em vez de reinventar o que conta
 * como removível, para as duas leituras (estimativa de prêmio vs. remoção real)
 * nunca divergirem por lógica duplicada.
 *
 * RESTRIÇÃO DURA (API real, não estilística): a Messages API exige que todo
 * bloco `tool_use` tenha um `tool_result` correspondente no turno seguinte —
 * removê-lo por completo (ou o inverso) gera 400 do upstream, não "qualidade
 * degradada silenciosa". Por isso `stripToolResults` nunca REMOVE o bloco:
 * substitui só o `content` por um placeholder sintético, preservando o
 * `tool_use_id` e o pareamento. `stripToolUse` (default false) é o inverso —
 * mais arriscado, pois o `tool_use` costuma ser pequeno (o payload grande é o
 * `tool_result`), então o ganho de removê-lo é baixo e o risco de rejeição do
 * upstream é o mesmo — daí ficar desligado por padrão.
 *
 * TRADE-OFF DE CACHE (inerente, nunca escondido): o cache da Anthropic é por
 * prefixo byte-idêntico. Qualquer mutação em `messages[k]` invalida o cache de
 * `k` em diante NA PRÓXIMA chamada (paga cache_creation em vez de cache_read).
 * Por isso o corte SÓ toca uma janela contígua no MEIO do histórico — nunca as
 * primeiras mensagens, onde vivem os breakpoints de cache de system/tools/
 * primeiro turno — minimizando o raio de invalidação em vez de maximizá-lo.
 * Decidir SE vale a pena reescrever (ex.: só em fronteira fria de cache via
 * `cacheCycle.isColdBoundary`) é responsabilidade do chamador (index.js), não
 * deste módulo — aqui só existe o mecanismo de reescrita em si.
 */

const CLEARABLE_TYPES = new Set(['tool_result', 'tool_use', 'thinking']);

// Estimador de tamanho em chars de um bloco/valor de conteúdo. Espelha
// `contentChars` de cache-cycle.js (não exportado lá) — mesma lógica, duplicada
// deliberadamente para manter este módulo sem dependência cruzada.
function contentChars(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((sum, item) => sum + contentChars(item), 0);
  if (typeof v === 'object') {
    let sum = 0;
    for (const k of Object.keys(v)) {
      if (k === 'type' || k === 'tool_use_id' || k === 'id' || k === 'name' || k === 'signature') continue;
      sum += contentChars(v[k]);
    }
    return sum;
  }
  return String(v).length;
}

function placeholderFor(chars) {
  return `[stripped by context-rewrite: ${chars} chars removed]`;
}

/**
 * Reescreve `messages` removendo/substituindo blocos "lixo" fora da janela
 * protegida dos últimos `opts.keepLastNTurns` elementos do array. NUNCA muta
 * o array ou os objetos de entrada — sempre constrói cópias novas onde algo
 * muda, e devolve a MESMA referência de mensagem/bloco onde nada mudou.
 *
 * `opts`:
 *   - keepLastNTurns: quantas mensagens finais do array ficam intocadas
 *     (default 6). Cada elemento de `messages` conta como uma "turn" para
 *     este corte — aproximação deliberada e documentada, não uma contagem de
 *     turnos user/assistant real.
 *   - stripThinking: remove o texto de blocos `thinking` fora da janela.
 *   - stripToolResults: substitui o `content` de `tool_result` por placeholder.
 *   - stripToolUse: substitui `input` de `tool_use` por placeholder (default off).
 *
 * Retorna `{ messages, removed: { blocks, chars } }`.
 */
function rewriteMessages(messages, opts) {
  const o = opts || {};
  const list = Array.isArray(messages) ? messages : [];
  const keepLastN = Number.isFinite(o.keepLastNTurns) && o.keepLastNTurns > 0 ? o.keepLastNTurns : 6;
  const cutoff = Math.max(0, list.length - keepLastN);

  let removedBlocks = 0;
  let removedChars = 0;

  const out = list.map((msg, idx) => {
    if (idx >= cutoff) return msg; // janela protegida (mais recente) — nunca tocar.
    if (!msg || !Array.isArray(msg.content)) return msg;

    let changed = false;
    const newContent = msg.content.map((block) => {
      if (!block || !CLEARABLE_TYPES.has(block.type)) return block;

      if (o.stripThinking && block.type === 'thinking') {
        const chars = contentChars(block.thinking);
        if (chars <= 0) return block;
        changed = true;
        removedBlocks += 1;
        removedChars += chars;
        const next = { ...block, thinking: '[stripped by context-rewrite]' };
        if (!block.signature) delete next.signature;
        return next;
      }

      if (o.stripToolResults && block.type === 'tool_result') {
        const chars = contentChars(block.content);
        if (chars <= 0) return block;
        changed = true;
        removedBlocks += 1;
        removedChars += chars;
        return { ...block, content: placeholderFor(chars) };
      }

      if (o.stripToolUse && block.type === 'tool_use') {
        const chars = contentChars(block.input);
        if (chars <= 0) return block;
        changed = true;
        removedBlocks += 1;
        removedChars += chars;
        return { ...block, input: { stripped: placeholderFor(chars) } };
      }

      return block;
    });

    if (!changed) return msg;
    return { ...msg, content: newContent };
  });

  return { messages: out, removed: { blocks: removedBlocks, chars: removedChars } };
}

// Tamanho total estimado de `messages` (chars) — usado pelo chamador para
// decidir se vale a pena reescrever (gate de `minSizeThresholdChars`).
// Mesma aproximação de `cache-cycle.estimateTotalChars`, escopada só a
// `messages` (o chamador já tem o total de system/tools se precisar somar).
function estimateMessagesChars(messages) {
  return contentChars(Array.isArray(messages) ? messages : []);
}

module.exports = {
  CLEARABLE_TYPES,
  contentChars,
  rewriteMessages,
  estimateMessagesChars,
};
