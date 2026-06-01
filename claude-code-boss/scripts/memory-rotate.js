#!/usr/bin/env node
/**
 * Memory Rotate — SessionStart hook.
 *
 * Scans all agent-memory directories and rotates MEMORY.md when it exceeds
 * 150 lines. Archive goes to ~/.claude/agent-memory/<agent>/archive/.
 * Fresh MEMORY.md preserves last 20 lines for continuity.
 *
 * Claude Code auto-loads first 200 lines of MEMORY.md. Without rotation,
 * entries beyond line 200 are silently ignored. This hook prevents that.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT_MEMORY_DIR = path.join(os.homedir(), '.claude', 'agent-memory');

const MAX_LINES = require('./lib/hooks-config.js').load().memoryRotate?.maxLines ?? 150;

function main() {
  const rotated = [];

  try {
    if (!fs.existsSync(AGENT_MEMORY_DIR)) {
      process.stdout.write(JSON.stringify({ ok: true, rotated: [] }));
      return;
    }

    const dirs = fs.readdirSync(AGENT_MEMORY_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const memPath = path.join(AGENT_MEMORY_DIR, dir.name, 'MEMORY.md');
      if (!fs.existsSync(memPath)) continue;

      const content = fs.readFileSync(memPath, 'utf-8');
      const lines = content.split('\n');
      const lineCount = lines.length;

      if (lineCount <= MAX_LINES) continue;

      const archiveDir = path.join(AGENT_MEMORY_DIR, dir.name, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const archivePath = path.join(archiveDir, `MEMORY-${ts}.md`);
      fs.writeFileSync(archivePath, content);

      const tailStart = Math.max(0, lines.length - 20);
      const tail = lines.slice(tailStart);

      const fresh = [
        '# MEMORY.md',
        '',
        `> Rotated at ${ts}`,
        `> Archive: archive/MEMORY-${ts}.md (${lineCount} lines before rotation)`,
        '> MEMORY.md auto-loads first 200 lines. Rotation preserves recent entries.',
        '',
        '## Recent (preserved from archive)',
        '',
        ...tail,
        '',
        '## New entries',
        '',
      ].join('\n');

      fs.writeFileSync(memPath, fresh);
      rotated.push(dir.name);
    }
  } catch (err) {
    console.error(`[MEMORY-ROTATE] Error: ${err.message}`);
  }

  process.stdout.write(JSON.stringify({ ok: true, rotated }));
}

main();
