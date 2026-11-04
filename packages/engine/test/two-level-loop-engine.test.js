/**
 * Test Suite: Controlled Two-Level Iteration Engine (Company-Level + Record-Level)
 *
 * Verifies the exact execution architecture:
 * Phase 1: Login executes once
 * Phase 2: Company 101 -> All its invoices (A, B, C) -> Return to company context
 * Phase 3: Company 102 -> All its invoices (D, E) -> Return to company context
 * Phase 4: Composite identity ("company101/INV-A") NEW_ONLY deduplication
 * Phase 5: Error isolation across companies
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const LoopDetector = require('../src/shared/loop-detector');
const LoopReplayRunner = require('../src/replay/loop-replay-runner');
const ItemDiscovery = require('../src/shared/item-discovery');

describe('Controlled Two-Level Iteration Specification Tests', () => {

  // -------------------------------------------------------------
  // 1. Configuration & Workflow Partitioning
  // -------------------------------------------------------------
  test('1.1 deriveNestedLoopConfig and partitionNestedWorkflow produce exact 5-phase structure', () => {
    const steps = [
      { id: 's1', type: 'CLICK', name: 'Login Button' },                    // 0: Setup
      { id: 's2', type: 'CLICK', name: 'Select Company 101' },              // 1: Outer Anchor
      { id: 's3', type: 'CLICK', name: 'Open Invoices Page' },              // 2: Outer Pre-step (navigate)
      { id: 's4', type: 'CLICK', name: 'Select Invoice Row' },              // 3: Inner Anchor
      { id: 's5', type: 'CLICK', name: 'Open Invoice' },                    // 4: Inner loop
      { id: 's6', type: 'CLICK', name: 'Download PDF', isDownload: true },  // 5: Inner loop
      { id: 's7', type: 'CLICK', name: 'Return to Invoice List' },          // 6: Inner loop end
      { id: 's8', type: 'CLICK', name: 'Return to Company Selection' },     // 7: Outer Post-step (return)
      { id: 's9', type: 'CLICK', name: 'Logout' }                           // 8: Final Teardown
    ];

    const workflowDef = {
      nestedLoop: {
        enabled: true,
        mode: 'two_level',
        outer: {
          name: 'company',
          anchorStepIndex: 1,
          startStepIndex: 1,
          endStepIndex: 7
        },
        inner: {
          name: 'invoice',
          anchorStepIndex: 3,
          startStepIndex: 3,
          endStepIndex: 6,
          filter: { column: 'Type', value: 'Invoice' }
        }
      }
    };

    const derived = LoopDetector.deriveNestedLoopConfig(workflowDef, steps);
    assert.ok(derived, 'Should derive nested loop configuration');
    assert.strictEqual(derived.enabled, true);
    assert.strictEqual(derived.outer.anchorStepIndex, 1);
    assert.strictEqual(derived.inner.anchorStepIndex, 3);
    assert.strictEqual(derived.inner.endStepIndex, 6);

    const validation = LoopDetector.validateNestedLoopConfig(derived, steps.length);
    assert.strictEqual(validation.valid, true);

    const partition = LoopDetector.partitionNestedWorkflow(steps, derived);
    assert.strictEqual(partition.initialSetupSteps.length, 1, 'Initial setup should have 1 step (Login)');
    assert.strictEqual(partition.initialSetupSteps[0].name, 'Login Button');

    assert.strictEqual(partition.outerPreSteps.length, 2, 'Outer pre-steps should have 2 steps (Select Company, Open Invoices)');
    assert.strictEqual(partition.outerPreSteps[0].name, 'Select Company 101');
    assert.strictEqual(partition.outerPreSteps[1].name, 'Open Invoices Page');

    assert.strictEqual(partition.innerLoopSteps.length, 4, 'Inner loop should have 4 steps (Select Invoice..Return to list)');
    assert.strictEqual(partition.innerLoopSteps[0].name, 'Select Invoice Row');
    assert.strictEqual(partition.innerLoopSteps[3].name, 'Return to Invoice List');

    assert.strictEqual(partition.outerPostSteps.length, 1, 'Outer post-steps should have 1 step (Return to Company Selection)');
    assert.strictEqual(partition.outerPostSteps[0].name, 'Return to Company Selection');

    assert.strictEqual(partition.finalTeardownSteps.length, 1, 'Final teardown should have 1 step (Logout)');
    assert.strictEqual(partition.finalTeardownSteps[0].name, 'Logout');
  });

  // -------------------------------------------------------------
  // 2. Exact Execution Order (Company 101 -> All Invoices -> Company 102 -> All Invoices)
  // -------------------------------------------------------------
  test('2.1 Two-level execution strictly processes all invoices for Company 101 before Company 102', async () => {
    const executionTrace = [];

    const steps = [
      { id: 's1', type: 'CLICK', name: 'Login' },
      { id: 's2', type: 'CLICK', name: 'Select Company', target: { selector: '.company-item' } },
      { id: 's3', type: 'CLICK', name: 'Open Invoices' },
      { id: 's4', type: 'CLICK', name: 'Select Invoice', target: { selector: '.invoice-item' } },
      { id: 's5', type: 'CLICK', name: 'Download PDF', isDownload: true },
      { id: 's6', type: 'CLICK', name: 'Close Invoice' },
      { id: 's7', type: 'CLICK', name: 'Back to Companies' }
    ];

    const nestedConfig = {
      enabled: true,
      mode: 'two_level',
      outer: { name: 'company', anchorStepIndex: 1, startStepIndex: 1, endStepIndex: 6 },
      inner: { name: 'invoice', anchorStepIndex: 3, startStepIndex: 3, endStepIndex: 5 }
    };

    const runner = new LoopReplayRunner({
      runId: 'test_two_level_run_1',
      workflowId: 'wf_two_level_1',
      nestedLoop: nestedConfig
    });

    // Mock page
    const mockPage = {
      url: () => 'https://portal.example.com/app',
      mainFrame: () => ({}),
      evaluate: async () => []
    };

    // Mock ReplayEngine
    runner.replayEngine = {
      connect: async () => ({ pages: async () => [mockPage] }),
      page: mockPage,
      executeAction: async (action, index) => {
        executionTrace.push(`PAGE_ACTION: ${action.name} (step ${index + 1})`);
      },
      executeActionWithinItem: async (itemEl, action, index) => {
        executionTrace.push(`ITEM_ACTION: ${action.name} on [${itemEl.__id || 'item'}] (step ${index + 1})`);
      },
      _waitForLoadingMasks: async () => {},
      _waitForExtAjaxIdle: async () => {},
      _ensureSelectorResolverInFrame: async () => {},
      disconnect: async () => {}
    };

    runner.configureDownloadInterception = async () => {};
    runner.navigateToWorkflowTarget = async () => {};

    // Mock ItemDiscovery for Outer (Companies) and Inner (Invoices)
    const originalDiscover = ItemDiscovery.discover;
    const originalGetItemHandle = ItemDiscovery.getItemHandle;

    let outerDiscoveredCount = 0;
    let innerDiscoveryCalls = [];

    ItemDiscovery.discover = async (page, target) => {
      const sel = target?.selector || '';
      if (sel.includes('company')) {
        outerDiscoveredCount++;
        return {
          success: true,
          itemCount: 2,
          items: [
            { index: 0, text: 'Company 101', id: '101', fields: { 'Company ID': '101' } },
            { index: 1, text: 'Company 102', id: '102', fields: { 'Company ID': '102' } }
          ],
          collection: { collectionType: 'list-item' }
        };
      }
      if (sel.includes('invoice')) {
        // Inner invoices depend on current company context
        const isCompany101 = executionTrace.some(t => t.includes('101')) && !executionTrace.some(t => t.includes('102') && executionTrace.indexOf(t) > executionTrace.findLastIndex(e => e.includes('101')));
        const currentCompany = innerDiscoveryCalls.length === 0 ? '101' : '102';
        innerDiscoveryCalls.push(currentCompany);

        if (currentCompany === '101') {
          return {
            success: true,
            itemCount: 3,
            items: [
              { index: 0, text: 'Invoice A', id: 'INV-A', fields: { 'Invoice Number': 'INV-A' } },
              { index: 1, text: 'Invoice B', id: 'INV-B', fields: { 'Invoice Number': 'INV-B' } },
              { index: 2, text: 'Invoice C', id: 'INV-C', fields: { 'Invoice Number': 'INV-C' } }
            ],
            collection: { itemTag: 'tr', collectionType: 'table-row' }
          };
        } else {
          return {
            success: true,
            itemCount: 2,
            items: [
              { index: 0, text: 'Invoice D', id: 'INV-D', fields: { 'Invoice Number': 'INV-D' } },
              { index: 1, text: 'Invoice E', id: 'INV-E', fields: { 'Invoice Number': 'INV-E' } }
            ],
            collection: { itemTag: 'tr', collectionType: 'table-row' }
          };
        }
      }
      return { success: false };
    };

    ItemDiscovery.getItemHandle = async (page, discovery, index) => {
      const item = discovery.items[index];
      return {
        asElement: () => ({
          __id: item.id || item.text,
          dispose: async () => {}
        }),
        dispose: async () => {}
      };
    };

    try {
      const result = await runner.executeNestedLoop({ id: 'wf_two_level_1', name: 'Two Level Workflow', steps }, nestedConfig);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.manifest.outer.succeeded, 2);
      assert.strictEqual(result.manifest.inner.succeeded, 5); // 3 for 101 + 2 for 102

      // Verify sequence in executionTrace:
      // 1. Login runs once at start
      assert.strictEqual(executionTrace[0], 'PAGE_ACTION: Login (step 1)');

      // 2. Select Company 101
      const c101Idx = executionTrace.findIndex(t => t.includes('Company 101') || t.includes('[101]'));
      assert.ok(c101Idx > 0, 'Company 101 must be selected first');

      // 3. Invoices A, B, C executed
      const invAIdx = executionTrace.findIndex(t => t.includes('[INV-A]'));
      const invBIdx = executionTrace.findIndex(t => t.includes('[INV-B]'));
      const invCIdx = executionTrace.findIndex(t => t.includes('[INV-C]'));
      assert.ok(invAIdx > c101Idx && invBIdx > invAIdx && invCIdx > invBIdx, 'Invoices A, B, C must execute in order for Company 101');

      // 4. Return to company selection after Company 101 invoices
      const backToComp1Idx = executionTrace.findIndex((t, idx) => idx > invCIdx && t.includes('Back to Companies'));
      assert.ok(backToComp1Idx > invCIdx, 'Must return to company context after Company 101 invoices complete');

      // 5. Select Company 102
      const c102Idx = executionTrace.findIndex((t, idx) => idx > backToComp1Idx && (t.includes('Company 102') || t.includes('[102]')));
      assert.ok(c102Idx > backToComp1Idx, 'Company 102 must be selected AFTER Company 101 completes');

      // 6. Invoices D, E executed
      const invDIdx = executionTrace.findIndex(t => t.includes('[INV-D]'));
      const invEIdx = executionTrace.findIndex(t => t.includes('[INV-E]'));
      assert.ok(invDIdx > c102Idx && invEIdx > invDIdx, 'Invoices D, E must execute in order for Company 102');

      // 7. Return to company selection after Company 102 invoices
      const backToComp2Idx = executionTrace.findIndex((t, idx) => idx > invEIdx && t.includes('Back to Companies'));
      assert.ok(backToComp2Idx > invEIdx, 'Must return to company context after Company 102 invoices complete');

    } finally {
      ItemDiscovery.discover = originalDiscover;
      ItemDiscovery.getItemHandle = originalGetItemHandle;
    }
  });

  // -------------------------------------------------------------
  // 3. Composite Identity & NEW_ONLY Processing
  // -------------------------------------------------------------
  test('3.1 Composite identity ("companyId/recordId") correctly skips previously downloaded records in NEW_ONLY mode', () => {
    const runner = new LoopReplayRunner({
      runId: 'test_composite_run',
      newOnly: true
    });

    const mockManifest = {
      results: [
        { compositeKey: '101/INV-1001', companyId: '101', recordId: 'INV-1001', status: 'SUCCESS' },
        { compositeKey: '101/INV-1002', companyId: '101', recordId: 'INV-1002', status: 'SUCCESS' }
      ]
    };

    // Previously processed composite key
    assert.strictEqual(runner.checkCompositeAlreadyProcessed('101/INV-1001', '101', 'INV-1001', mockManifest), true);
    assert.strictEqual(runner.checkCompositeAlreadyProcessed('101/INV-1002', '101', 'INV-1002', mockManifest), true);

    // New invoice for company 101
    assert.strictEqual(runner.checkCompositeAlreadyProcessed('101/INV-1003', '101', 'INV-1003', mockManifest), false);

    // Same invoice number for different company (102/INV-1001) must NOT collide with 101/INV-1001!
    assert.strictEqual(runner.checkCompositeAlreadyProcessed('102/INV-1001', '102', 'INV-1001', mockManifest), false);
  });

  // -------------------------------------------------------------
  // 4. Execution State Isolation & Error Recovery Across Companies
  // -------------------------------------------------------------
  test('4.1 Failure in Company 101 does not prevent Company 102 from executing successfully', async () => {
    const steps = [
      { id: 's1', type: 'CLICK', name: 'Select Company', target: { selector: '.company-item' } },
      { id: 's2', type: 'CLICK', name: 'Select Invoice', target: { selector: '.invoice-item' } },
      { id: 's3', type: 'CLICK', name: 'Back to Companies' }
    ];

    const nestedConfig = {
      enabled: true,
      mode: 'two_level',
      outer: { name: 'company', anchorStepIndex: 0, startStepIndex: 0, endStepIndex: 2 },
      inner: { name: 'invoice', anchorStepIndex: 1, startStepIndex: 1, endStepIndex: 1 }
    };

    const runner = new LoopReplayRunner({
      runId: 'test_error_isolation',
      nestedLoop: nestedConfig
    });

    const mockPage = { url: () => 'https://portal.example.com', mainFrame: () => ({}), evaluate: async () => [] };
    let c101Failed = false;

    runner.replayEngine = {
      connect: async () => ({ pages: async () => [mockPage] }),
      page: mockPage,
      executeAction: async () => {},
      executeActionWithinItem: async (itemEl, action) => {
        if (itemEl.__id === 'INV-FAIL') {
          c101Failed = true;
          throw new Error('Simulated network timeout during invoice download');
        }
      },
      _waitForLoadingMasks: async () => {},
      _waitForExtAjaxIdle: async () => {},
      _ensureSelectorResolverInFrame: async () => {},
      disconnect: async () => {}
    };

    runner.configureDownloadInterception = async () => {};
    runner.navigateToWorkflowTarget = async () => {};

    const originalDiscover = ItemDiscovery.discover;
    const originalGetItemHandle = ItemDiscovery.getItemHandle;

    let companyCount = 0;
    ItemDiscovery.discover = async (page, target) => {
      const sel = target?.selector || '';
      if (sel.includes('company')) {
        return {
          success: true,
          itemCount: 2,
          items: [
            { index: 0, id: '101', text: 'Company 101' },
            { index: 1, id: '102', text: 'Company 102' }
          ],
          collection: { collectionType: 'list-item' }
        };
      }
      companyCount++;
      if (companyCount === 1) {
        return {
          success: true,
          itemCount: 1,
          items: [{ index: 0, id: 'INV-FAIL', text: 'Failing Invoice' }],
          collection: { collectionType: 'table-row' }
        };
      } else {
        return {
          success: true,
          itemCount: 1,
          items: [{ index: 0, id: 'INV-OK', text: 'Working Invoice' }],
          collection: { collectionType: 'table-row' }
        };
      }
    };

    ItemDiscovery.getItemHandle = async (page, disc, idx) => ({
      asElement: () => ({ __id: disc.items[idx].id, dispose: async () => {} }),
      dispose: async () => {}
    });

    try {
      const res = await runner.executeNestedLoop({ id: 'wf_fail_isolation', steps }, nestedConfig);
      assert.strictEqual(c101Failed, true, 'Company 101 invoice must have triggered simulated error');
      assert.strictEqual(res.manifest.outer.items[0].status, 'PARTIAL', 'Company 101 marked partial due to failed invoice');
      assert.strictEqual(res.manifest.outer.items[1].status, 'SUCCESS', 'Company 102 executed and completed successfully');
      assert.strictEqual(res.manifest.inner.succeeded, 1, 'Company 102 invoice succeeded');
      assert.strictEqual(res.manifest.inner.failed, 1, 'Company 101 invoice failed');
    } finally {
      ItemDiscovery.discover = originalDiscover;
      ItemDiscovery.getItemHandle = originalGetItemHandle;
    }
  });
});
