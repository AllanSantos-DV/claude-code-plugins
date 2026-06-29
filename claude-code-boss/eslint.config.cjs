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

const localPlugin = { rules: { 'no-silent-return-catch': noSilentReturnCatch } };

const sharedRules = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-undef': 'error',
  'local/no-silent-return-catch': 'error',
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
    // servers/model-router/ — CommonJS HTTP proxy + NODE_OPTIONS=--require
    // patcher. Runs under Node's default CJS loader (no package.json
    // type:module here), unlike the ESM brain-server above, so it needs the
    // CommonJS module globals. This block is last → wins for these files.
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
];
