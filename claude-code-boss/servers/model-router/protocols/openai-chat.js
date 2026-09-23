'use strict';

function textFromBlocks(blocks, context) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.map((block) => {
    if (block && block.type === 'text') return block.text || '';
    throw new Error(`Bloco Anthropic não suportado em ${context}: ${block && block.type || typeof block}`);
  }).join('\n');
}

function toolResultMessages(block) {
  if (typeof block.content === 'string') {
    return [{ role: 'tool', tool_call_id: block.tool_use_id, content: block.content }];
  }
  if (!Array.isArray(block.content)) {
    return [{ role: 'tool', tool_call_id: block.tool_use_id, content: '' }];
  }
  const texts = [];
  const images = [];
  for (const part of block.content) {
    if (part && part.type === 'text') texts.push(part.text || '');
    else if (part && part.type === 'image') images.push(imagePart(part));
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

function userMessages(content) {
  if (typeof content === 'string') return [{ role: 'user', content }];
  if (!Array.isArray(content)) return [{ role: 'user', content: '' }];

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
      parts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'image') {
      parts.push(imagePart(block));
    } else if (block.type === 'tool_result') {
      flushParts();
      out.push(...toolResultMessages(block));
    } else {
      throw new Error(`Bloco Anthropic não suportado em user.content: ${block.type}`);
    }
  }
  flushParts();
  return out.length ? out : [{ role: 'user', content: '' }];
}

function assistantMessage(content) {
  if (typeof content === 'string') return { role: 'assistant', content };
  if (!Array.isArray(content)) return { role: 'assistant', content: '' };
  const texts = [];
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      throw new Error(`Bloco Anthropic não suportado em assistant.content: ${typeof block}`);
    }
    if (block.type === 'text') {
      texts.push(block.text || '');
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
  const out = { role: 'assistant', content: texts.join('\n') || null };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

function openAIToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  throw new Error(`tool_choice Anthropic não suportado: ${JSON.stringify(choice)}`);
}

function toUpstreamRequest(body) {
  const source = body || {};
  const messages = [];
  if (source.system) {
    const system = textFromBlocks(source.system, 'system');
    if (system) messages.push({ role: 'system', content: system });
  }
  for (const message of source.messages || []) {
    if (message.role === 'assistant') {
      messages.push(assistantMessage(message.content));
    } else if (message.role === 'user') {
      messages.push(...userMessages(message.content));
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
  if (typeof source.temperature === 'number') out.temperature = source.temperature;
  if (typeof source.top_p === 'number') out.top_p = source.top_p;
  if (Array.isArray(source.stop_sequences) && source.stop_sequences.length) out.stop = source.stop_sequences;
  if (Array.isArray(source.tools) && source.tools.length) {
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
          tool = { id: part.id || '', name: '', blockIndex: nextBlockIndex++, started: false, closed: false };
          tools.set(key, tool);
        }
        if (part.id) tool.id = part.id;
        if (part.function && part.function.name) tool.name += part.function.name;
        if (!tool.started && tool.name) {
          tool.started = true;
          events.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: tool.blockIndex,
              content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
            },
          });
        }
        const args = part.function && part.function.arguments;
        if (typeof args === 'string' && args) {
          if (!tool.started) throw new Error('Stream OpenAI inválido: argumentos de tool call antes do nome');
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: tool.blockIndex,
              delta: { type: 'input_json_delta', partial_json: args },
            },
          });
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        events.push(...complete());
      }
      return events;
    },
    finish: complete,
  };
}

module.exports = {
  wireProtocol: 'openai',
  toUpstreamRequest,
  fromUpstreamJson,
  createStreamTranslator,
  stopReason,
};
