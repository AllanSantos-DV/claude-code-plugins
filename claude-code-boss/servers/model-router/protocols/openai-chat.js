'use strict';

function kindOf(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'lista' : typeof value;
}

// Ajustes de compatibilidade da tradução Anthropic → Chat Completions
// (`byok.openaiCompat`). O default é o formato padrão da OpenAI, que um
// gateway em passthrough aceita; cada chave troca um ponto para gateways que
// recusam esse formato. Valor desconhecido lança — nunca troca em silêncio.
const COMPAT_OPTIONS = Object.freeze({
  // Assistant com tool_calls e sem texto: `content: null` (spec OpenAI) ou `''`.
  // Sem tool_calls (ex.: só thinking) sai sempre `''` — null seria inválido.
  assistantEmptyContent: Object.freeze(['null', 'empty']),
  // `role: "system"` dentro de `messages`: repassa na posição ou recusa
  // (REQUEST_SHAPE: 400 no always, aviso no fallback).
  systemInMessages: Object.freeze(['keep', 'reject']),
  // Bloco `tool_reference` dentro de `tool_result`: vira texto JSON ou recusa
  // (REQUEST_SHAPE: 400 no always, aviso no fallback).
  toolReference: Object.freeze(['text', 'reject']),
});
const COMPAT_DEFAULTS = Object.freeze({
  assistantEmptyContent: 'null',
  systemInMessages: 'keep',
  toolReference: 'text',
});

function normalizeCompat(input) {
  if (input === undefined || input === null) return COMPAT_DEFAULTS;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`openaiCompat precisa ser um objeto (veio ${kindOf(input)})`);
  }
  const out = { ...COMPAT_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(COMPAT_OPTIONS, key)) {
      throw new Error(`openaiCompat: chave desconhecida "${key}" (use ${Object.keys(COMPAT_OPTIONS).join(', ')})`);
    }
    const allowed = COMPAT_OPTIONS[key];
    if (!allowed.includes(value)) {
      throw new Error(`openaiCompat.${key}: valor inválido ${JSON.stringify(value)} (use ${allowed.map(v => `"${v}"`).join(' ou ')})`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function blockText(block, context) {
  if (block.text === undefined) return '';
  if (typeof block.text !== 'string') throw new Error(`text de bloco em ${context} deve ser texto (veio ${kindOf(block.text)})`);
  return block.text;
}

function textFromBlocks(blocks, context) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) throw new Error(`${context} Anthropic deve ser texto ou lista (veio ${kindOf(blocks)})`);
  return blocks.map((block) => {
    if (block && block.type === 'text') return blockText(block, context);
    throw new Error(`Bloco Anthropic não suportado em ${context}: ${block && block.type || typeof block}`);
  }).join('\n');
}

function toolResultMessages(block, compat) {
  if (typeof block.content === 'string') {
    return [{ role: 'tool', tool_call_id: block.tool_use_id, content: block.content }];
  }
  if (block.content === undefined) {
    return [{ role: 'tool', tool_call_id: block.tool_use_id, content: '' }];
  }
  if (!Array.isArray(block.content)) {
    throw new Error(`tool_result.content Anthropic deve ser texto ou lista (veio ${kindOf(block.content)})`);
  }
  const texts = [];
  const images = [];
  for (const part of block.content) {
    if (part && part.type === 'text') texts.push(blockText(part, 'tool_result.content'));
    else if (part && part.type === 'image') images.push(imagePart(part));
    else if (part && part.type === 'tool_reference') {
      if (compat.toolReference === 'reject') {
        throw new Error('Bloco Anthropic tool_reference em tool_result.content recusado por openaiCompat.toolReference = "reject"');
      }
      // Chat Completions não tem bloco tool_reference: a referência segue como
      // dado do resultado da ferramenta, sem virar instrução.
      texts.push(JSON.stringify(part));
    }
    else throw new Error(`Bloco Anthropic não suportado em tool_result.content: ${part && part.type || typeof part}`);
  }
  const messages = [{
    role: 'tool',
    tool_call_id: block.tool_use_id,
    content: texts.join('\n'),
  }];
  if (images.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Imagem retornada pela ferramenta ${block.tool_use_id}` },
        ...images,
      ],
    });
  }
  return messages;
}

function imagePart(block) {
  const source = block && block.source;
  if (!source || source.type !== 'base64' || !source.media_type || typeof source.data !== 'string') {
    throw new Error('Imagem Anthropic não suportada: esperado source base64 com media_type e data');
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${source.media_type};base64,${source.data}` },
  };
}

