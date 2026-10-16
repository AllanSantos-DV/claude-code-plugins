'use strict';
/**
 * lib/shell-escape.js — fix, before it runs, a Bash command that Claude Code's Bash
 * tool would corrupt on Windows.
 *
 * The bug is upstream and open (anthropics/claude-code #85856, #98622, #98733,
 * #32563, #90630): on the way from the tool to bash.exe every run of 2+ backslashes
 * is halved — even inside single quotes and quoted heredocs — and a heredoc whose
 * body holds single quotes can die with "unexpected EOF". Measured here on CC
 * 2.1.293: `printf %s 'a\\b'` prints `a\b`; a `<<'EOF'` body `x\\y` arrives `x\y`.
 *
 * The hook sees the command exactly as the agent wrote it, so it can take the
 * fragile PAYLOAD out of the command line and hand it to bash as a file, byte for
 * byte — the command itself stays visible (permission rules still match it):
 *   - heredoc     `cmd <<'EOF' … EOF`      → `cmd < '<file>'`
 *   - inline code `node [flags] -e '<js>'` → `node [flags] < '<file>'`
 *                 `python -c '<py>'`       → `python - < '<file>'`
 * Stdin keeps the semantics of the inline form: modules resolve from the cwd, not
 * the file's folder (python: sys.path[0] is the absolute cwd instead of '' — only a
 * script that chdir()s and then imports can tell). When the payload can't be reproduced exactly
 * (shell expansion inside it, trailing args, stdin already in use…) nothing is
 * rewritten and the caller only WARNS (or denies, if configured).
 *
 * Pure: plans the rewrite and the files to write; the caller writes them.
 */

