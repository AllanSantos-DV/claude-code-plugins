// ESLint flat config (CJS for package.json type:commonjs)
//
// Single source of truth for STATIC quality — invoked via `npm run gate` both
// locally and in CI (the workflow calls the same script). Catch-masking is
// enforced here by AST rules (NOT greps), so it works cross-platform and covers
// both scripts/ (CJS) and servers/ (ESM):
//   - no-empty (allowEmptyCatch:false)      → empty catch{}
//   - local/no-silent-return-catch (below)  → a catch that returns WITHOUT
//     logging / `void err` / throw / using the caught binding.

/** @type {import('eslint').Rule.RuleModule} */
const noSilentReturnCatch = {
  meta: {
    type: 'problem',
    docs: { description: 'a catch that returns must acknowledge the error (console.* / void / throw / use the binding)' },
    schema: [],
    messages: {
      masked: 'catch returns without logging/acknowledging the error — log it (console.error) or `void err;` before the return',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();
    return {
      CatchClause(node) {
        // Only flag catches that RETURN directly (the masking shape).
        if (!node.body.body.some((s) => s.type === 'ReturnStatement')) return;
        // Acknowledged if it carries an explanatory comment — the project's
        // documented fail-safe idiom: `catch { /* why */ return fallback }`.
        if (sourceCode.getCommentsInside(node.body).length > 0) return;
        // ...or if it logs, voids/throws, or uses the caught binding.
        const text = sourceCode.getText(node.body);
        const param = node.param && node.param.type === 'Identifier' ? node.param.name : null;
        const acknowledges =
          /\bconsole\s*\./.test(text) ||
          /\bvoid\b/.test(text) ||
          /\bthrow\b/.test(text) ||
          (param != null && new RegExp(`\\b${param}\\b`).test(text));
        if (!acknowledges) context.report({ node, messageId: 'masked' });
      },
    };
  },
};

// Hooks run without a console under Claude Code Desktop on Windows. Any
// child_process call there WITHOUT `windowsHide: true` pops a visible cmd window
// that steals focus/keystrokes — multiplied per hook × subagent × session (the
// 2.29.0 regression: nvidia-smi / git / powershell flashing dozens of windows).
//
// DENY BY DEFAULT: a rule that tries to follow every way a value can flow
// (aliases, bind, promisify, injection, exports…) never closes, and every gap
// is a silent miss. So only the canonical shapes are allowed:
//   const cp = require('child_process')      import * as cp / import cp from '…'
//   const { spawn, exec: ex } = require('…') import { spawn } from '…'
//   const { spawn } = cp                     const cp = await import('…')
// bound ONCE with const/import (never reassigned, not exported), then ONLY
// called directly — `spawn(…)`, `cp.spawn(…)`, `cp?.spawn?.(…)` — with an
// object LITERAL in the options slot Node actually reads (index 1 for
// exec/execSync; index 1, or 2 after an args argument, for the rest) holding
// `windowsHide: true` after any spread or computed key, and no spread among the
// call arguments. `require` also covers `.require` members, createRequire()
// results and `require.call`.
//
// Everything else is reported:
//   - any other use of a child_process binding, member, require or import();
//   - ANY other 'child_process' string literal in the file (aliased require,
//     process.getBuiltinModule, Module._load, even a log message) — the module
//     can only be named in a shape the rule verifies;
//   - the internal spawn bindings 'spawn_sync' / 'process_wrap' (reached via
//     process.binding however aliased), as any string literal;
//   - data: URL specifiers in an import / export / import() or passed to
//     `register` / `module.register` (a loader hook), normalised
//     like the URL parser (case, leading space, tab/CR/LF anywhere);
//   - the other core modules that spawn on their own: 'cluster',
//     'node:cluster', 'node:test', as any exact string literal.
// Inline eslint comments are disabled for these files (noInlineConfig), so the
// rule cannot be switched off locally.
//
// Known limits: a ChildProcess reached through a call's RETURN value
// (`cp.spawn(…).constructor`) is runtime reflection the rule does not follow; a
// non-literal expression in the args slot that actually holds the options or a
// callback (`spawn(cmd, getOpts(), { windowsHide: true })`) is only caught when
// it is a variable initialised with an object literal or a function; module
// specifiers not written as a string literal in the import itself (a variable,
// a URL object, `require(name)`, 'child_' + 'process') and code run from
// strings (eval, new Function, vm, Worker `eval: true`) are out of reach of any
// linter; an internal binding name not written as a literal
// (`process.binding('spawn' + '_sync')`) is not caught; third-party packages that spawn (node_modules) are not linted, nor
// are files whose extension is not lower-case .js/.mjs/.cjs/.ts/.mts/.cts
// (TypeScript-only syntax fails to parse, which fails the gate loudly).
const CHILD_PROCESS_FNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const OPTIONS_AT_1 = new Set(['exec', 'execSync']);
const isChildProcessSource = (v) => v === 'child_process' || v === 'node:child_process';
const isCpLiteral = (n) => !!n && ((n.type === 'Literal' && isChildProcessSource(n.value)) ||
  (n.type === 'TemplateLiteral' && n.expressions.length === 0 && isChildProcessSource(n.quasis[0].value.cooked)));
const SPAWN_BINDINGS = new Set(['spawn_sync', 'process_wrap']);
// Other core modules that start processes without windowsHide by default.
const SPAWNING_MODULES = new Set(['cluster', 'node:cluster', 'node:test']);
// Is `n` the source of an import / export-from / import()?
const isImportSource = (n) => {
  const p = n.parent;
  return !!p && (p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration'
    || p.type === 'ExportAllDeclaration' || p.type === 'ImportExpression') && p.source === n;
};
// module.register('data:…') installs a loader hook whose code can spawn: any
// argument of a call to `register` / `x.register` counts as a specifier.
const isRegisterArg = (n) => {
  const p = n.parent;
  if (!p || p.type !== 'CallExpression' || !p.arguments.includes(n)) return false;
  const c = p.callee;
  return (c.type === 'Identifier' && c.name === 'register') || (c.type === 'MemberExpression' && propName(c) === 'register');
};
const literalText = (n) => (n.type === 'Literal' ? n.value : (n.expressions.length === 0 ? n.quasis[0].value.cooked : null));
const isSpawnBinding = (n) => (n.type === 'Literal' && SPAWN_BINDINGS.has(n.value)) ||
  (n.type === 'TemplateLiteral' && n.expressions.length === 0 && SPAWN_BINDINGS.has(n.quasis[0].value.cooked));
const propName = (m) => {
  if (!m.computed && m.property.type === 'Identifier') return m.property.name;
  if (m.computed && m.property.type === 'Literal' && typeof m.property.value === 'string') return m.property.value;
  return null;
};
const isCreateRequire = (c) => c.type === 'CallExpression' && (
  (c.callee.type === 'Identifier' && c.callee.name === 'createRequire') ||
  (c.callee.type === 'MemberExpression' && propName(c.callee) === 'createRequire'));
// Skip wrappers that do not change the value: `(await import(x))`, `a?.b`.
const unwrap = (n) => (n && (n.type === 'AwaitExpression' || n.type === 'ChainExpression') ? unwrap(n.type === 'AwaitExpression' ? n.argument : n.expression) : n);
const outer = (n) => {
  let c = n;
  while (c.parent && ((c.parent.type === 'ChainExpression') || (c.parent.type === 'AwaitExpression'))) c = c.parent;
  return c;
};

/** @type {import('eslint').Rule.RuleModule} */
const requireWindowsHide = {
  meta: {
    type: 'problem',
    docs: { description: 'child_process calls must pass `windowsHide: true` (no console window flashing on Windows)' },
    schema: [],
    messages: {
      missing: '{{fn}}() without `windowsHide: true` in its options object literal (after any spread) opens a visible console window on Windows',
      escape: '{{what}} cannot be verified by require-windows-hide — spawn only through child_process bound once with const/import and called directly with `windowsHide: true`',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();
    const calls = [];
    const imports = [];
    const reexports = []; // sources of re-exports (already reported)
    const literals = []; // every 'child_process' string: loaders we don't know (aliased require, getBuiltinModule…) still name it
    const reportEscape = (node, what) => context.report({ node, messageId: 'escape', data: { what } });

    return {
      CallExpression(node) { calls.push(node); },
      ImportExpression(node) { calls.push(node); },
      ImportDeclaration(node) { if (isChildProcessSource(node.source.value)) imports.push(node); },
      'ExportNamedDeclaration, ExportAllDeclaration'(node) {
        if (node.source && isChildProcessSource(node.source.value)) { reexports.push(node.source); reportEscape(node, 'child_process re-export'); }
      },
      // process.binding('spawn_sync' | 'process_wrap') spawns without child_process
      // at all; however process/binding is reached, the binding name is a literal.
      'Literal, TemplateLiteral'(node) {
        if (isCpLiteral(node)) { literals.push(node); return; }
        if (isSpawnBinding(node)) { reportEscape(node, 'internal spawn binding (process.binding)'); return; }
        const text = literalText(node);
        if (typeof text !== 'string') return;
        // data: URLs (import / module.register only) can reach child_process; cluster / node:test spawn on their own.
        // Normalise like the WHATWG URL parser: tab/CR/LF are stripped anywhere,
        // leading/trailing C0+space trimmed, and the scheme is case-insensitive.
        const url = text.replace(/[\t\r\n]/g, '').replace(/^[\u0000-\u0020]+/, '').toLowerCase();
        if (url.startsWith('data:') && (isImportSource(node) || isRegisterArg(node))) reportEscape(node, 'data: URL module specifier');
        else if (SPAWNING_MODULES.has(text)) reportEscape(node, `process-spawning module '${text}'`);
      },
      'Program:exit'() {
        const sm = sourceCode.scopeManager;
        const refVar = new Map();
        for (const scope of sm.scopes) for (const ref of scope.references) if (ref.resolved) refVar.set(ref.identifier, ref.resolved);

        const requireVars = new Set(); // bindings holding createRequire(...)
        for (const scope of sm.scopes) {
          for (const v of scope.variables) {
            const d = v.defs[0];
            if (d && d.type === 'Variable' && d.node.id.type === 'Identifier' && d.node.init && isCreateRequire(d.node.init)) requireVars.add(v);
          }
        }
        const isRequireFn = (c) => (c.type === 'Identifier' && (c.name === 'require' || requireVars.has(refVar.get(c))))
          || (c.type === 'MemberExpression' && propName(c) === 'require') || isCreateRequire(c);
        const isCpSource = (n) => {
          if (!n) return false;
          if (n.type === 'ImportExpression') return isCpLiteral(n.source);
          if (n.type !== 'CallExpression') return false;
          const c = n.callee;
          if (isRequireFn(c)) return isCpLiteral(n.arguments[0]);
          if (c.type === 'MemberExpression' && propName(c) === 'call' && isRequireFn(c.object)) return isCpLiteral(n.arguments[1]);
          return false;
        };

        const kind = new Map(); // Variable -> { kind:'ns' } | { kind:'fn', fn }
        const accepted = new Set(); // source nodes consumed by an allowed binding
        // A binding is trusted only if it is written exactly once (its init/import) and not exported.
        const bindOnce = (v, info, node) => {
          if (!v) return;
          const def = v.defs[0];
          const exported = def && def.parent && def.parent.parent && def.parent.parent.type === 'ExportNamedDeclaration';
          if (exported || (def && def.type === 'Variable' && def.parent.kind !== 'const')) {
            reportEscape(node, `child_process binding '${v.name}' (reassigned or exported)`);
            return;
          }
          kind.set(v, info);
        };
        const bindPattern = (pattern, nsInfo, srcNode) => {
          if (pattern.type === 'Identifier') { bindOnce(refVar.get(pattern) || declared(pattern), nsInfo, pattern); return true; }
          if (pattern.type !== 'ObjectPattern') return false;
          for (const p of pattern.properties) {
            if (p.type !== 'Property' || p.value.type !== 'Identifier') { reportEscape(p, 'child_process destructuring (rest/nested/default)'); continue; }
            let k = null;
            if (!p.computed && p.key.type === 'Identifier') k = p.key.name;
            else if (p.key.type === 'Literal') k = String(p.key.value);
            if (k && CHILD_PROCESS_FNS.has(k)) bindOnce(declared(p.value), { kind: 'fn', fn: k }, p.value);
            else reportEscape(p, `child_process member '${k || '[computed]'}'`);
          }
          void srcNode;
          return true;
        };
        const declaredMap = new Map();
        for (const scope of sm.scopes) for (const v of scope.variables) for (const id of v.identifiers) declaredMap.set(id, v);
        const declared = (id) => declaredMap.get(id);

        // 1) Imports.
        for (const decl of imports) {
          for (const v of sm.getDeclaredVariables(decl)) {
            const spec = v.defs[0].node;
            const imported = spec.type === 'ImportSpecifier'
              ? (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) : 'default';
            if (CHILD_PROCESS_FNS.has(imported)) bindOnce(v, { kind: 'fn', fn: imported }, spec);
            else if (imported === 'default') bindOnce(v, { kind: 'ns' }, spec);
            else reportEscape(spec, `child_process import '${imported}'`);
          }
        }
        // 2) const x = require(cp) / await import(cp) / const {…} = require(cp).
        const handled = new Set(); // 'child_process' literals judged by a known shape
        for (const d of imports) handled.add(d.source);
        for (const s of reexports) handled.add(s);
        for (const c of calls) {
          if (!isCpSource(c)) continue;
          handled.add(c.type === 'ImportExpression' ? c.source : (isCpLiteral(c.arguments[0]) ? c.arguments[0] : c.arguments[1]));
          const top = outer(c);
          const p = top.parent;
          if (p && p.type === 'VariableDeclarator' && p.init === top && bindPattern(p.id, { kind: 'ns' }, c)) { accepted.add(c); continue; }
          // require(cp).spawn(...) / (await import(cp)).spawn(...) — checked below.
          if (p && p.type === 'MemberExpression' && p.object === top) { accepted.add(c); continue; }
          reportEscape(c, 'child_process require/import()');
        }
        // 3) const { spawn } = cp  (destructure an ns binding).
        for (const [v, info] of [...kind]) {
          if (info.kind !== 'ns') continue;
          for (const ref of v.references) {
            if (!ref.isRead()) continue;
            const top = outer(ref.identifier);
            const p = top.parent;
            if (p && p.type === 'VariableDeclarator' && p.init === top && p.id.type === 'ObjectPattern') {
              bindPattern(p.id, info, ref.identifier);
              accepted.add(ref.identifier);
            }
          }
        }

        // Where a child_process fn is invoked: callee node → fn name.
        const fnOf = (callee) => {
          const n = unwrap(callee);
          if (n.type === 'Identifier') { const i = kind.get(refVar.get(n)); return i && i.kind === 'fn' ? i.fn : null; }
          if (n.type === 'MemberExpression') {
            const o = unwrap(n.object);
            const isNs = (o.type === 'Identifier' && (kind.get(refVar.get(o)) || {}).kind === 'ns') || isCpSource(o);
            const pn = propName(n);
            return isNs && pn && CHILD_PROCESS_FNS.has(pn) ? pn : null;
          }
          return null;
        };
        const isObjectVar = (x) => {
          if (x.type !== 'Identifier') return false;
          const v = refVar.get(x);
          const d = v && v.defs[0];
          return !!(d && d.node.type === 'VariableDeclarator' && d.node.init && d.node.init.type === 'ObjectExpression');
        };
        // A function (or class — typeof 'function') in the args slot is a CALLBACK: Node then drops any later
        // options (execFile(file, cb, opts) → options = null), so there are none.
        const isFunctionLike = (x) => {
          if (x.type === 'FunctionExpression' || x.type === 'ArrowFunctionExpression' || x.type === 'ClassExpression') return true;
          if (x.type !== 'Identifier') return false;
          const d = (refVar.get(x) || { defs: [] }).defs[0];
          if (!d) return false;
          if (d.type === 'FunctionName' || d.type === 'ClassName') return true;
          return d.node.type === 'VariableDeclarator' && !!d.node.init
            && ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(d.node.init.type);
        };
        const optionsArg = (fn, args) => {
          if (OPTIONS_AT_1.has(fn)) return args[1];
          if (args[1] && isFunctionLike(args[1])) return null;
          if (args[1] && (args[1].type === 'ObjectExpression' || isObjectVar(args[1]))) return args[1];
          // Any other literal (a regex is typeof 'object' to Node and becomes the
          // options; strings/numbers throw) is never an args array: the options
          // slot is then that literal, which cannot carry windowsHide.
          if (args[1] && ((args[1].type === 'Literal' && args[1].value !== null) || args[1].regex || args[1].type === 'TemplateLiteral')) return args[1];
          return args[2];
        };
        const hidden = (opt) => {
          if (!opt || opt.type !== 'ObjectExpression') return false;
          let lastOverride = -1;
          let lastHide = -1;
          let hideTrue = false;
          opt.properties.forEach((p, i) => {
            if (p.type === 'SpreadElement' || (p.computed && p.key.type !== 'Literal')) { lastOverride = i; return; }
            const k = !p.computed && p.key.type === 'Identifier' ? p.key.name : p.key.value;
            if (k === 'windowsHide') { lastHide = i; hideTrue = p.value.type === 'Literal' && p.value.value === true; }
          });
          return hideTrue && lastHide > lastOverride;
        };

        // 4) Every read of a trusted binding must be a direct call (or the destructure above).
        for (const [v, info] of kind) {
          for (const ref of v.references) {
            if (!ref.isRead() || accepted.has(ref.identifier)) continue;
            const id = ref.identifier;
            const top = outer(id);
            const p = top.parent;
            if (info.kind === 'fn' && p && p.type === 'CallExpression' && p.callee === top) continue;
            if (info.kind === 'ns' && p && p.type === 'MemberExpression' && p.object === top) {
              const mTop = outer(p);
              const pn = propName(p);
              if (pn && CHILD_PROCESS_FNS.has(pn) && mTop.parent && mTop.parent.type === 'CallExpression' && mTop.parent.callee === mTop) continue;
            }
            reportEscape(id, info.kind === 'ns' ? `child_process module '${v.name}'` : `child_process ${info.fn}() binding '${v.name}'`);
          }
        }
        // require(cp).x — only direct fn calls allowed.
        for (const c of accepted) {
          const top = outer(c);
          if (!top.parent || top.parent.type !== 'MemberExpression' || top.parent.object !== top) continue;
          const m = top.parent;
          const pn = propName(m);
          const mTop = outer(m);
          if (!(pn && CHILD_PROCESS_FNS.has(pn) && mTop.parent && mTop.parent.type === 'CallExpression' && mTop.parent.callee === mTop)) {
            reportEscape(m, `child_process member '${pn || '[computed]'}'`);
          }
        }

        // 5) Direct calls: options literal must hide the window.
        for (const c of calls) {
          if (c.type !== 'CallExpression') continue;
          const fn = fnOf(c.callee);
          // A spread shifts the slots: the literal we'd check may not be the options Node reads.
          if (fn && c.arguments.some((a) => a.type === 'SpreadElement')) { reportEscape(c, `child_process ${fn}() call with spread arguments`); continue; }
          if (fn && !hidden(optionsArg(fn, c.arguments))) context.report({ node: c, messageId: 'missing', data: { fn } });
        }
        // 6) Any other mention of the module (aliased require, process.getBuiltinModule,
        //    Module._load, renamed createRequire, a plain string) is a load we can't verify.
        for (const lit of literals) if (!handled.has(lit)) reportEscape(lit, "'child_process' specifier outside a const require/import");
      },
    };
  },
};

const localPlugin = { rules: { 'no-silent-return-catch': noSilentReturnCatch, 'require-windows-hide': requireWindowsHide } };

const sharedRules = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-undef': 'error',
  'local/no-silent-return-catch': 'error',
  'local/require-windows-hide': 'error',
};

// Generous Node runtime globals shared by both layers (a missing one would trip
// no-undef; extras are harmless).
const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  globalThis: 'readonly', structuredClone: 'readonly',
};

