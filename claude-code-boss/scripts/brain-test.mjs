#!/usr/bin/env node
/**
 * Brain — Fase 1 Smoke Test
 *
 * Tests: embed → save → search → cosine similarity → keyword lookup → graph
 *
 * Run: node scripts/brain-test.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const store = require('./brain-store.js');
const index = require('./brain-index.js');
const graph = require('./brain-graph.js');

const TEST_PROJECT = 'brain-test';

function assert(condition, msg) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  OK: ${msg}`);
}

async function main() {
  console.log('\n🧠 Brain Fase 1 — Smoke Test\n');

  // 1. Init store + index + graph
  console.log('1. Init...');
  await store.init({ project: TEST_PROJECT });
  await index.init({ project: TEST_PROJECT });
  await graph.init({ project: TEST_PROJECT });
  console.log(`   Storage: ${store.getStorageType()}`);
  console.log(`   Index: ${index.getStatus().keywordCount} keywords`);
  console.log(`   Graph: ${graph.getStatus().nodeCount} nodes`);
  assert(store.getStatus().initialized, 'store initialized');
  assert(index.getStatus().initialized, 'index initialized');
  assert(graph.getStatus().initialized, 'graph initialized');

  // 2. Save entries
  console.log('\n2. Save entries...');
  const entry1 = {
    id: 'test-001',
    type: 'lesson',
    project: TEST_PROJECT,
    session_id: 'session-1',
    title: 'Always validate function arguments',
    summary: 'Functions that accept untrusted input must validate arguments before use',
    content: { detail: 'Found a bug where null input caused crash. Always check for null/undefined at function entry point.', files: ['src/utils.ts'] },
    tags: ['validation', 'defensive-programming', 'null-safety', 'error-handling'],
    confidence: 0.9,
  };
  const entry2 = {
    id: 'test-002',
    type: 'pattern',
    project: TEST_PROJECT,
    session_id: 'session-1',
    title: 'React useEffect cleanup pattern',
    summary: 'Always return cleanup from useEffect to prevent memory leaks',
    content: { detail: 'Forgot to cleanup subscription on unmount. Rule: every useEffect with external subscription must return cleanup.', files: ['src/hooks/useSubscription.ts'] },
    tags: ['react', 'hooks', 'effect', 'cleanup', 'memory-leak'],
    confidence: 0.85,
  };

  await store.save(entry1, [0.1, 0.2, 0.3, 0.4]);
  await store.save(entry2, [0.9, 0.8, 0.7, 0.6]);
  await index.index(entry1);
  await index.index(entry2);
  await graph.registerNode(entry1);
  await graph.registerNode(entry2);

  // 3. Get entry
  console.log('\n3. Read entries...');
  const got1 = await store.get('test-001');
  assert(got1 !== null, 'get test-001');
  assert(got1.title === 'Always validate function arguments', 'correct title');
  assert(got1.access_count >= 0, 'access count present');

  // 4. Vector search
  console.log('\n4. Vector search...');
  const results = await store.search([0.85, 0.78, 0.72, 0.65], { topK: 3 });
  assert(results.length >= 1, `search returned ${results.length} results`);
  if (results.length > 0) {
    console.log(`   Top result: "${results[0].title}" (score: ${results[0].score.toFixed(3)})`);
    // Entry2 (useEffect cleanup) should score higher with this vector
    assert(results[0].id === 'test-002', 'semantically closer entry ranked higher');
  }

  // 5. Keyword search
  console.log('\n5. Keyword search...');
  const kwResults = await store.searchByKeywords(['validation', 'null', 'function']);
  assert(kwResults.length >= 1, `keyword search returned ${kwResults.length} results`);
  if (kwResults.length > 0) {
    console.log(`   Top result: "${kwResults[0].title}" (score: ${kwResults[0].score.toFixed(3)})`);
    assert(kwResults[0].id === 'test-001', 'keyword-match entry ranked higher');
  }

  // 6. Index lookup
  console.log('\n6. Index lookup...');
  const idxResults = await index.lookup(['react', 'effect']);
  assert(idxResults.length >= 1, `index lookup returned ${idxResults.length} results`);
  if (idxResults.length > 0) {
    console.log(`   Top result: "${idxResults[0].id}" (score: ${idxResults[0].score.toFixed(3)})`);
  }

  // 7. Graph
  console.log('\n7. Graph...');
  await graph.addEdge('test-001', 'test-002', 'related', 0.7);
  const related = await graph.getRelated('test-001');
  assert(related.length >= 1, `graph returned ${related.length} relations`);
  if (related.length > 0) {
    console.log(`   Relation: ${related[0].id} (${related[0].type}, weight: ${related[0].weight})`);
  }

  // 8. Cleanup
  console.log('\n8. Cleanup...');
  await store.delete({ id: 'test-001' });
  await store.delete({ id: 'test-002' });
  await index.deindex('test-001');
  await index.deindex('test-002');
  await graph.unregisterNode('test-001');
  await graph.unregisterNode('test-002');

  // Verify cleanup
  const afterDelete = await store.get('test-001');
  assert(afterDelete === null, 'entry deleted');
  const afterIndex = await index.lookup(['validation']);
  assert(afterIndex.length === 0, 'index cleaned');

  // 9. Summary
  const count = await store.count(null, TEST_PROJECT);
  assert(count === 0, `store clean: ${count} entries remaining`);

  await store.close();

  console.log('\n✅ Fase 1 — All tests passed');
}

main().catch(err => {
  console.error(`\n❌ Test failed: ${err.message}`);
  process.exit(1);
});