function userMessages(content, compat) {
  if (typeof content === 'string') return [{ role: 'user', content }];
  if (content === undefined) return [{ role: 'user', content: '' }];
  if (!Array.isArray(content)) throw new Error(`user.content Anthropic deve ser texto ou lista (veio ${kindOf(content)})`);

  const out = [];
  let parts = [];
  const flushParts = () => {
    if (!parts.length) return;
    const onlyText = parts.every(part => part.type === 'text');
    out.push({
      role: 'user',
      content: onlyText ? parts.map(part => part.text).join('\n') : parts,
    });
    parts = [];
  };

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      throw new Error(`Bloco Anthropic não suportado em user.content: ${typeof block}`);
    }
    if (block.type === 'text') {
      parts.push({ type: 'text', text: blockText(block, 'user.content') });
    } else if (block.type === 'image') {
      parts.push(imagePart(block));
    } else if (block.type === 'tool_result') {
      flushParts();
      out.push(...toolResultMessages(block, compat));
    } else {
      throw new Error(`Bloco Anthropic não suportado em user.content: ${block.type}`);
    }
  }
  flushParts();
  return out.length ? out : [{ role: 'user', content: '' }];
}

function assistantMessage(content, compat) {
  if (typeof content === 'string') return { role: 'assistant', content };
  if (content === undefined) return { role: 'assistant', content: '' };
  if (!Array.isArray(content)) throw new Error(`assistant.content Anthropic deve ser texto ou lista (veio ${kindOf(content)})`);
  const texts = [];
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      throw new Error(`Bloco Anthropic não suportado em assistant.content: ${typeof block}`);
    }
    if (block.type === 'text') {
      texts.push(blockText(block, 'assistant.content'));
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      continue;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    } else {
      throw new Error(`Bloco Anthropic não suportado em assistant.content: ${block.type}`);
    }
  }
  const text = texts.join('\n');
  // `content: null` só é válido com `tool_calls`; sem eles (ex.: só thinking)
  // o turno sai com '' em qualquer opção.
  const nullable = toolCalls.length > 0 && compat.assistantEmptyContent === 'null';
  const out = { role: 'assistant', content: text || (nullable ? null : '') };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

function openAIToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice !== 'object' || Array.isArray(choice)) {
    throw new Error(`tool_choice Anthropic deve ser objeto (veio ${kindOf(choice)})`);
  }
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  throw new Error(`tool_choice Anthropic não suportado: ${JSON.stringify(choice)}`);
}

// Todo erro aqui nasce do conteúdo da request (não da configuração): sai com
// `code = 'REQUEST_SHAPE'` para o chamador responder 400, não 502. A config
// `openaiCompat` inválida é erro de configuração: lança antes, sem esse code
// (o perfil do upstream já a valida — ver upstream-profile.js).
function toUpstreamRequest(body, options) {
  const compat = normalizeCompat(options && options.openaiCompat);
  try {
    return buildUpstreamRequest(body, compat);
  } catch (err) {
    if (!err.code) err.code = 'REQUEST_SHAPE';
    throw err;
  }
}

function buildUpstreamRequest(body, compat) {
  const source = body || {};
  const messages = [];
  if (source.system !== undefined && source.system !== null && source.system !== '') {
    const system = textFromBlocks(source.system, 'system');
    if (system) messages.push({ role: 'system', content: system });
  }
  if (source.messages !== undefined && !Array.isArray(source.messages)) {
    throw new Error(`messages Anthropic deve ser lista (veio ${kindOf(source.messages)})`);
  }
  for (const message of source.messages || []) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`mensagem Anthropic deve ser objeto (veio ${kindOf(message)})`);
    }
    if (message.role === 'assistant') {
      messages.push(assistantMessage(message.content, compat));
    } else if (message.role === 'user') {
      messages.push(...userMessages(message.content, compat));
    } else if (message.role === 'system') {
      if (compat.systemInMessages === 'reject') {
        throw new Error('Role Anthropic system dentro de messages recusado por openaiCompat.systemInMessages = "reject"');
      }
      // Há clientes que mandam instrução de sistema no meio do histórico:
      // repassa com o mesmo role e na mesma posição (texto ou blocos de texto).
      messages.push({ role: 'system', content: textFromBlocks(message.content, 'messages.system') });
    } else {
      throw new Error(`Role Anthropic não suportado: ${message.role}`);
    }
  }

  const out = {
    model: source.model,
    messages,
    max_tokens: source.max_tokens,
    stream: !!source.stream,
  };
  if (source.stream) out.stream_options = { include_usage: true };
  if (typeof source.temperature === 'number') out.temperature = source.temperature;
  if (typeof source.top_p === 'number') out.top_p = source.top_p;
  if (Array.isArray(source.stop_sequences) && source.stop_sequences.length) out.stop = source.stop_sequences;
  if (source.tools !== undefined && source.tools !== null && !Array.isArray(source.tools)) {
    throw new Error(`tools Anthropic deve ser lista (veio ${kindOf(source.tools)})`);
  }
  if (Array.isArray(source.tools) && source.tools.length) {
    for (const tool of source.tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        throw new Error(`tool Anthropic deve ser objeto (veio ${kindOf(tool)})`);
      }
    }
    out.tools = source.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
  }
  const toolChoice = openAIToolChoice(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function parseToolArguments(call) {
  const raw = call && call.function && call.function.arguments;
  if (raw === undefined || raw === null || raw === '') return {};
  try { return JSON.parse(raw); } catch (err) {
    throw new Error(`Argumentos JSON inválidos na tool call ${call.id || '<sem id>'}: ${err.message}`);
  }
}

function stopReason(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'content_filter') return 'refusal';
  return reason || 'end_turn';
}