module.exports = [
  { ignores: ['**/node_modules/**'] },
  {
    // No local escape hatch: an inline `eslint-disable` would silently switch
    // off require-windows-hide (or the catch rules). ESLint warns on any inline
    // config here, and --max-warnings=0 turns that into a gate failure.
    files: ['scripts/**', 'servers/**'],
    linterOptions: { noInlineConfig: true },
  },
  {
    // scripts/ — CommonJS hooks/CLI (zero extra deps).
    files: ['scripts/**/*.js'],
    plugins: { local: localPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly', __filename: 'readonly',
        require: 'readonly', module: 'readonly', exports: 'readonly',
      },
    },
    rules: sharedRules,
  },
  {
    // servers/ — ESM MCP server + HTTP daemon.
    files: ['servers/**/*.js'],
    plugins: { local: localPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: sharedRules,
  },
  {
    // servers/model-router/ — CommonJS HTTP proxy + claude.exe wrapper (C#).
    // Runs under Node's default CJS loader (no package.json
    // type:module here), unlike the ESM brain-server above, so it needs the
    // CommonJS module globals. Later than the servers/ block → wins for these files.
    files: ['servers/model-router/**/*.js'],
    plugins: { local: localPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly', __filename: 'readonly',
        require: 'readonly', module: 'readonly', exports: 'readonly',
      },
    },
    rules: sharedRules,
  },
  {
    // .mjs / .ts / .mts anywhere under scripts/ or servers/ (ESM) — ESLint lints
    // them too, so without this a new .mjs hook would dodge require-windows-hide.
    // Only that rule here: the full shared set was never applied to these files.
    files: ['scripts/**/*.{mjs,ts,mts}', 'servers/**/*.{mjs,ts,mts}'],
    plugins: { local: localPlugin },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: nodeGlobals },
    rules: { 'local/require-windows-hide': 'error' },
  },
  {
    // .cjs / .cts anywhere under scripts/ or servers/ (CommonJS) — same reason.
    files: ['scripts/**/*.{cjs,cts}', 'servers/**/*.{cjs,cts}'],
    plugins: { local: localPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly', __filename: 'readonly',
        require: 'readonly', module: 'readonly', exports: 'readonly',
      },
    },
    rules: { 'local/require-windows-hide': 'error' },
  },
  {
    // Test/smoke harnesses run from a terminal or CI, never as a console-less
    // hook, so a console window is not a user-facing regression there. Last
    // block → overrides every block above for these files.
    files: ['scripts/test-*.{js,mjs,cjs,ts,mts,cts}', 'scripts/smoke-*.{js,mjs,cjs,ts,mts,cts}'],
    rules: { 'local/require-windows-hide': 'off' },
  },
];
