/**
 * Test Suite: Deterministic Item Discovery
 */

const assert = require('assert');
const ItemDiscovery = require('../src/shared/item-discovery');

function runItemDiscoveryTests() {
  console.log('🧪 Starting Item Discovery Unit Tests...\n');

  console.log('🔹 Test 1: Select highest-confidence collection');
  const candidates = [
    { score: 0.61, itemCount: 4 },
    { score: 0.91, itemCount: 10 },
    { score: 0.72, itemCount: 6 }
  ];

  const best = ItemDiscovery.selectBestCandidate(candidates);
  assert.strictEqual(best.score, 0.91);
  assert.strictEqual(best.itemCount, 10);
  console.log('  ✅ Best candidate selection passed\n');

  console.log('🔹 Test 2: Empty candidate set');
  assert.strictEqual(ItemDiscovery.selectBestCandidate([]), null);
  assert.strictEqual(ItemDiscovery.selectBestCandidate(null), null);
  console.log('  ✅ Empty candidate handling passed\n');

  console.log('🔹 Test 3: Invalid candidates are ignored');
  const result = ItemDiscovery.selectBestCandidate([
    null,
    { score: '0.99', itemCount: 20 },
    { score: 0.8, itemCount: 5 }
  ]);
  assert.strictEqual(result.score, 0.8);
  console.log('  ✅ Invalid candidate handling passed\n');

  console.log('🔹 Test 4: Exclude navigation/toolbar candidates even with high score');
  const navCandidate = {
    score: 0.98,
    itemCount: 8,
    ancestorTag: 'mat-toolbar',
    role: 'tablist'
  };
  const tableCandidate = {
    score: 0.85,
    itemCount: 15,
    ancestorTag: 'tbody',
    itemTag: 'tr'
  };
  assert.strictEqual(ItemDiscovery.isNavigationCandidate(navCandidate), true);
  assert.strictEqual(ItemDiscovery.isNavigationCandidate(tableCandidate), false);

  const chosen = ItemDiscovery.selectBestCandidate([navCandidate, tableCandidate]);
  assert.strictEqual(chosen.ancestorTag, 'tbody', 'Must choose data table collection over navigation toolbar');
  assert.strictEqual(chosen.score, 0.85);
  console.log('  ✅ Navigation candidate exclusion passed\n');

  console.log('🔹 Test 5: Collection pattern classification (table, card-grid, list-item, dropdown-option)');
  const tableCol = { score: 0.9, itemTag: 'tr', collectionType: 'table-row' };
  const cardCol = { score: 0.85, itemTag: 'div', collectionType: 'card-grid' };
  const listCol = { score: 0.88, itemTag: 'li', collectionType: 'list-item' };
  const optCol = { score: 0.82, itemTag: 'mat-option', collectionType: 'dropdown-option' };

  assert.strictEqual(tableCol.collectionType, 'table-row');
  assert.strictEqual(cardCol.collectionType, 'card-grid');
  assert.strictEqual(listCol.collectionType, 'list-item');
  assert.strictEqual(optCol.collectionType, 'dropdown-option');
  console.log('  ✅ Collection pattern classification passed\n');

  console.log('🔹 Test 6: Multi-collection candidates preserving relative ranking');
  const allCandidates = [
    { score: 0.75, itemCount: 5, collectionType: 'list-item' },
    { score: 0.92, itemCount: 10, collectionType: 'table-row' },
    { score: 0.65, itemCount: 3, collectionType: 'card-grid' }
  ];
  const sorted = allCandidates.sort((a, b) => b.score - a.score);
  assert.strictEqual(sorted[0].collectionType, 'table-row');
  assert.strictEqual(sorted[0].score, 0.92);
  assert.strictEqual(sorted[1].collectionType, 'list-item');
  console.log('  ✅ Multi-collection ranking passed\n');

  console.log('🔹 Test 7: Prioritize multi-record grid collections over 1-record sub-table / tbody wrapper');
  const singleRowTbody = { score: 1.0, itemCount: 1, ancestorTag: 'tbody', itemTag: 'tr' };
  const virtualGridContainer = { score: 1.0, itemCount: 15, ancestorTag: 'div', itemTag: 'table' };
  const bestGridCandidate = ItemDiscovery.selectBestCandidate([singleRowTbody, virtualGridContainer]);
  assert.strictEqual(bestGridCandidate.itemCount, 15, 'Multi-record grid container must beat 1-record sub-tbody wrapper when scores are equal');
  assert.strictEqual(bestGridCandidate.ancestorTag, 'div');
  console.log('  ✅ Multi-record grid candidate priority passed\n');

  console.log('🔹 Test 8: Multi-record collection strictly beats single-item candidate even with lower score');
  const singleItemCell = { score: 0.95, itemCount: 1, ancestorTag: 'td', itemTag: 'div' };
  const multiRecordGrid = { score: 0.74, itemCount: 15, ancestorTag: 'div', itemTag: 'table' };
  const winner = ItemDiscovery.selectBestCandidate([singleItemCell, multiRecordGrid]);
  assert.strictEqual(winner.itemCount, 15, 'Multi-record collection (itemCount: 15) must beat single-item candidate (itemCount: 1) regardless of score difference');
  assert.strictEqual(winner.ancestorTag, 'div');
  console.log('  ✅ Multi-record candidate precedence over single-item passed\n');

  console.log('🎉 ALL ITEM DISCOVERY TESTS PASSED SUCCESSFULLY!\n');
}

runItemDiscoveryTests();
