#!/usr/bin/env node
/**
 * scripts/gate.mjs — single source of truth for the quality gate.
 *
 * The SAME checks run locally and in CI (the CI workflow just calls
 * `npm run gate`), so a green local run means a green CI — no more "eslint
 * passed locally but a separate CI grep failed":
 *   1. ESLint over scripts/ AND servers/ (--max-warnings=0). Catch-masking is
 *      enforced by AST rules (no-empty + local/no-silent-return-catch), so the
 *      old GNU-only greps are gone and servers/ is finally covered.
 *   2. Version sync (sync-version --check).
 *   3. Test suite (hooks + units).
 *
 * Cross-platform (Windows/Linux). Runs every check, prints a summary, and exits
 * non-zero if any failed. Run from the plugin root (npm run gate handles cwd).
 */
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'eslint (scripts + servers)', cmd: 'npx eslint --config eslint.config.cjs scripts/ servers/ --max-warnings=0' },
  { name: 'version sync', cmd: 'node scripts/sync-version.js --check' },
  { name: 'tests (hooks + units)', cmd: 'node scripts/test-hooks.js && node scripts/test-units.js' },
];

const results = [];
for (const step of steps) {
  console.log(`\n--- ${step.name} ---`);
  const r = spawnSync(step.cmd, { stdio: 'inherit', shell: true });
  results.push({ name: step.name, ok: r.status === 0 });
}

console.log('\n=== gate summary ===');
for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nGATE FAILED — ${failed.length}/${results.length} check(s) failed`);
  process.exit(1);
}
console.log('\nGATE PASSED');