const crypto = require('crypto');

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const NAME_START = /[A-Za-z_{(0-9@*#?$!-]/;

// Git Bash maps /tmp to %TEMP%; a native Windows python/node resolves '/tmp/x' to C:\\tmp\\x. A file
// written by one and read by the other "doesn't exist" — nothing to do with how the command was sent.
const TMP_NOTE = '[boss] Windows: `/tmp/…` em python/node nativo aponta para C:\\tmp, não para o /tmp do Git Bash (%TEMP%) — um arquivo gravado por um e lido pelo outro "não existe". Use um caminho da pasta de trabalho (ou os.tmpdir()/tempfile).';
const TMP_PATH_RE = /(^|[\s'"=(,])\/tmp\//;

const ADVICE = 'Para script de mais de uma linha, grave-o com a ferramenta Write num arquivo da pasta de trabalho e rode `node arquivo` / `python -I arquivo`; para mudar arquivo use Edit, nunca regex/sed em linha de comando.';

/**
 * Bash value of the word starting at `i` (quote removal + escapes), or `dynamic`
 * when bash would expand something in it ($var, `cmd`, globs, ANSI-C quotes).
 * @returns {{value:string, end:number, dynamic:boolean}}
 */
function parseWord(s, i) {
  let value = '';
  let dynamic = false;
  let j = i;
  while (j < s.length && !META.has(s[j])) {
    const c = s[j];
    if (c === "'") {
      const close = s.indexOf("'", j + 1);
      if (close < 0) return { value, end: s.length, dynamic: true };
      value += s.slice(j + 1, close);
      j = close + 1;
    } else if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') {
        const d = s[j];
        if (d === '\\' && j + 1 < s.length) {
          const n = s[j + 1];
          if (n === '\n') { j += 2; continue; }
          if ('$`"\\'.includes(n)) { value += n; j += 2; continue; }
          value += d; j++; continue;
        }
        if (d === '`' || (d === '$' && j + 1 < s.length && NAME_START.test(s[j + 1]))) dynamic = true;
        value += d; j++;
      }
      if (j >= s.length) return { value, end: s.length, dynamic: true };
      j++;
    } else if (c === '\\') {
      if (j + 1 < s.length && s[j + 1] !== '\n') value += s[j + 1];
      j += 2;
    } else {
      if (c === '`' || '*?[~'.includes(c) || (c === '$' && j + 1 < s.length && (NAME_START.test(s[j + 1]) || s[j + 1] === "'" || s[j + 1] === '"'))) dynamic = true;
      value += c;
      j++;
    }
  }
  return { value, end: j, dynamic };
}

/**
 * Every heredoc in the command, found by a quote-aware scan.
 * @returns {{ok:boolean, docs:Array<{opStart:number, opEnd:number, bodyStart:number, bodyEnd:number, body:string, quoted:boolean}>}}
 *   ok=false when the scan hit something it can't reason about (an unterminated
 *   heredoc, quote or `$((`) — then nothing may be rewritten.
 */
function findHeredocs(s) {
  const docs = [];
  let pending = [];
  let i = 0;
  const quoted = []; // [start, end) of every quoted string — not command positions
  // Lexer frames: {dq:start} = inside "…"; {depth} = inside $( … ) — a fresh command
  // context even within double quotes, which is where `git commit -m "$(cat <<'EOF'`
  // puts its heredoc.
  const stack = [];
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const c = s[i];
    if (top() && top().dq !== undefined) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { quoted.push([stack.pop().dq, i + 1]); i++; continue; }
      if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') { stack.push({ depth: 1 }); i += 2; continue; }
      i++; continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return { ok: false, docs: [] };
      quoted.push([i, close + 1]);
      i = close + 1;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === '"') { stack.push({ dq: i }); i++; continue; }
    if (top() && (c === '(' || c === ')')) {
      top().depth += c === '(' ? 1 : -1;
      if (top().depth === 0) stack.pop();
      i++; continue;
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') { stack.push({ depth: 1 }); i += 2; continue; }
    if (c === '$' && s.startsWith('$((', i)) {
      // Arithmetic: its `<<` is a shift, not a heredoc.
      const close = s.indexOf('))', i + 3);
      if (close < 0) return { ok: false, docs: [] };
      i = close + 2;
      continue;
    }
    if (c === '#' && (i === 0 || META.has(s[i - 1]))) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const opStart = i;
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      const w = parseWord(s, j);
      const raw = s.slice(j, w.end);
      if (!raw) return { ok: false, docs: [] };
      pending.push({ opStart, opEnd: w.end, delim: w.value, quoted: /['"\\]/.test(raw), strip });
      i = w.end;
      continue;
    }
    if (c === '\n' && pending.length) {
      let pos = i + 1;
      for (const p of pending) {
        const lines = [];
        let found = false;
        while (pos <= s.length) {
          const nl = s.indexOf('\n', pos);
          const lineEnd = nl < 0 ? s.length : nl;
          let line = s.slice(pos, lineEnd);
          if (p.strip) line = line.replace(/^\t+/, '');
          const next = nl < 0 ? s.length : nl + 1;
          if (line === p.delim) { found = true; p.bodyEnd = next; pos = next; break; }
          lines.push(line);
          if (nl < 0) { pos = s.length + 1; break; }
          pos = next;
        }
        if (!found) return { ok: false, docs: [] };
        p.body = lines.length ? lines.join('\n') + '\n' : '';
      }
      pending[0].bodyStart = i + 1;
      for (let k = 1; k < pending.length; k++) pending[k].bodyStart = pending[k - 1].bodyEnd;
      docs.push(...pending);
      pending = [];
      i = pos;
      continue;
    }
    i++;
  }
  if (stack.length || pending.length) return { ok: false, docs: [] };
  return { ok: true, docs, quoted };
}

// Inline code: `node … -e <word>` / `python … -c <word>` at a command position.
const INLINE_RE = /(^|[\n;&|(]\s*)((?:[\w./\\:-]*[\\/])?(node|python3?|py)(?:\.exe)?)(?=\s)/g;
const STDIN_RE = /process\.stdin|readFileSync\(\s*0|\/dev\/stdin|sys\.stdin|\binput\s*\(/;

/**
 * Every `node -e` / `python -c` at a command position (not inside a quoted string
 * or a heredoc body) with its parsed code word.
 * @param {string} s
 * @param {Array<[number, number]>} skip  spans that are data, not commands
 * @returns {Array<{prog:string, isNode:boolean, flagStart:number, bodyEnd:number, body:string, unsafe?:string}>}
 *   unsafe: why it can't be moved to stdin as-is (expansion | args | stdin | print).
 */
function findInline(s, skip = []) {
  const out = [];
  for (const m of s.matchAll(INLINE_RE)) {
    const at = m.index + m[1].length;
    if (skip.some(([a, b]) => at >= a && at < b)) continue;
    const prog = m[3];
    const isNode = prog === 'node';
    const progEnd = m.index + m[0].length;
    const before = s.slice(0, m.index + m[1].length).replace(/\s+$/, '');
    let j = progEnd;
    let flag = null;
    let flagStart = -1;
    // Interpreter flags before -e/-c: only self-contained ones (`--x`, `--x=y`, `-I`, `-u`…).
    while (j < s.length) {
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] !== '-') break;
      const w = parseWord(s, j);
      const tok = s.slice(j, w.end);
      if (isNode ? ['-e', '--eval', '-p', '--print'].includes(tok) : tok === '-c') { flag = tok; flagStart = j; j = w.end; break; }
      if (isNode ? !/^--[\w-]+(=\S+)?$/.test(tok) : !/^-[A-Za-z]+$/.test(tok)) break;
      j = w.end;
    }
    if (!flag) continue;
    while (s[j] === ' ' || s[j] === '\t') j++;
    const w = parseWord(s, j);
    const entry = { prog, isNode, flagStart, bodyEnd: w.end, body: w.value };
    // -p prints the value of the last expression; stdin doesn't — can't be moved.
    if (flag === '-p' || flag === '--print') { out.push({ ...entry, unsafe: 'print' }); continue; }
    if (w.dynamic) { out.push({ ...entry, unsafe: 'expansion' }); continue; }
    let k = w.end;
    while (s[k] === ' ' || s[k] === '\t') k++;
    const rest = s.slice(k);
    if (rest && !/^(\n|;|&&|\|\||\||[12]?>|&>|$)/.test(rest)) { out.push({ ...entry, unsafe: 'args' }); continue; }
    if (/(^|[^|])\|$/.test(before) || STDIN_RE.test(w.value)) { out.push({ ...entry, unsafe: 'stdin' }); continue; }
    out.push(entry);
  }
  return out;
}

const hashName = (content, ext) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16) + ext;

/**
 * Plan the fix for one command.
 * @param {string} command  as the agent wrote it (PreToolUse tool_input.command)
 * @param {{dir:string, inlineMaxChars?:number, mode?:'rewrite'|'warn'}} opts
 *   dir: folder the payload files go to, in a form bash accepts (forward slashes).
 * @returns {null | {command:string|null, files:Array<{name:string, content:string}>, kinds:string[], warn:string|null, note?:string|null}}
 *   note: informational (the /tmp pitfall) — never denies.
 *   null = nothing at risk. command = the rewritten command (null when not rewritten).
 */
function planEscapeFix(command, { dir, inlineMaxChars = 300, mode = 'rewrite' } = {}) {
  const s = String(command || '');
  const interp = /\b(node|python3?|py)(\.exe)?\s/.test(s);
  const note = interp && TMP_PATH_RE.test(s) ? TMP_NOTE : null;
  if (!s.includes('<<') && !interp && !s.includes('\\\\')) return null;
  if (mode === 'rewrite' && (!dir || dir.includes("'"))) mode = 'warn';

  const edits = []; // {start, end, text}
  const files = [];
  const kinds = [];
  const unsafe = [];

  const heredocs = findHeredocs(s);
  if (!heredocs.ok && s.includes('<<')) unsafe.push('heredoc');
  for (const d of heredocs.docs) {
    if (!d.quoted && /[$`\\]/.test(d.body)) { unsafe.push('heredoc'); continue; }
    if (mode !== 'rewrite') { unsafe.push('heredoc'); continue; }
    const name = hashName(d.body, '.txt');
    files.push({ name, content: d.body });
    edits.push({ start: d.opStart, end: d.opEnd, text: `< '${dir}/${name}'` });
    edits.push({ start: d.bodyStart, end: d.bodyEnd, text: '' });
    kinds.push('heredoc');
  }

  // Inline code inside a quoted string or a heredoc body is data, not a command.
  const skip = [...(heredocs.quoted || []), ...heredocs.docs.map((d) => [d.bodyStart, d.bodyEnd])];
  for (const e of findInline(s, skip)) {
    const risky = e.body.includes('\\') || e.body.includes('\n') || e.body.includes("'") || e.body.length > inlineMaxChars;
    if (!risky) continue;
    const kind = e.unsafe === 'print' ? 'node-p' : e.isNode ? 'node-e' : 'python-c';
    // Unlexable command (unbalanced quote…): positions can't be trusted — warn only.
    if (e.unsafe || !heredocs.ok || mode !== 'rewrite') { unsafe.push(kind); continue; }
    const name = hashName(e.body, e.isNode ? '.js' : '.py');
    files.push({ name, content: e.body });
    edits.push({ start: e.flagStart, end: e.bodyEnd, text: `${e.isNode ? '' : '- '}< '${dir}/${name}'` });
    kinds.push(kind);
  }

  let out = s;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // What is left on the command line still goes through the halving.
  if (/\\\\/.test(out)) unsafe.push('double-backslash');

  if (!edits.length && !unsafe.length) return note ? { command: null, files: [], kinds: [], warn: null, note } : null;
  const uniq = [...new Set(unsafe)];
  const warn = uniq.length
    ? `[boss] Bash no Windows: o Bash tool do Claude Code corrompe este comando antes do bash (corta \\\\ pela metade e quebra heredoc com aspas — bug aberto, anthropics/claude-code #85856/#32563); não deu para corrigir sozinho (${uniq.join(', ')}). ${ADVICE}`
    : null;
  return { command: edits.length ? out : null, files, kinds, warn, note };
}

module.exports = { planEscapeFix, parseWord, findHeredocs, findInline, ADVICE };
