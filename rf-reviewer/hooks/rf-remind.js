#!/usr/bin/env node
/**
 * rf-remind.js — UserPromptSubmit hook (RF Reviewer).
 *
 * Enforcement PROATIVO (determinístico): sempre que o pedido do usuário parece
 * ser revisão/análise de RF em planilha (Excel), injeta no contexto do agente a
 * instrução para usar o fluxo do MCP rf-engine (rf_prep → ... → rf_apply) e NÃO
 * manipular o .xlsx na mão. Silencioso (exit 0) quando não é tarefa de planilha.
 *
 * Node built-ins apenas. Saída: JSON hookSpecificOutput (Claude Code).
 */
'use strict';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let evt;
  try { evt = JSON.parse(raw); } catch (_) { process.exit(0); }

  const prompt = String((evt && (evt.prompt || evt.user_prompt || evt.input)) || '');
  if (!prompt) process.exit(0);
  const p = prompt.toLowerCase();

  // Sinais de tarefa de RF em planilha (tabular).
  const hasSpreadsheet = /\.xlsx\b|\.xlsm\b|\.csv\b|planilha|spreadsheet|hoja de c[aá]lculo/.test(p);
  const rfWords = /requerimiento|requisito|\brf\b|rf-\d|listado|cuadro p[oó]liza|siniestro|colocacion|insuremo|la positiva/.test(p);
  const actionWords = /revis|anali|anota|validar|clasific|gap|entregable|entregável/.test(p);

  // dispara se: menciona planilha explicitamente E (contexto de RF OU ação de análise)
  const trigger = hasSpreadsheet && (rfWords || actionWords);
  if (!trigger) process.exit(0);

  const ctx =
    '[RF Reviewer] Este pedido parece envolver revisão/análise de Requisitos Funcionais em ' +
    'planilha. Use o fluxo DETERMINÍSTICO do RF Reviewer (MCP rf-engine), não faça na mão:\n' +
    '1) rf_perfis_listar -> escolher o perfil de colunas;\n' +
    '2) rf_prep {xlsx, out_dir, perfil} -> extrai e gera o esqueleto (analysis_json);\n' +
    '3) (opcional) rf_brain_enriquecer -> evidências do cérebro (project la-positiva);\n' +
    '4) preencher as schema_keys + gaps cruzando com a memória (nada vem do arquivo base);\n' +
    '5) rf_validar -> corrigir até aprovado;\n' +
    '6) rf_apply -> injeta a análise na MESMA planilha (não-destrutivo, versionado);\n' +
    '7) rf_verificar_preservacao -> confirmar 0 divergências.\n' +
    'NÃO manipule o .xlsx na mão (openpyxl/pandas) — a injeção de volta é da tool rf_apply. ' +
    'Vale só para planilha (xlsx/csv); documentos (pdf/docx/pptx) seguem outro fluxo.';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }) + '\n');
});
