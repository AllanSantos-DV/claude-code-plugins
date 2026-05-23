#!/usr/bin/env node
/**
 * Discipline Guard — Pre-tool hook that warns when the octopus default agent
 * tries to write/edit files for complex tasks that should be delegated.
 *
 * This is a soft guard: it logs a warning but doesn't block the operation.
 * The real discipline is enforced by the octopus agent prompt.
 */
const input = require('fs').readFileSync(0, 'utf-8');

try {
  const event = JSON.parse(input);

  // Only warn when the edit affects source files (not config/markdown)
  const filePath = event?.tool_input?.file_path || event?.tool_input?.path || '';
  const isSourceFile = /\.(ts|js|tsx|jsx|py|rs|go|java|rb|php|c|cpp|h|hpp)$/i.test(filePath);

  if (isSourceFile) {
    // Soft warning logged to stderr — visible in Claude Code debug output
    console.error(
      `[DISCIPLINE] Write/Edit on source file: ${filePath}. ` +
      `If this is a multi-file task, consider using a subagent (implementor) instead.`
    );
  }

  // Return empty response to allow the operation
  process.stdout.write(JSON.stringify({}));
} catch (err) {
  console.error(`[DISCIPLINE] Error: ${err.message}`);
  process.stdout.write(JSON.stringify({}));
}
