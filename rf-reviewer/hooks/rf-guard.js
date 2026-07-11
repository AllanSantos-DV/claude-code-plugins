#!/usr/bin/env node
/**
 * rf-guard.js — PreToolUse hook (matcher Bash) do RF Reviewer.
 *
 * Enforcement REATIVO (o gate): se o agente tentar manipular uma planilha .xlsx
 * NA MÃO (openpyxl/pandas/xlsxwriter escrevendo/salvando um workbook) em vez de
 * usar as tools do RF Reviewer, o hook pede confirmação (ask) e redireciona para
 * rf_prep/rf_apply. Não bloqueia leitura nem a CLI legítima do próprio rf-engine.
 *
 * Node built-ins apenas. Saída: hookSpecificOutput.permissionDecision (Claude Code:
 * allow | deny | ask), dentro de hookSpecificOutput (top-level é ignorado).
 */
'use strict';

function decision(permissionDecision, reason) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (reason) {
    hookSpecificOutput.permissionDecisionReason = reason;
    hookSpecificOutput.additionalContext = reason;
  }
  return JSON.stringify({ hookSpecificOutput }) + '\n';
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let evt;
  try { evt = JSON.parse(raw); } catch (_) { process.stdout.write(decision('allow')); return; }

  // só intercepta terminal (Claude Code = Bash; aceita run_in_terminal por segurança)
  const tool = evt && evt.tool_name;
  if (tool !== 'Bash' && tool !== 'run_in_terminal') { process.stdout.write(decision('allow')); return; }

  const cmd = String((evt.tool_input && (evt.tool_input.command || evt.tool_input.cmd)) || '');
  if (!cmd) { process.stdout.write(decision('allow')); return; }
  const c = cmd.toLowerCase();

  // isenção: a CLI/MCP legítimos do próprio motor (não são manipulação manual)
  if (/rf[_-]engine|rf[_-]reviewer|rf_engine\.mcp_server/.test(c)) { process.stdout.write(decision('allow')); return; }

  // sinais de ESCRITA manual de planilha
  const writesXlsx =
    (/openpyxl/.test(c) && /\.save\s*\(|save_workbook|wb\.save/.test(c)) ||
    /\.to_excel\s*\(/.test(c) ||
    /xlsxwriter/.test(c) ||
    (/load_workbook/.test(c) && /\.save\s*\(/.test(c)) ||
    (/openpyxl/.test(c) && /\.xlsx/.test(c) && /save/.test(c));

  if (!writesXlsx) { process.stdout.write(decision('allow')); return; }

  const reason =
    '[RF Reviewer] Detectada manipulação manual de planilha (openpyxl/pandas gravando .xlsx). ' +
    'Use as tools do RF Reviewer em vez de editar o Excel na mão: rf_prep para extrair e ' +
    'rf_apply para injetar a análise de volta na MESMA planilha (mecânico, não-destrutivo, ' +
    'versionado; prova por rf_verificar_preservacao). Editar o .xlsx na unha gera retrabalho e ' +
    'risco de quebrar o arquivo do cliente. Se for um caso legítimo fora do fluxo de RF, aprove.';

  process.stdout.write(decision('ask', reason));
});
