#!/usr/bin/env node
/**
 * brain-reembed.js — One-shot migration script.
 *
 * Wipes the embeddings table for every project DB under CLAUDE_PLUGIN_DATA and
 * re-embeds every entry with the embedder configured in brain-config.json.
 *
 * Run after switching the embedder model. No fallback, no previousModel guard:
 * the plugin is single-tenant, so a clean cutover is the contract.
 *
 * Usage:
 *   node claude-code-boss/scripts/brain-reembed.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

const DATA_BASE = path.join(os.homedir(), '.claude', 'plugins', 'data');
const dataDirs = fs.readdirSync(DATA_BASE)
  .filter(d => /^claude-code-boss/.test(d))
  .map(d => path.join(DATA_BASE, d, 'brain'))
  .filter(p => fs.existsSync(p));

if (dataDirs.length === 0) {
  console.log('No claude-code-boss data dirs found — nothing to migrate.');
  process.exit(0);
}

const { loadSqlite } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sqlite-compat'));
const Database = loadSqlite();
if (!Database) {
  console.error('No SQLite backend available — need Node >= 22.13 (built-in node:sqlite) or a compiled better-sqlite3. Nothing to re-embed.');
  process.exit(1);
}
const embedder = require(path.join(PLUGIN_ROOT, 'scripts', 'brain-embedder.js'));
const { buildEmbedText } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'embed-text.js'));

function vectorToBlob(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

(async () => {
  const t0 = Date.now();
  await embedder.init();
  const status = embedder.getStatus();
  if (!status.ready) {
    console.error(`embedder failed to init: ${status.error || 'unknown'}`);
    process.exit(1);
  }
  console.log(`embedder ready: ${status.model} (${status.dimensions}-dim)`);
  console.log(`embedder cold init: ${Date.now() - t0}ms\n`);

  let totalEntries = 0;
  let totalReembedded = 0;
  let totalDbs = 0;

  for (const brainDir of dataDirs) {
    const projects = fs.readdirSync(brainDir)
      .map(p => path.join(brainDir, p, 'brain.db'))
      .filter(p => fs.existsSync(p));

    for (const dbPath of projects) {
      const rel = path.relative(DATA_BASE, dbPath);
      const db = new Database(dbPath);
      const cnt = db.prepare('SELECT COUNT(*) c FROM entries').get();
      if (cnt.c === 0) {
        console.log(`skip empty: ${rel}`);
        db.close();
        continue;
      }
      totalDbs++;
      totalEntries += cnt.c;
      console.log(`  ${rel} — ${cnt.c} entries`);

      db.prepare('DELETE FROM embeddings').run();

      const entries = db.prepare('SELECT id, title, summary, content FROM entries').all();
      const insert = db.prepare(`
        INSERT INTO embeddings (entry_id, vector, dimensions, model) VALUES (?, ?, ?, ?)
      `);

      for (const row of entries) {
        const text = buildEmbedText({ title: row.title, summary: row.summary });
        const vec = await embedder.embed(text);
        if (!vec) {
          console.error(`    FAIL embed: ${row.id}`);
          continue;
        }
        insert.run(row.id, vectorToBlob(vec), vec.length, status.model);
        totalReembedded++;
      }

      db.close();
    }
  }

  const ms = Date.now() - t0;
  console.log(`\nOK  re-embedded ${totalReembedded}/${totalEntries} entries across ${totalDbs} db(s) in ${ms}ms`);
})().catch(err => {
  console.error(`FAIL  ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
