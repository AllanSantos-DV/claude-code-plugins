'use strict';
/**
 * hook-prefix.js — make every stderr line of a boss command hook say who wrote it.
 *
 * Claude Code labels a failing hook only by event/matcher ("UserPromptSubmit hook
 * error"), never by plugin. A user with several plugins cannot tell whose hook broke.
 * `install('name')` wraps process.stderr.write so each line leaves as
 * `[claude-code-boss:name] ...` (lines that already carry a `[claude-code-boss:` tag are
 * left alone, so the existing hand-written prefixes are not doubled).
 *
 * Only for entry scripts (`require.main === module`): never call it from a module that
 * a test or another script imports.
 */

const TAG = '[claude-code-boss:';

function prefixLines(text, name) {
  const prefix = `${TAG}${name}] `;
  return String(text).split('\n').map((line, i, all) => {
    if (line === '' && i === all.length - 1) return line; // trailing newline
    return line.startsWith(TAG) ? line : prefix + line;
  }).join('\n');
}

function install(name, stream = process.stderr) {
  if (!name || typeof name !== 'string') throw new Error('hook-prefix: install(name) needs a hook name');
  if (stream.__ccbPrefixed) return;
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => original(typeof chunk === 'string' ? prefixLines(chunk, name) : chunk, ...rest);
  stream.__ccbPrefixed = true;
}

module.exports = { install, prefixLines, TAG };
