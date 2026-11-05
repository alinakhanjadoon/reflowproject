/**
 * Test Suite: Execution Mode Resolution (Macro vs Loop)
 */

const assert = require('assert');
const LoopReplayRunner = require('../src/replay/loop-replay-runner');
const LoopDetector = require('../src/shared/loop-detector');

async function runExecutionModeTests() {
  console.log('🧪 Starting Execution Mode (Macro vs Loop) Test Suite...\n');

  // Test 1: Default execution mode resolution without loop params MUST run as single/macro, NOT loop
  console.log('🔹 Test 1: Default execution runner options resolve to single macro');
  const runner1 = new LoopReplayRunner({
    runId: 'run_macro_1',
    workflowId: 'wf_macro_1',
    workflowName: 'Simple Macro Replay'
  });
  assert.strictEqual(runner1.mode, 'single', 'Default mode must be single');
  assert.strictEqual(runner1.isLoop, false, 'Default isLoop must be false');
  assert.strictEqual(runner1.loopStepIndex, null, 'Default loopStepIndex must be null');
  console.log('  ✅ Default execution correctly defaulted to single macro\n');

  // Test 2: Explicit single mode request
  console.log('🔹 Test 2: Explicit single mode request');
  const runner2 = new LoopReplayRunner({
    runId: 'run_single_2',
    workflowId: 'wf_single_2',
    mode: 'single',
    isLoop: false
  });
  assert.strictEqual(runner2.mode, 'single', 'Explicit mode must be single');
  assert.strictEqual(runner2.isLoop, false, 'Explicit isLoop must be false');
  console.log('  ✅ Explicit single mode confirmed\n');

  // Test 2b: Standard Run (mode: 'standard') resolves to single execution even if workflow has saved loop config
  console.log('🔹 Test 2b: Standard Run (mode: "standard") resolves to single execution');
  const runner2b = new LoopReplayRunner({
    runId: 'run_standard_2b',
    workflowId: 'wf_standard_2b',
    mode: 'standard',
    workflow: {
      id: 'wf_standard_2b',
      loop: { enabled: true, anchorStepIndex: 1, startStepIndex: 1, endStepIndex: 2 }
    }
  });
  assert.strictEqual(runner2b.mode, 'single', 'mode: "standard" must resolve to single');
  assert.strictEqual(runner2b.isLoop, false, 'mode: "standard" must enforce isLoop: false');
  assert.strictEqual(runner2b.loopConfig.enabled, false, 'loopConfig must be disabled for standard run');
  console.log('  ✅ Standard run mode confirmed as strictly single\n');

  // Test 3: Explicit loop mode request resolves to loop with loopStepIndex
  console.log('🔹 Test 3: Explicit loop mode request');
  const runner3 = new LoopReplayRunner({
    runId: 'run_loop_3',
    workflowId: 'wf_loop_3',
    mode: 'loop',
    isLoop: true,
    loopStepIndex: 1
  });
  assert.strictEqual(runner3.mode, 'loop', 'Explicit mode must be loop');
  assert.strictEqual(runner3.isLoop, true, 'isLoop must be true');
  assert.strictEqual(runner3.loopStepIndex, 1, 'loopStepIndex must match configured index');
  console.log('  ✅ Explicit loop mode confirmed\n');

  // Test 4: LoopDetector distinguishes setup vs repeating candidate steps
  console.log('🔹 Test 4: LoopDetector distinguishes setup vs repeating candidate steps');
  const steps = [
    {
      type: 'NAVIGATE',
      url: 'https://billing.example.com/invoices',
      role: 'SETUP'
    },
    {
      type: 'CLICK',
      target: {
        fingerprint: {
          tagName: 'tr',
          parentTag: 'tbody',
          selectors: { cssPath: 'table#invoices tbody > tr:nth-child(1) td a.download' }
        }
      }
    }
  ];

  const analysis = LoopDetector.analyzeWorkflow(steps);
  assert.strictEqual(analysis.isLoop, true, 'Repeating table row click must be detected as loop candidate');
  assert.strictEqual(analysis.loopStepIndex, 1, 'Loop start index must be step 1');
  assert.strictEqual(analysis.setupSteps.length, 1, 'Step 0 must be separated into setup');
  assert.strictEqual(analysis.loopSteps.length, 1, 'Step 1 must be separated into loopSteps');
  console.log('  ✅ LoopDetector workflow analysis passed\n');

  console.log('🎉 ALL EXECUTION MODE TESTS PASSED SUCCESSFULLY!\n');
}

runExecutionModeTests().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