function fromUpstreamJson(body, request) {
  const choice = body && Array.isArray(body.choices) && body.choices[0];
  if (!choice || !choice.message) throw new Error('Resposta OpenAI inválida: choices[0].message ausente');
  const message = choice.message;
  const content = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    if (!call || !call.function || !call.function.name) {
      throw new Error('Resposta OpenAI inválida: tool call sem function.name');
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call),
    });
  }
  const usage = body.usage || {};
  return {
    id: body.id || `msg_openai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model || (request && request.model) || '',
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
    },
  };
}

function createStreamTranslator(request) {
  let started = false;
  let finished = false;
  let nextBlockIndex = 0;
  let textIndex = null;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const tools = new Map();

  const startTool = (tool, events) => {
    if (tool.started) return;
    if (!tool.name) throw new Error('Stream OpenAI inválido: tool call sem function.name');
    tool.started = true;
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: tool.blockIndex,
        content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
      },
    });
  };

  const flushPendingTools = () => {
    const events = [];
    for (const tool of tools.values()) {
      if (tool.started) continue;
      startTool(tool, events);
      for (const partial of tool.argFragments) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: tool.blockIndex,
            delta: { type: 'input_json_delta', partial_json: partial },
          },
        });
      }
    }
    return events;
  };

  const closeBlocks = () => {
    const events = [];
    if (textIndex !== null) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } });
      textIndex = null;
    }
    for (const tool of tools.values()) {
      if (tool.started && !tool.closed) {
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: tool.blockIndex } });
        tool.closed = true;
      }
    }
    return events;
  };

  const complete = () => {
    if (finished) return [];
    finished = true;
    return [
      ...flushPendingTools(),
      ...closeBlocks(),
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason(finishReason), stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  };

  return {
    start() {
      if (started) return [];
      started = true;
      return [{
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: `msg_openai_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: request && request.model || '',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      }];
    },
    consume(chunk) {
      if (finished) return [];
      const events = [];
      const choice = chunk && Array.isArray(chunk.choices) && chunk.choices[0];
      if (chunk && chunk.usage) {
        usage = {
          input_tokens: Number(chunk.usage.prompt_tokens) || 0,
          output_tokens: Number(chunk.usage.completion_tokens) || 0,
        };
      }
      if (!choice) return events;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (textIndex === null) {
          textIndex = nextBlockIndex++;
          events.push({
            event: 'content_block_start',
            data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } },
          });
        }
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } },
        });
      }
      for (const part of delta.tool_calls || []) {
        const key = Number.isInteger(part.index) ? part.index : 0;
        let tool = tools.get(key);
        if (!tool) {
          tool = { id: part.id || '', name: '', argFragments: [], blockIndex: nextBlockIndex++, started: false, closed: false };
          tools.set(key, tool);
        }
        if (part.id) tool.id = part.id;
        if (part.function && part.function.name) tool.name += part.function.name;
        const args = part.function && part.function.arguments;
        if (typeof args === 'string' && args) tool.argFragments.push(args);
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        events.push(...flushPendingTools());
      }
      return events;
    },
    finish: complete,
  };
}

module.exports = {
  wireProtocol: 'openai',
  COMPAT_OPTIONS,
  COMPAT_DEFAULTS,
  normalizeCompat,
  toUpstreamRequest,
  fromUpstreamJson,
  createStreamTranslator,
  stopReason,
};
