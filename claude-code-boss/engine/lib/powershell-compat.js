'use strict';
/**
 * lib/powershell-compat.js — PowerShell 5.1 × 7 mistakes an agent makes because it does
 * not know which one runs its command. Pure (no I/O): the hooks decide what to do.
 *
 * Two real failure classes were measured in 30 days of transcripts (3.089 PowerShell
 * calls, see docs/BACKLOG.md):
 *   1. `powershell -Command "…$_…"` through Bash — bash expands `$_`, `$p`, `$(…)` and
 *      backticks inside the double quotes before PowerShell sees them (`$_.ProcessId`
 *      arrived as `unsetenv.ProcessId`). Fixed exactly: the PowerShell-only
 *      metacharacters get a `\` (bash drops it inside "…"), nothing else changes.
 *   2. Windows PowerShell 5.1 turns native stderr under `2>&1` into NativeCommandError
 *      (exit 1) — advice only.
 * Version-syntax slips (`&&`, `??`, ternary, `-AsHashtable`…) did not appear in the
 * window; they are still linted (cheap, exact) so the next one is caught and counted.
 */

const COMMAND_FLAG = /(?:^|[\s;&|(])((?:powershell|pwsh)(?:\.exe)?)((?:\s+-[A-Za-z]+(?:\s+[^-\s"'][^\s"']*)?)*?)\s+-(?:Command|c)\s+(["'])/gi;

// Text that is PowerShell, not bash, inside a -Command string.
const PS_SIGNAL = new RegExp([
  '\\$_(?![A-Za-z0-9_])',
  '\\$env:',
  '\\$(?:true|false|null|args|PSItem|LASTEXITCODE|Error|PSVersionTable)\\b',
  '\\b(?:Get|Set|New|Remove|Select|Where|ForEach|Test|Invoke|Write|Out|Start|Stop|Add|Import|Export|ConvertTo|ConvertFrom|Format|Measure|Sort|Join|Split|Resolve|Copy|Move|Rename|Clear|Wait|Compare|Group|Read)-[A-Z][A-Za-z]+',
  '\\$[A-Za-z_]\\w*\\s*[-+*/]?=(?!=)',
  '\\[(?:System|Security|IO|Environment|Math|string|int|char|regex|datetime)[\\w.]*\\]::',
  '\\|\\s*%\\s*\\{',
].join('|'));

/** 'single' | 'double' | '' — which quote of the bash command `idx` sits in. */
function quoteStateAt(cmd, idx) {
  let st = '';
  for (let i = 0; i < idx; i++) {
    const c = cmd[i];
    if (st === 'single') { if (c === "'") st = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (st === 'double') { if (c === '"') st = ''; continue; }
    if (c === "'") st = 'single';
    else if (c === '"') st = 'double';
  }
  return st;
}

/** End index (of the closing quote) of the bash dq string whose body starts at `from`, or -1. */
function endOfDouble(cmd, from) {
  for (let i = from; i < cmd.length; i++) {
    if (cmd[i] === '\\') { i++; continue; }
    if (cmd[i] === '"') return i;
  }
  return -1;
}

/** Escape what bash would expand inside "…" but PowerShell means literally. */
function escapeDoubleBody(body) {
  let out = '';
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const nx = body[i + 1];
      if (nx !== undefined && '$`"\\\n'.includes(nx)) { out += c + nx; i++; continue; }
      out += c;
    } else if (c === '`' || (c === '$' && /[A-Za-z_({?]/.test(body[i + 1] || ''))) {
      out += '\\' + c; n++;
    } else out += c;
  }
  return { body: out, count: n };
}

/**
 * Fix `powershell|pwsh … -Command "<PowerShell>"` run through Bash. Only the quoting
 * layer changes; the PowerShell text the shell finally hands over is exactly what the
 * agent wrote. Left alone: heredoc commands, single-quoted -Command, bodies with no
 * PowerShell signal (bash expansion may be intended), matches inside other quotes.
 * @returns {{command:string, count:number}|null} null when nothing to fix
 */
function fixBashQuoting(cmd) {
  if (typeof cmd !== 'string' || !/(?:powershell|pwsh)/i.test(cmd) || /<<(?!<)/.test(cmd)) return null;
  const edits = [];
  COMMAND_FLAG.lastIndex = 0;
  let m;
  while ((m = COMMAND_FLAG.exec(cmd))) {
    const q = m[3];
    const open = m.index + m[0].length - 1;
    if (quoteStateAt(cmd, m.index + m[0].indexOf(m[1])) !== '') continue;
    if (q !== '"') continue;
    const close = endOfDouble(cmd, open + 1);
    if (close < 0) continue;
    const raw = cmd.slice(open + 1, close);
    if (!PS_SIGNAL.test(raw)) continue;
    const r = escapeDoubleBody(raw);
    if (r.count) edits.push({ from: open + 1, to: close, body: r.body, count: r.count });
    COMMAND_FLAG.lastIndex = close + 1;
  }
  if (!edits.length) return null;
  let out = '';
  let pos = 0;
  let count = 0;
  for (const e of edits) { out += cmd.slice(pos, e.from) + e.body; pos = e.to; count += e.count; }
  return { command: out + cmd.slice(pos), count };
}

/**
 * Top-level (outside quotes/brackets) pieces of one PowerShell statement split on
 * `&&` / `||`. Returns null for here-strings, unbalanced text or mixed operators.
 */
function splitChain(stmt) {
  if (/@['"]/.test(stmt)) return null;
  const parts = [];
  let ops = '';
  let depth = 0;
  let q = '';
  let last = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (q) {
      if (q === '"' && c === '`') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (stmt.startsWith('&&', i) || stmt.startsWith('||', i))) {
      const op = stmt.slice(i, i + 2);
      if (ops && ops !== op) return null;
      ops = op;
      parts.push(stmt.slice(last, i));
      last = i + 2;
      i++;
    }
  }
  if (q || depth !== 0 || !ops) return null;
  parts.push(stmt.slice(last));
  if (parts.some((x) => !x.trim())) return null;
  return { op: ops, parts: parts.map((x) => x.trim()) };
}

/** `a && b` → `a; if ($?) { b }` (|| → -not $?) for Windows PowerShell 5.1. */
function chainToIf(c) {
  const cond = c.op === '&&' ? '$?' : '-not $?';
  const rest = c.parts.slice(1);
  let out = '';
  for (let i = rest.length - 1; i >= 0; i--) out = i === rest.length - 1 ? rest[i] : `${rest[i]}; if (${cond}) { ${out} }`;
  return `${c.parts[0]}; if (${cond}) { ${out} }`;
}

/**
 * Rewrite top-level `&&`/`||` chains (PowerShell 7 only) into 5.1 `if ($?)` form,
 * statement by statement (split on top-level `;` / newline). Anything it cannot
 * rewrite exactly stays as is — lint still warns about it.
 * @returns {{text:string, count:number}|null}
 */
function fixChains51(text) {
  if (typeof text !== 'string' || !/&&|\|\|/.test(text) || /@['"]/.test(text)) return null;
  const out = [];
  let count = 0;
  let depth = 0;
  let q = '';
  let from = 0;
  const flush = (to, sep) => {
    const stmt = text.slice(from, to);
    const c = splitChain(stmt);
    if (c) {
      const lead = stmt.match(/^\s*/)[0];
      const trail = stmt.match(/\s*$/)[0];
      out.push(lead + chainToIf(c) + trail + sep);
      count++;
    } else out.push(stmt + sep);
    from = to + sep.length;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (q === '"' && c === '`') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) flush(i, c);
  }
  flush(text.length, '');
  return count ? { text: out.join(''), count } : null;
}

/** What PowerShell receives for the raw text between bash double quotes. */
function bashView(raw) {
  return raw.replace(/\\([$`"\\\n])/g, (m, c) => (c === '\n' ? '' : c));
}

/** Inverse of bashView: text that survives bash double quotes byte-for-byte. */
function toBashDouble(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '$' || c === '`' || c === '"') out += '\\' + c;
    else if (c === '\\' && (i + 1 === text.length || '$`"\\'.includes(text[i + 1]))) out += '\\\\';
    else out += c;
  }
  return out;
}

/**
 * Everything the harness fixes in `powershell|pwsh … -Command "…"` through Bash, in order:
 * (1) quoting (fixBashQuoting), (2) Windows PowerShell 5.1 only: `&&`/`||` → `if ($?)`,
 * trailing `2>&1` moved to the bash level (same merged output, no NativeCommandError).
 * @returns {{command:string, escapes:number, chains:number, stderr:number}|null}
 */
function fixBashCommand(cmd) {
  const q = fixBashQuoting(cmd);
  const base = q ? q.command : cmd;
  if (typeof base !== 'string' || !/(?:powershell)/i.test(base) || /<<(?!<)/.test(base)) return q ? { command: base, escapes: q.count, chains: 0, stderr: 0 } : null;
  let chains = 0;
  let stderr = 0;
  let out = '';
  let pos = 0;
  COMMAND_FLAG.lastIndex = 0;
  let m;
  while ((m = COMMAND_FLAG.exec(base))) {
    const open = m.index + m[0].length - 1;
    const quote = m[3];
    const close = quote === '"' ? endOfDouble(base, open + 1) : base.indexOf("'", open + 1);
    if (close < 0) break;
    COMMAND_FLAG.lastIndex = close + 1;
    if (/^pwsh/i.test(m[1]) || quoteStateAt(base, m.index + m[0].indexOf(m[1])) !== '') continue;
    const raw = base.slice(open + 1, close);
    let text = quote === '"' ? bashView(raw) : raw;
    let suffix = '';
    const tail = text.match(/^([\s\S]*\S)\s*2>&1\s*$/);
    if (tail && !/2>&1/.test(tail[1])) { text = tail[1]; suffix = ' 2>&1'; stderr++; }
    const ch = fixChains51(text);
    if (ch) { text = ch.text; chains += ch.count; }
    if (text === (quote === '"' ? bashView(raw) : raw) && !suffix) continue;
    out += base.slice(pos, open + 1) + (quote === '"' ? toBashDouble(text) : text);
    pos = close;
    if (suffix) { out += base.slice(pos, close + 1) + suffix; pos = close + 1; }
  }
  out += base.slice(pos);
  if (!chains && !stderr && !q) return null;
  return { command: out, escapes: q ? q.count : 0, chains, stderr };
}

/**
 * The PowerShell text inside the Bash command's -Command words (single or double
 * quoted), for linting. The Bash tool's own `&&` / `2>&1` are not PowerShell.
 * @returns {Array<{edition:'5.1'|'7', text:string}>}
 */
function bashPowershellBodies(cmd) {
  const out = [];
  if (typeof cmd !== 'string') return out;
  COMMAND_FLAG.lastIndex = 0;
  let m;
  while ((m = COMMAND_FLAG.exec(cmd))) {
    const open = m.index + m[0].length - 1;
    const edition = /^pwsh/i.test(m[1]) ? '7' : '5.1';
    if (m[3] === '"') {
      const close = endOfDouble(cmd, open + 1);
      if (close < 0) continue;
      out.push({ edition, text: cmd.slice(open + 1, close).replace(/\\(["$`\\])/g, '$1') });
      COMMAND_FLAG.lastIndex = close + 1;
    } else {
      const close = cmd.indexOf("'", open + 1);
      if (close < 0) continue;
      out.push({ edition, text: cmd.slice(open + 1, close) });
      COMMAND_FLAG.lastIndex = close + 1;
    }
  }
  return out;
}

/** Drop comments and string contents so a lint never fires on text inside a literal. */
function stripLiterals(ps) {
  return ps
    .replace(/<#[\s\S]*?#>/g, ' ')
    .replace(/@'[\s\S]*?'@/g, "''")
    .replace(/@"[\s\S]*?"@/g, '""')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"`]|`[\s\S])*"/g, '""')
    .replace(/(^|[\s;])#[^\n]*/g, '$1');
}

const RULES_51 = [
  { id: 'chain-operator', re: /&&|\|\|/, tip: '`&&`/`||` só existem no PowerShell 7. No 5.1: `a; if ($?) { b }` ou chamadas separadas.' },
  { id: 'null-coalescing', re: /\?\?=?|\$\w+\?\.|\$\{[^}]+\}\?\./, tip: '`??`, `??=` e `?.` só existem no PowerShell 7. No 5.1: `if ($null -eq $x) { … }`.' },
  { id: 'ternary', re: /\s\?\s(?!\{)[^\n;?{}]*\s:\s/, tip: 'o ternário `c ? a : b` só existe no PowerShell 7. No 5.1: `if (c) { a } else { b }`.' },
  { id: 'pwsh7-parameter', re: /-(?:AsHashtable|AsByteStream|Parallel|SkipHttpErrorCheck|SkipCertificateCheck|NoProxy)\b|-Encoding\s+utf8NoBOM/i, tip: 'parâmetro que só existe no PowerShell 7 (`-AsHashtable`, `-Parallel`, `-AsByteStream`, `-Encoding utf8NoBOM`…): no 5.1 dá "parameter cannot be found".' },
  { id: 'native-stderr', re: /2>&1/, tip: 'no 5.1, `2>&1` num exe nativo transforma cada linha de stderr em NativeCommandError e o exit vira 1. Tire o `2>&1` de dentro do PowerShell (no Bash, ponha-o depois do `powershell …`) ou use `pwsh`.' },
  { id: 'utf16-redirect', re: /(?:^|[\s)])>>?\s*(?!\$null\b|&)[^\s&|]/, tip: 'no 5.1, `>`/`>>` gravam UTF-16LE com BOM. Use `Set-Content -Encoding UTF8` (grava BOM) ou `[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding $false))`.' },
  { id: 'utf8-bom', re: /(?:Set-Content|Out-File|Add-Content|Export-Csv)\b[^\n|;]*-Encoding\s+utf8\b/i, tip: 'no 5.1, `-Encoding utf8` grava BOM (no 7 não grava). Para UTF-8 sem BOM: `[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding $false))`.' },
];
const RULES_7 = [
  { id: 'removed-cmdlet', re: /\b(?:Get-WmiObject|Set-WmiInstance|Invoke-WmiMethod|Remove-WmiObject|Get-EventLog|Clear-EventLog|Write-EventLog|Add-PSSnapin|New-WebServiceProxy)\b/i, tip: 'cmdlet que não existe no PowerShell 7 (WMI v1, *-EventLog, *-PSSnapin). Use `Get-CimInstance`, `Get-WinEvent`, módulos.' },
  { id: 'encoding-byte', re: /-Encoding\s+Byte\b/i, tip: '`-Encoding Byte` não existe no PowerShell 7: use `-AsByteStream` (e `Get-Content -Raw`/`[IO.File]::ReadAllBytes`).' },
];

/**
 * Lint PowerShell text for the edition that will run it.
 * @param {string} text
 * @param {'5.1'|'7'} edition
 * @returns {Array<{id:string, tip:string}>}
 */
function lint(text, edition) {
  const code = stripLiterals(String(text || ''));
  const rules = edition === '5.1' ? RULES_51 : RULES_7;
  return rules.filter((r) => r.re.test(code)).map(({ id, tip }) => ({ id, tip }));
}

/** Lint a Bash command (the -Command bodies only). */
function lintBash(cmd) {
  const hits = [];
  for (const b of bashPowershellBodies(cmd)) for (const h of lint(b.text, b.edition)) hits.push({ ...h, edition: b.edition });
  return hits;
}

/** Short pt-BR warning from lint hits, or null. */
function renderWarning(hits, label) {
  if (!hits.length) return null;
  const ed = [...new Set(hits.map((h) => h.edition).filter(Boolean))];
  const head = label || (ed.length ? `PowerShell ${ed.join('/')}` : 'PowerShell');
  return `[boss] ${head}: ${hits.map((h) => h.tip).join(' ')}`;
}

let _pwshMemo = null;
/** Is pwsh (7) on PATH? Scans PATH on disk — no spawn, safe in the daemon. Memoized per PATH. */
function pwshOnPath(env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  if (_pwshMemo && _pwshMemo.key === pathVar) return _pwshMemo.found;
  const fs = require('fs');
  const path = require('path');
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  const found = pathVar.split(path.delimiter).filter(Boolean).some((d) => exts.some((e) => fs.existsSync(path.join(d, 'pwsh' + e))));
  _pwshMemo = { key: pathVar, found };
  return found;
}

/** Edition the PowerShell tool runs: pwsh 7 when found on PATH, else Windows PowerShell 5.1. */
function toolEdition(env) {
  return pwshOnPath(env) ? '7' : '5.1';
}

module.exports = { fixBashCommand, fixChains51, pwshOnPath, toolEdition, fixBashQuoting, bashPowershellBodies, lint, lintBash, renderWarning, stripLiterals, PS_SIGNAL };
