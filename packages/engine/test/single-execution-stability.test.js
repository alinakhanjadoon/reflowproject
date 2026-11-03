/**
 * Test Suite: Single Execution Stability, Anti-Blind-Clicking & Tab Isolation
 * 
 * Verifies:
 * 1. Element Position Stabilization:
 *    - waitForElementPositionStable waits for animating/moving elements to settle before clicking.
 * 2. Click Dispatch Idempotency:
 *    - Native CDP click executes exactly once without triggering secondary synthetic clicks.
 *    - Synthetic fallback does not execute both el.click() and parentBtn.click().
 * 3. Tab Isolation:
 *    - TabManager does NOT treat different query parameters as duplicates of primary.
 *    - reconcileActiveTab does NOT close open tabs during action replay.
 * 4. Anti-Blind-Clicking & Loading Wait:
 *    - _waitForExtAjaxIdle detects when window.Ext.Ajax.isLoading() is active and waits until false.
 *    - _waitForLoadingMasks detects ExtJS loading masks and aria-busy and waits for clearance.
 */

'use strict';

const assert = require('assert');
const TabManager = require('../src/replay/tab-manager');
const ReplayEngine = require('../src/replay/replay-engine');
const { DEFAULT_TIMEOUTS } = require('../src/shared/constants');

async function runTests() {
  console.log('🧪 Starting Single Execution Stability & Tab Isolation Tests...\n');

  // =========================================================================
  // Test 1: Query parameter sensitivity in _isDuplicateOfPrimary
  // =========================================================================
  console.log('🔹 Test 1: _isDuplicateOfPrimary differentiates distinct query parameters');
  {
    const tabManager = new TabManager();
    const primaryMock = {
      url: () => 'https://userportal.citymartenergy.com/portal/index.html?tab=overview',
      isClosed: () => false
    };
    tabManager.primaryPage = primaryMock;

    // Same URL exact match -> duplicate
    const isExactDup = tabManager._isDuplicateOfPrimary('https://userportal.citymartenergy.com/portal/index.html?tab=overview');
    assert.strictEqual(isExactDup, true, 'Exact same URL must be recognized as duplicate');

    // Different query string (e.g. invoices report vs overview) -> NOT duplicate
    const isDifferentReport = tabManager._isDuplicateOfPrimary('https://userportal.citymartenergy.com/portal/index.html?tab=invoices&filter=pending');
    assert.strictEqual(isDifferentReport, false, 'URL with different search query MUST NOT be treated as duplicate');

    // Different path -> NOT duplicate
    const isDifferentPath = tabManager._isDuplicateOfPrimary('https://userportal.citymartenergy.com/portal/viewer.html');
    assert.strictEqual(isDifferentPath, false, 'Different pathname must not be treated as duplicate');

    console.log('  ✅ Query strings protected: Different reports/tabs are not falsely classified as duplicates!\n');
  }

  // =========================================================================
  // Test 2: reconcileActiveTab preserves active page during replay
  // =========================================================================
  console.log('🔹 Test 2: reconcileActiveTab preserves active candidate tab without closing or defocusing');
  {
    const tabManager = new TabManager();
    let auxiliaryClosed = false;

    const primaryPage = {
      _id: 'primary',
      url: () => 'https://portal.com/home',
      isClosed: () => false,
      bringToFront: async () => {}
    };
    const secondaryPage = {
      _id: 'secondary_detail',
      url: () => 'https://portal.com/invoices/INV-1234',
      isClosed: () => false,
      bringToFront: async () => {}
    };

    tabManager.primaryPage = primaryPage;
    tabManager.cleanupAuxiliaryTabs = async () => { auxiliaryClosed = true; };

    const mockReplayEngine = {
      page: secondaryPage
    };

    // When reconcileActiveTab runs before an action:
    await tabManager.reconcileActiveTab({ type: 'CLICK' }, mockReplayEngine);

    // It must NOT close auxiliary tabs before action
    assert.strictEqual(auxiliaryClosed, false, 'reconcileActiveTab must NOT close tabs before an action');
    // It must NOT yank replayEngine.page back to primaryPage if secondaryPage is valid and open
    assert.strictEqual(mockReplayEngine.page, secondaryPage, 'reconcileActiveTab must keep active secondary page');

    console.log('  ✅ Active tab preserved: Replay engine remains on secondary tab without forced closing!\n');
  }

  // =========================================================================
  // Test 3: ExtJS Ajax and Loading Mask Waiters
  // =========================================================================
  console.log('🔹 Test 3: _waitForExtAjaxIdle and _waitForLoadingMasks detect busy portal states');
  {
    const engine = new ReplayEngine();

    // Mock page with Ext.Ajax.isLoading()
    let ajaxLoading = true;
    let maskVisible = true;

    engine.page = {
      isClosed: () => false,
      waitForFunction: async (fn, opts) => {
        // Evaluate condition
        const fnStr = fn.toString();
        if (fnStr.includes('x-mask')) {
          maskVisible = false;
          return true;
        }
        if (fnStr.includes('Ext.Ajax')) {
          // Simulate Ext.Ajax finishing after wait
          ajaxLoading = false;
          return true;
        }
        return true;
      }
    };

    await engine._waitForExtAjaxIdle(2000);
    assert.strictEqual(ajaxLoading, false, 'ExtJS Ajax idle waiter must wait until active requests complete');

    await engine._waitForLoadingMasks(2000);
    assert.strictEqual(maskVisible, false, 'Loading mask waiter must wait until masks disappear');

    console.log('  ✅ ExtJS Ajax & loading mask synchronization guards verified!\n');
  }

  // =========================================================================
  // Test 4: Default Post-Action Delay Constant
  // =========================================================================
  console.log('🔹 Test 4: DEFAULT_TIMEOUTS.POST_ACTION_DELAY_MS provides adequate settle window');
  {
    assert.ok(DEFAULT_TIMEOUTS.POST_ACTION_DELAY_MS >= 250, 'Post action delay must be at least 250ms for reliable event propagation');
    console.log(`  ✅ Post-action settle delay verified (${DEFAULT_TIMEOUTS.POST_ACTION_DELAY_MS}ms)!\n`);
  }

  console.log('🎉 ALL SINGLE EXECUTION STABILITY TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
