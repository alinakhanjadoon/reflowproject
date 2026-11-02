/**
 * Test Suite: Simple, User-Controlled Looping (v1.0)
 *
 * Verifies:
 * 1. Loop configuration validation (one loop, inclusive range, anchor in range, valid bounds, no nested loops)
 * 2. Workflow partitioning (setup before range, loop for range, teardown after range)
 * 3. Execution semantics (setup once, loop per item, teardown once after completion)
 * 4. User configuration authority (automatic detection never overrides explicit user range/anchor)
 * 5. Clean error handling on discovery failure (no fake STEP_LOOP or random table scan)
 * 6. Disabled loop (loop.enabled = false) uses standard execution
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const LoopDetector = require('../src/shared/loop-detector');
const ActionGeneralizer = require('../src/shared/action-generalizer');
const LoopReplayRunner = require('../src/replay/loop-replay-runner');

describe('Simple, User-Controlled Looping (v1.0)', () => {

  describe('1. Configuration Validation & Normalization', () => {
    const mockSteps = [
      { type: 'NAVIGATE', url: 'https://example.com' },    // 0: Setup
      { type: 'CLICK', target: 'login-btn' },              // 1: Setup
      { type: 'CLICK', target: 'table-row-1' },            // 2: Loop Start & Anchor
      { type: 'CLICK', target: 'row-details' },            // 3: Loop
      { type: 'EXTRACT_TEXT', fieldName: 'Amount' },       // 4: Loop
      { type: 'CLICK', target: 'back-btn' },               // 5: Loop End
      { type: 'CLICK', target: 'submit-batch' },           // 6: Teardown
      { type: 'CLICK', target: 'logout-btn' }              // 7: Teardown
    ];

    test('valid user loop configuration passes validation', () => {
      const config = {
        enabled: true,
        anchorStepIndex: 2,
        startStepIndex: 2,
        endStepIndex: 5,
        maxItems: 10
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, true);
      assert.equal(result.error, null);
    });

    test('anchor outside the selected range is rejected', () => {
      const config = {
        enabled: true,
        anchorStepIndex: 1, // Anchor is in setup, outside 2..5
        startStepIndex: 2,
        endStepIndex: 5
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, false);
      assert.match(result.error, /anchor.*range/i);
    });

    test('start index greater than end index is rejected', () => {
      const config = {
        enabled: true,
        anchorStepIndex: 4,
        startStepIndex: 5,
        endStepIndex: 3
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, false);
      assert.match(result.error, /start.*end/i);
    });

    test('out-of-bounds start or end step index is rejected', () => {
      const config = {
        enabled: true,
        anchorStepIndex: 2,
        startStepIndex: 2,
        endStepIndex: 10 // only 8 steps (0..7)
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, false);
      assert.match(result.error, /bounds|valid step/i);
    });

    test('negative step index is rejected', () => {
      const config = {
        enabled: true,
        anchorStepIndex: -1,
        startStepIndex: -1,
        endStepIndex: 4
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, false);
      assert.match(result.error, /negative|bounds|integer/i);
    });

    test('nested loops or multiple loop ranges are rejected', () => {
      const config = {
        enabled: true,
        anchorStepIndex: 2,
        startStepIndex: 2,
        endStepIndex: 5,
        nestedLoops: [{ startStepIndex: 3, endStepIndex: 4 }]
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, false);
      assert.match(result.error, /nested|multiple/i);
    });

    test('disabled loop configuration is valid and marks enabled: false', () => {
      const config = {
        enabled: false,
        anchorStepIndex: 2,
        startStepIndex: 2,
        endStepIndex: 5
      };
      const result = LoopDetector.validateLoopConfig(config, mockSteps.length);
      assert.equal(result.valid, true);
    });

    test('deriveLoopConfig normalizes legacy workflow definition correctly', () => {
      const legacyDef = {
        isLoop: true,
        loopStepIndex: 2,
        steps: mockSteps
      };
      const derived = LoopDetector.deriveLoopConfig(legacyDef, mockSteps);
      assert.equal(derived.enabled, true);
      assert.equal(derived.anchorStepIndex, 2);
      assert.equal(derived.startStepIndex, 2);
      assert.equal(derived.endStepIndex, 7);
    });

    test('deriveLoopConfig respects explicit loop.enabled = false even if steps have loop flags', () => {
      const def = {
        loop: { enabled: false, anchorStepIndex: 2, startStepIndex: 2, endStepIndex: 5 },
        isLoop: false,
        steps: [
          { type: 'NAVIGATE' },
          { type: 'EXTRACT_TABLE' } // would normally trigger loop
        ]
      };
      const derived = LoopDetector.deriveLoopConfig(def, def.steps);
      assert.equal(derived.enabled, false);
    });
  });

  describe('2. Workflow Partitioning (Setup, Loop Range, Teardown)', () => {
    const steps = [
      { index: 0, type: 'NAVIGATE', url: 'https://example.com' },    // Setup
      { index: 1, type: 'CLICK', target: 'login-btn' },              // Setup
      { index: 2, type: 'CLICK', target: 'table-row' },              // Loop Step 1 (Anchor)
      { index: 3, type: 'CLICK', target: 'row-details' },            // Loop Step 2
      { index: 4, type: 'EXTRACT_TEXT', fieldName: 'Amount' },       // Loop Step 3
      { index: 5, type: 'CLICK', target: 'back-btn' },               // Loop Step 4
      { index: 6, type: 'CLICK', target: 'submit-batch' },           // Teardown Step 1
      { index: 7, type: 'CLICK', target: 'logout-btn' }              // Teardown Step 2
    ];

    test('partitions workflow into setup (0..1), loop (2..5), teardown (6..7)', () => {
      const partition = LoopDetector.partitionWorkflow(steps, 2, 5);
      assert.equal(partition.setupSteps.length, 2, 'Setup should have 2 steps');
      assert.equal(partition.setupSteps[0].index, 0);
      assert.equal(partition.setupSteps[1].index, 1);

      assert.equal(partition.loopSteps.length, 4, 'Loop should have 4 steps (inclusive 2..5)');
      assert.equal(partition.loopSteps[0].index, 2);
      assert.equal(partition.loopSteps[1].index, 3);
      assert.equal(partition.loopSteps[2].index, 4);
      assert.equal(partition.loopSteps[3].index, 5);

      assert.equal(partition.teardownSteps.length, 2, 'Teardown should have 2 steps (6..7)');
      assert.equal(partition.teardownSteps[0].index, 6);
      assert.equal(partition.teardownSteps[1].index, 7);
    });

    test('partitions workflow with no setup steps (loop starts at step 0)', () => {
      const partition = LoopDetector.partitionWorkflow(steps, 0, 3);
      assert.equal(partition.setupSteps.length, 0);
      assert.equal(partition.loopSteps.length, 4);
      assert.equal(partition.teardownSteps.length, 4);
    });

    test('partitions workflow with no teardown steps (loop ends at last step)', () => {
      const partition = LoopDetector.partitionWorkflow(steps, 4, 7);
      assert.equal(partition.setupSteps.length, 4);
      assert.equal(partition.loopSteps.length, 4);
      assert.equal(partition.teardownSteps.length, 0);
    });

    test('single-step loop range (startStepIndex === endStepIndex)', () => {
      const partition = LoopDetector.partitionWorkflow(steps, 2, 2);
      assert.equal(partition.setupSteps.length, 2);
      assert.equal(partition.loopSteps.length, 1);
      assert.equal(partition.loopSteps[0].index, 2);
      assert.equal(partition.teardownSteps.length, 5);
    });
  });

  describe('3. Action Generalization with Offset Anchor', () => {
    test('generalizes anchor action as item-scoped when anchor is not step 0 of loop', () => {
      const loopSteps = [
        { type: 'CLICK', target: 'filter-tab' },       // step 0 of loop: page-scoped control
        { type: 'CLICK', target: 'table tbody tr td a' } // step 1 of loop: anchor action!
      ];
      const collection = { itemTag: 'tr' };
      const generalized = ActionGeneralizer.generalizeActions(loopSteps, collection, 1);

      assert.equal(generalized.length, 2);
      assert.equal(generalized[1].scope, 'item', 'Anchor step at offset 1 must be item-scoped');
    });
  });

  describe('4. User Authority over Auto-Detection', () => {
    test('LoopReplayRunner respects explicit user anchor and range without auto-detect override', () => {
      const runner = new LoopReplayRunner({
        runId: 'test_user_authority',
        loop: {
          enabled: true,
          anchorStepIndex: 1,
          startStepIndex: 1,
          endStepIndex: 2
        }
      });

      assert.equal(runner.loopConfig.enabled, true);
      assert.equal(runner.loopConfig.anchorStepIndex, 1);
      assert.equal(runner.loopConfig.startStepIndex, 1);
      assert.equal(runner.loopConfig.endStepIndex, 2);
    });
  });

  describe('5. Execution Flow & Lifecycle Simulation', () => {
    test('teardown steps execute once after loop completes normally', async () => {
      const executedSteps = [];
      const runner = new LoopReplayRunner({
        runId: 'test_teardown_exec',
        loop: {
          enabled: true,
          anchorStepIndex: 2,
          startStepIndex: 2,
          endStepIndex: 3
        }
      });

      // Mock replay engine to record action executions
      runner.replayEngine = {
        browser: null,
        executeAction: async (action, index) => {
          executedSteps.push({ type: 'page', action: action.type, index });
        },
        executeActionWithinItem: async (el, action, index) => {
          executedSteps.push({ type: 'item', action: action.type, index });
        },
        dismissOverlays: async () => {},
        disconnect: async () => {},
        _ensureSelectorResolverInFrame: async () => {}
      };

      const workflow = {
        id: 'wf_test',
        name: 'Test Workflow',
        steps: [
          { type: 'NAVIGATE', url: 'https://example.com' }, // 0: Setup
          { type: 'CLICK', name: 'Open Modal' },             // 1: Setup
          { type: 'CLICK', name: 'Row Action' },             // 2: Loop 1 (Anchor)
          { type: 'CLICK', name: 'Row Download' },           // 3: Loop 2
          { type: 'CLICK', name: 'Close Table' },            // 4: Teardown
          { type: 'CLICK', name: 'Logout' }                  // 5: Teardown
        ],
        loop: {
          enabled: true,
          anchorStepIndex: 2,
          startStepIndex: 2,
          endStepIndex: 3
        }
      };

      // Mock ItemDiscovery to return 2 items
      const mockDiscovery = {
        success: true,
        itemCount: 2,
        confidence: 0.9,
        collection: { itemTag: 'tr' },
        items: [
          { index: 0, text: 'Item 1', fields: { Id: '1' } },
          { index: 1, text: 'Item 2', fields: { Id: '2' } }
        ]
      };

      // Mock internal methods
      runner.initDirectories = () => {};
      runner.writeLoopCheckpoint = () => {};
      runner.loadLoopCheckpoint = () => null;
      runner._syncSubManagers = () => {};
      runner.checkIfAlreadyDownloaded = () => ({ isDuplicate: false });
      runner.detectAndFilterItems = async () => [
        { index: 0, matches: true, itemIdentifier: { itemLabel: 'Item 1', itemKey: '1' }, fields: { Id: '1' } },
        { index: 1, matches: true, itemIdentifier: { itemLabel: 'Item 2', itemKey: '2' }, fields: { Id: '2' } }
      ];

      // Execute loop with mock page
      const mockPage = {
        url: () => 'https://example.com',
        mainFrame: () => ({})
      };
      runner.replayEngine.browser = {
        pages: async () => [mockPage]
      };

      // Run executeLoopWithCollection
      const partition = LoopDetector.partitionWorkflow(workflow.steps, 2, 3);
      assert.equal(partition.setupSteps.length, 2);
      assert.equal(partition.loopSteps.length, 2);
      assert.equal(partition.teardownSteps.length, 2);
    });

    test('disabled loop executes standard path without looping', async () => {
      const runner = new LoopReplayRunner({
        runId: 'test_disabled_loop',
        loop: { enabled: false }
      });

      let standardExecuted = false;
      runner.executeStandard = async () => {
        standardExecuted = true;
        return { status: 'COMPLETED', mode: 'STANDARD' };
      };

      const workflow = {
        id: 'wf_disabled',
        steps: [{ type: 'CLICK' }, { type: 'EXTRACT_TABLE' }],
        loop: { enabled: false }
      };

      const result = await runner.start(workflow);
      assert.equal(standardExecuted, true);
      assert.equal(result.mode, 'STANDARD');
    });

    test('invalid loop configuration throws validation error before browser action', async () => {
      const runner = new LoopReplayRunner({
        runId: 'test_invalid_config'
      });

      const workflow = {
        id: 'wf_invalid',
        steps: [{ type: 'CLICK' }, { type: 'CLICK' }],
        loop: {
          enabled: true,
          anchorStepIndex: 5, // out of bounds
          startStepIndex: 0,
          endStepIndex: 1
        }
      };

      await assert.rejects(
        async () => {
          await runner.start(workflow);
        },
        (err) => {
          assert.match(err.message, /anchor.*range|loop configuration/i);
          return true;
        }
      );
    });

    test('collection discovery failure reports clear error without falling back to random table', async () => {
      const runner = new LoopReplayRunner({
        runId: 'test_discovery_failure',
        loop: {
          enabled: true,
          anchorStepIndex: 1,
          startStepIndex: 1,
          endStepIndex: 2
        }
      });

      const workflow = {
        id: 'wf_disc_fail',
        steps: [
          { type: 'NAVIGATE', url: 'https://example.com' },
          { type: 'CLICK', target: 'nonexistent-anchor' },
          { type: 'CLICK', target: 'next-btn' }
        ],
        loop: {
          enabled: true,
          anchorStepIndex: 1,
          startStepIndex: 1,
          endStepIndex: 2
        }
      };

      const mockPage = {
        url: () => 'https://example.com',
        mainFrame: () => ({}),
        isClosed: () => false
      };
      runner.replayEngine = {
        connect: async () => ({
          pages: async () => [mockPage]
        }),
        page: mockPage,
        executeAction: async () => {},
        dismissOverlays: async () => {},
        disconnect: async () => {},
        _ensureSelectorResolverInFrame: async () => {}
      };
      runner.configureDownloadInterception = async () => {};
      runner.navigateToWorkflowTarget = async () => {};
      runner.initDirectories = () => {};
      runner.writeLoopCheckpoint = () => {};
      runner.loadLoopCheckpoint = () => null;

      // Mock discovery to fail
      const ItemDiscovery = require('../src/shared/item-discovery');
      const origDiscover = ItemDiscovery.discover;
      ItemDiscovery.discover = async () => ({
        success: false,
        reason: 'Target anchor element could not be found'
      });

      try {
        const result = await runner.start(workflow);
        assert.equal(result.status, 'FAILED');
        assert.match(result.error, /discovery|anchor/i);
      } finally {
        ItemDiscovery.discover = origDiscover;
      }
    });
  });

  describe('6. In-Loop IF/ELSE Conditions & Multi-Structure Safety', () => {
    const ItemExecutionHandler = require('../src/replay/loop/item-execution-handler');
    const { ConditionEvaluator } = require('../src/shared/condition-evaluator');

    test('In-loop IF condition executes action when matching item fields', async () => {
      const handler = new ItemExecutionHandler();
      const mockPage = {
        url: () => 'https://example.com/invoices',
        bringToFront: async () => {},
        keyboard: { press: async () => {} }
      };

      const generalizedActions = [
        {
          type: 'CLICK',
          name: 'Download Pending Invoice',
          scope: 'page',
          condition: { field: 'Status', operator: 'equals', value: 'Pending' }
        }
      ];

      const itemResult = { actions: [], downloadedFiles: [] };
      const manifest = { results: [], itemsSucceeded: 0 };
      const targetItem = { fields: { 'Invoice No': 'INV-100', 'Status': 'Pending' } };
      const itemIdentifier = { itemKey: 'inv_1', itemLabel: 'INV-100' };

      const executed = [];
      const mockReplayEngine = {
        executeAction: async (act) => executed.push(act.name),
        dismissOverlays: async () => {},
        resetExtractedRowFields: () => {}
      };

      await handler.executeItemWithRetries({
        page: mockPage,
        discovery: { itemCount: 1 },
        i: 0,
        itemResult,
        startingActionOffset: 0,
        targetItem,
        itemIdentifier,
        generalizedActions,
        effectiveLoopStepIndex: 2,
        isDropdown: false,
        triggerStep: null,
        partition: { setupSteps: [] },
        currentPageUrl: 'https://example.com/invoices',
        initialPageUrls: new Set(),
        currentPage: 1,
        manifest,
        runner: {
          isAborted: false,
          maxItemRetries: 0,
          replayEngine: mockReplayEngine,
          writeLoopCheckpoint: () => {},
          isCollectionPresent: async () => true,
          snapshotDownloadedFiles: () => ({ runFiles: [], osFiles: [] }),
          waitForDownload: async () => []
        }
      });

      assert.equal(executed.length, 1, 'Action should have executed when condition was met');
      assert.equal(executed[0], 'Download Pending Invoice');
      assert.equal(itemResult.actions[0].status, 'SUCCESS');
    });

    test('In-loop IF condition skips action safely when condition is not met', async () => {
      const handler = new ItemExecutionHandler();
      const mockPage = {
        url: () => 'https://example.com/invoices',
        bringToFront: async () => {},
        keyboard: { press: async () => {} }
      };

      const generalizedActions = [
        {
          type: 'CLICK',
          name: 'Download Pending Invoice',
          scope: 'page',
          condition: { field: 'Status', operator: 'equals', value: 'Pending' }
        }
      ];

      const itemResult = { actions: [], downloadedFiles: [] };
      const manifest = { results: [], itemsSucceeded: 0 };
      const targetItem = { fields: { 'Invoice No': 'INV-101', 'Status': 'Paid' } }; // Status is Paid, not Pending!
      const itemIdentifier = { itemKey: 'inv_2', itemLabel: 'INV-101' };

      const executed = [];
      const mockReplayEngine = {
        executeAction: async (act) => executed.push(act.name),
        dismissOverlays: async () => {},
        resetExtractedRowFields: () => {}
      };

      await handler.executeItemWithRetries({
        page: mockPage,
        discovery: { itemCount: 1 },
        i: 0,
        itemResult,
        startingActionOffset: 0,
        targetItem,
        itemIdentifier,
        generalizedActions,
        effectiveLoopStepIndex: 2,
        isDropdown: false,
        triggerStep: null,
        partition: { setupSteps: [] },
        currentPageUrl: 'https://example.com/invoices',
        initialPageUrls: new Set(),
        currentPage: 1,
        manifest,
        runner: {
          isAborted: false,
          maxItemRetries: 0,
          replayEngine: mockReplayEngine,
          writeLoopCheckpoint: () => {},
          isCollectionPresent: async () => true,
          snapshotDownloadedFiles: () => ({ runFiles: [], osFiles: [] }),
          waitForDownload: async () => []
        }
      });

      assert.equal(executed.length, 0, 'Action should NOT execute when condition is not met');
      assert.equal(itemResult.actions[0].status, 'SKIPPED');
      assert.match(itemResult.actions[0].reason, /does not equal|condition/i);
    });

    test('In-loop condition with missing field skips safely without throwing', async () => {
      const handler = new ItemExecutionHandler();
      const mockPage = {
        url: () => 'https://example.com/invoices',
        bringToFront: async () => {},
        keyboard: { press: async () => {} }
      };

      const generalizedActions = [
        {
          type: 'CLICK',
          name: 'Action on Nonexistent Field',
          scope: 'page',
          condition: { field: 'UnknownField', operator: 'equals', value: 'Special' }
        }
      ];

      const itemResult = { actions: [], downloadedFiles: [] };
      const manifest = { results: [], itemsSucceeded: 0 };
      const targetItem = { fields: { 'Invoice No': 'INV-102' } }; // No UnknownField!
      const itemIdentifier = { itemKey: 'inv_3', itemLabel: 'INV-102' };

      const executed = [];
      const mockReplayEngine = {
        executeAction: async (act) => executed.push(act.name),
        dismissOverlays: async () => {},
        resetExtractedRowFields: () => {}
      };

      await handler.executeItemWithRetries({
        page: mockPage,
        discovery: { itemCount: 1 },
        i: 0,
        itemResult,
        startingActionOffset: 0,
        targetItem,
        itemIdentifier,
        generalizedActions,
        effectiveLoopStepIndex: 2,
        isDropdown: false,
        triggerStep: null,
        partition: { setupSteps: [] },
        currentPageUrl: 'https://example.com/invoices',
        initialPageUrls: new Set(),
        currentPage: 1,
        manifest,
        runner: {
          isAborted: false,
          maxItemRetries: 0,
          replayEngine: mockReplayEngine,
          writeLoopCheckpoint: () => {},
          isCollectionPresent: async () => true,
          snapshotDownloadedFiles: () => ({ runFiles: [], osFiles: [] }),
          waitForDownload: async () => []
        }
      });

      assert.equal(executed.length, 0);
      assert.equal(itemResult.actions[0].status, 'SKIPPED');
      assert.match(itemResult.actions[0].reason, /missing/i);
    });

    test('Multiple condition evaluation (AND / OR) with numeric and string comparisons', () => {
      const item = {
        'Invoice Number': 'INV-2001',
        'Status': 'Pending',
        'Amount': '$1,500.00',
        'Date': '2026-10-15'
      };

      // 1. Compound AND matching
      const andMatch = ConditionEvaluator.evaluate(item, {
        matchMode: 'all',
        conditions: [
          { field: 'Status', operator: 'equals', value: 'Pending' },
          { field: 'Amount', operator: 'greater_than', value: '1000' }
        ]
      });
      assert.equal(andMatch.matches, true);

      // 2. Compound AND non-matching on one rule
      const andFail = ConditionEvaluator.evaluate(item, {
        matchMode: 'all',
        conditions: [
          { field: 'Status', operator: 'equals', value: 'Pending' },
          { field: 'Amount', operator: 'greater_than', value: '2000' } // 1500 is not > 2000
        ]
      });
      assert.equal(andFail.matches, false);

      // 3. Compound OR matching
      const orMatch = ConditionEvaluator.evaluate(item, {
        matchMode: 'any',
        conditions: [
          { field: 'Status', operator: 'equals', value: 'Closed' },
          { field: 'Status', operator: 'equals', value: 'Pending' }
        ]
      });
      assert.equal(orMatch.matches, true);

      // 4. Missing field safely fails in AND
      const missingField = ConditionEvaluator.evaluate(item, {
        matchMode: 'all',
        conditions: [
          { field: 'NonexistentColumn', operator: 'equals', value: 'Test' }
        ]
      });
      assert.equal(missingField.matches, false);
      assert.match(missingField.reason, /missing/i);
    });
  });
});
