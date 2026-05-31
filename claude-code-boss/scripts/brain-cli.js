#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

const _ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

const backend = require('./brain-backend.js');

const PROJECT = process.env.BRAIN_PROJECT || 'default';

function getProject() {
  try {
    const cwd = process.env.CLAUDE_CWD || process.cwd();
    return path.basename(cwd);
  } catch (err) {
    console.error(`[BRAIN-CLI] getProject fallback: ${err.message}`);
    return PROJECT;
  }
}

function usage() {
  console.error(`Usage:
  node brain-cli.js save '<json>'       -- Save entry, return ID
  node brain-cli.js save-file <path>    -- Save entry from JSON file
  node brain-cli.js get <id>            -- Get entry by ID
  node brain-cli.js search <query> [k]  -- Search by text (default topK=5)
  node brain-cli.js related <id>        -- Get related entries
  node brain-cli.js count               -- Count entries
  node brain-cli.js status              -- Show backend status
  node brain-cli.js reindex             -- Re-index keyword index (local mode only)
`);
  process.exit(1);
}

(async () => {
  const cmd = process.argv[2];
  if (!cmd) usage();

  const project = getProject();
  await backend.init({ project });

  switch (cmd) {
    case 'save': {
      if (!process.argv[3]) { console.error('Missing JSON'); process.exit(1); }
      const entry = JSON.parse(process.argv[3]);
      entry.project = entry.project || project;
      const id = await backend.save(entry);
      console.log(JSON.stringify({ id, status: 'saved' }));
      break;
    }
    case 'save-file': {
      if (!process.argv[3]) { console.error('Missing file path'); process.exit(1); }
      const raw = fs.readFileSync(process.argv[3], 'utf-8');
      const entry = JSON.parse(raw);
      entry.project = entry.project || project;
      const id = await backend.save(entry);
      console.log(JSON.stringify({ id, status: 'saved' }));
      break;
    }
    case 'get': {
      if (!process.argv[3]) { console.error('Missing ID'); process.exit(1); }
      const entry = await backend.get(process.argv[3]);
      console.log(JSON.stringify(entry || null));
      break;
    }
    case 'search': {
      if (!process.argv[3]) { console.error('Missing query'); process.exit(1); }
      const text = process.argv[3];
      const topK = parseInt(process.argv[4] || '5', 10);
      const results = await backend.search(text, { topK, minScore: 0.2 });
      console.log(JSON.stringify(results.slice(0, topK)));
      break;
    }
    case 'related': {
      if (!process.argv[3]) { console.error('Missing ID'); process.exit(1); }
      const related = await backend.getRelated(process.argv[3]);
      console.log(JSON.stringify(related));
      break;
    }
    case 'count': {
      const count = await backend.count();
      console.log(JSON.stringify({ count }));
      break;
    }
    case 'reindex': {
      if (backend.getMode() === 'mcp-memory') {
        console.error('Reindex not applicable in mcp-memory mode (server handles indexing internally)');
        process.exit(1);
      }
      const store = require('./brain-store.js');
      const index = require('./brain-index.js');
      await store.init({ project });
      await index.init({ project });
      const all = await store.list();
      for (const entry of all) {
        await index.index(entry);
      }
      console.log(JSON.stringify({ reindexed: all.length }));
      break;
    }
    case 'status': {
      const status = backend.getStatus();
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    default:
      usage();
  }
})().catch(err => {
  console.error(`[BRAIN-CLI] Error: ${err.message}`);
  process.exit(1);
});
