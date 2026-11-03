/**
 * Multi-Checkbox Default ON & Fidelity Execution Tests
 *
 * Verifies that when a workflow records or executes multiple checkbox clicks,
 * all checkboxes default to ON (checked=true, desiredState=true) and are faithfully
 * clicked without requiring manual configuration in the visual editor.
 */

const assert = require('assert');
const { executeClick } = require('../src/replay/action-executors');
const RecorderBridge = require('../src/recorder/recorder-bridge');
const SelectorResolver = require('../src/shared/selector-resolver');

console.log('🧪 Starting Multi-Checkbox Default ON & Workflow Execution Tests...\n');

(async () => {
  // ============================================================
  // Test 1: RecorderBridge defaults any clicked checkbox to ON
  // ============================================================
  console.log('🔹 Test 1: RecorderBridge defaults recorded checkbox clicks to ON');
  const bridge = new RecorderBridge({ name: 'test-multi-cb', outputDir: './test-output' });
  bridge.isRecording = true;

  // Simulate rawAction 1: User clicks an unchecked checkbox
  bridge._handleCapturedAction({
    type: 'CLICK',
    timestamp: Date.now(),
    target: {
      friendlyName: 'Customer A Checkbox',
      candidates: [{ strategy: 'css-path', value: '#chkCustA' }],
      fingerprint: {
        tagName: 'input',
        type: 'checkbox',
        isCheckbox: true,
        checked: false // Unchecked prior to click
      }
    }
  });

  // Simulate rawAction 2: User clicks a second unchecked checkbox
  bridge._handleCapturedAction({
    type: 'CLICK',
    timestamp: Date.now() + 1000,
    target: {
      friendlyName: 'Customer B Checkbox',
      candidates: [{ strategy: 'css-path', value: '#chkCustB' }],
      fingerprint: {
        tagName: 'mat-pseudo-checkbox',
        isCheckbox: true,
        checked: false // Unchecked prior to click
      }
    }
  });

  assert.strictEqual(bridge.actions.length, 2, 'Must have recorded 2 actions');
  assert.strictEqual(bridge.actions[0].isCheckbox, true, 'Action 1 must be flagged isCheckbox');
  assert.strictEqual(bridge.actions[0].desiredState, true, 'Action 1 desiredState must default to true (ON)');
  assert.strictEqual(bridge.actions[0].checked, true, 'Action 1 checked must default to true (ON)');

  assert.strictEqual(bridge.actions[1].isCheckbox, true, 'Action 2 must be flagged isCheckbox');
  assert.strictEqual(bridge.actions[1].desiredState, true, 'Action 2 desiredState must default to true (ON)');
  assert.strictEqual(bridge.actions[1].checked, true, 'Action 2 checked must default to true (ON)');
  console.log('  ✅ Both recorded checkboxes automatically defaulted to desiredState=true (ON)!');

  // ============================================================
  // Test 2: Sequential execution of 2 checkboxes without visual editor changes
  // ============================================================
  console.log('\n🔹 Test 2: Sequential execution of 2 checkboxes clicks and checks both');

  const pageState = {
    cb1Checked: false,
    cb2Checked: false,
    cb1Clicks: 0,
    cb2Clicks: 0
  };

  const createMockCbHandle = (id, key, clickCounter) => ({
    evaluate: async (fn, ...args) => {
      const mockEl = {
        tagName: 'INPUT',
        type: 'checkbox',
        get checked() { return pageState[key]; },
        offsetWidth: 20,
        offsetHeight: 20,
        getClientRects: () => [{ width: 20, height: 20 }],
        closest: () => null,
        querySelector: () => null,
        getAttribute: (attr) => attr === 'id' ? id : null,
        classList: { contains: () => false }
      };
      return fn(mockEl, ...args);
    },
    evaluateHandle: async () => null,
    click: async () => {
      pageState[clickCounter]++;
      pageState[key] = true;
    },
    boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 })
  });

  const cb1Handle = createMockCbHandle('chkCustA', 'cb1Checked', 'cb1Clicks');
  const cb2Handle = createMockCbHandle('chkCustB', 'cb2Checked', 'cb2Clicks');

  // Step 10: Click Checkbox 1
  const action1 = {
    index: 9,
    type: 'CLICK',
    name: 'Customer A Checkbox',
    elementName: 'Customer A Checkbox',
    isCheckbox: true,
    // Note: Even if desiredState was omitted or false in legacy recording, it must click and check
    target: {
      candidates: [{ strategy: 'css-path', value: '#chkCustA' }],
      fingerprint: { tagName: 'input', type: 'checkbox', isCheckbox: true, checked: false }
    }
  };

  // Step 11: Click Checkbox 2
  const action2 = {
    index: 10,
    type: 'CLICK',
    name: 'Customer B Checkbox',
    elementName: 'Customer B Checkbox',
    isCheckbox: true,
    target: {
      candidates: [{ strategy: 'css-path', value: '#chkCustB' }],
      fingerprint: { tagName: 'input', type: 'checkbox', isCheckbox: true, checked: false }
    }
  };

  // Execute Step 10
  await executeClick(cb1Handle, action1, { page: {} });
  assert.strictEqual(pageState.cb1Clicks, 1, 'Checkbox 1 must be clicked');
  assert.strictEqual(pageState.cb1Checked, true, 'Checkbox 1 must now be checked (ON)');

  // Execute Step 11
  await executeClick(cb2Handle, action2, { page: {} });
  assert.strictEqual(pageState.cb2Clicks, 1, 'Checkbox 2 must be clicked');
  assert.strictEqual(pageState.cb2Checked, true, 'Checkbox 2 must now be checked (ON)');

  // Verify BOTH checkboxes are checked!
  assert.strictEqual(pageState.cb1Checked, true, 'Checkbox 1 must remain checked');
  assert.strictEqual(pageState.cb2Checked, true, 'Checkbox 2 must remain checked');
  console.log('  ✅ Both checkboxes were clicked and are now checked (ON)!');

  // ============================================================
  // Test 3: Idempotent repeat run preserves both checkboxes
  // ============================================================
  console.log('\n🔹 Test 3: Repeating the workflow skips redundant clicks on both checked boxes');

  await executeClick(cb1Handle, action1, { page: {} });
  await executeClick(cb2Handle, action2, { page: {} });

  assert.strictEqual(pageState.cb1Clicks, 1, 'Checkbox 1 click count must remain 1 (skipped on retry)');
  assert.strictEqual(pageState.cb2Clicks, 1, 'Checkbox 2 click count must remain 1 (skipped on retry)');
  assert.strictEqual(pageState.cb1Checked, true, 'Checkbox 1 still checked');
  assert.strictEqual(pageState.cb2Checked, true, 'Checkbox 2 still checked');
  console.log('  ✅ On workflow retry, both checkboxes are preserved without toggling off!');

  // ============================================================
  // Test 4: Angular Material Multi-Select options
  // ============================================================
  console.log('\n🔹 Test 4: Multi-select Angular Material options with 2 sequential checks');

  const multiSelectState = {
    opt1Selected: false,
    opt2Selected: false,
    opt1Clicks: 0,
    opt2Clicks: 0
  };

  const createMockOptionHandle = (text, key, clickCounter) => {
    const handle = {
      evaluate: async (fn, ...args) => {
        const mockOpt = {
          tagName: 'MAT-OPTION',
          offsetWidth: 200,
          offsetHeight: 40,
          getClientRects: () => [{ width: 200, height: 40 }],
          closest: (sel) => {
            if (sel.includes('mat-option') || sel.includes('role="option"')) {
              return {
                getAttribute: (attr) => attr === 'aria-selected' ? String(multiSelectState[key]) : null,
                classList: {
                  contains: (cls) => multiSelectState[key] && (cls === 'mat-mdc-option-selected' || cls === 'mat-option-selected')
                },
                querySelector: () => null,
                click: () => {
                  multiSelectState[clickCounter]++;
                  multiSelectState[key] = !multiSelectState[key];
                }
              };
            }
            return null;
          },
          querySelector: () => null,
          getAttribute: () => null,
          classList: { contains: () => false }
        };
        return fn(mockOpt, ...args);
      },
      evaluateHandle: async () => ({ asElement: () => handle }),
      click: async () => {
        multiSelectState[clickCounter]++;
        multiSelectState[key] = true;
      },
      boundingBox: async () => ({ x: 10, y: 10, width: 200, height: 40 })
    };
    return handle;
  };

  const opt1Handle = createMockOptionHandle('Customer 105995', 'opt1Selected', 'opt1Clicks');
  const opt2Handle = createMockOptionHandle('Customer 106812', 'opt2Selected', 'opt2Clicks');

  const optAction1 = {
    index: 9,
    type: 'CLICK',
    name: '105995 - NORTH WEST MIAMI Option',
    elementName: '105995 - NORTH WEST MIAMI Option',
    isCheckbox: true,
    target: {
      candidates: [{ strategy: 'text', value: '//mat-option[contains(., "105995")]' }],
      fingerprint: { tagName: 'mat-option', role: 'option', isCheckbox: true, checked: false }
    }
  };

  const optAction2 = {
    index: 10,
    type: 'CLICK',
    name: '106812 - PINNACLE OIL Option',
    elementName: '106812 - PINNACLE OIL Option',
    isCheckbox: true,
    target: {
      candidates: [{ strategy: 'text', value: '//mat-option[contains(., "106812")]' }],
      fingerprint: { tagName: 'mat-option', role: 'option', isCheckbox: true, checked: false }
    }
  };

  await executeClick(opt1Handle, optAction1, { page: {} });
  assert.strictEqual(multiSelectState.opt1Clicks, 1, 'Option 1 must be clicked');
  assert.strictEqual(multiSelectState.opt1Selected, true, 'Option 1 must be selected');

  await executeClick(opt2Handle, optAction2, { page: {} });
  assert.strictEqual(multiSelectState.opt2Clicks, 1, 'Option 2 must be clicked');
  assert.strictEqual(multiSelectState.opt2Selected, true, 'Option 2 must be selected');

  // Both options must remain selected
  assert.strictEqual(multiSelectState.opt1Selected, true, 'Option 1 remains selected');
  assert.strictEqual(multiSelectState.opt2Selected, true, 'Option 2 remains selected');
  console.log('  ✅ Both Angular Material options are selected and remain selected together!');

  // Retry: verify neither option is unchecked
  await executeClick(opt1Handle, optAction1, { page: {} });
  await executeClick(opt2Handle, optAction2, { page: {} });
  assert.strictEqual(multiSelectState.opt1Clicks, 1, 'Option 1 click skipped on retry');
  assert.strictEqual(multiSelectState.opt2Clicks, 1, 'Option 2 click skipped on retry');
  assert.strictEqual(multiSelectState.opt1Selected, true, 'Option 1 still selected');
  assert.strictEqual(multiSelectState.opt2Selected, true, 'Option 2 still selected');
  console.log('  ✅ Option repeat correctly preserves both selections without toggling off!');

  // ============================================================
  // Test 5: Unchecking an initially checked checkbox faithfully unchecks it
  // ============================================================
  console.log('\n🔹 Test 5: Explicit uncheck action faithfully sets desiredState=false');

  const uncheckState = {
    row1Checked: true,  // Initially checked
    row2Checked: false, // Initially unchecked
    row1Clicks: 0,
    row2Clicks: 0
  };

  const createRowCbHandle = (key, clickKey) => ({
    evaluate: async (fn, ...args) => {
      const mockEl = {
        tagName: 'INPUT',
        type: 'checkbox',
        get checked() { return uncheckState[key]; },
        offsetWidth: 20,
        offsetHeight: 20,
        getClientRects: () => [{ width: 20, height: 20 }],
        closest: () => null,
        querySelector: () => null,
        getAttribute: () => null,
        classList: { contains: () => false }
      };
      return fn(mockEl, ...args);
    },
    evaluateHandle: async () => null,
    click: async () => {
      uncheckState[clickKey]++;
      uncheckState[key] = !uncheckState[key];
    },
    boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 })
  });

  const row1Handle = createRowCbHandle('row1Checked', 'row1Clicks');
  const row2Handle = createRowCbHandle('row2Checked', 'row2Clicks');

  // Step A: User records unchecking Row 1
  const bridgeUncheck = new RecorderBridge({ name: 'test-uncheck', outputDir: './test-output' });
  bridgeUncheck.isRecording = true;
  bridgeUncheck._handleCapturedAction({
    type: 'CLICK',
    timestamp: Date.now(),
    desiredState: false,
    checked: false,
    isUncheck: true,
    target: {
      friendlyName: 'Row 1 Checkbox',
      candidates: [{ strategy: 'css-path', value: '#row1' }],
      fingerprint: { tagName: 'input', type: 'checkbox', isCheckbox: true, checked: false }
    }
  });

  assert.strictEqual(bridgeUncheck.actions[0].desiredState, false, 'Uncheck action must preserve desiredState=false');
  assert.strictEqual(bridgeUncheck.actions[0].checked, false, 'Uncheck action must preserve checked=false');
  assert.strictEqual(bridgeUncheck.actions[0].isUncheck, true, 'Uncheck action must preserve isUncheck=true');

  // Step B: Execute uncheck Row 1 on page where Row 1 was checked
  await executeClick(row1Handle, bridgeUncheck.actions[0], { page: {} });
  assert.strictEqual(uncheckState.row1Clicks, 1, 'Row 1 checkbox must be clicked to uncheck');
  assert.strictEqual(uncheckState.row1Checked, false, 'Row 1 checkbox must now be false (UNCHECKED)');

  // Step C: Execute check Row 2
  const checkRow2Action = {
    type: 'CLICK',
    name: 'Row 2 Checkbox',
    isCheckbox: true,
    desiredState: true,
    checked: true,
    target: { candidates: [{ strategy: 'css-path', value: '#row2' }] }
  };
  await executeClick(row2Handle, checkRow2Action, { page: {} });
  assert.strictEqual(uncheckState.row2Clicks, 1, 'Row 2 checkbox must be clicked to check');
  assert.strictEqual(uncheckState.row2Checked, true, 'Row 2 checkbox must now be true (CHECKED)');

  // Final check: Row 1 is UNCHECKED, Row 2 is CHECKED!
  assert.strictEqual(uncheckState.row1Checked, false, 'Row 1 must be unchecked');
  assert.strictEqual(uncheckState.row2Checked, true, 'Row 2 must be checked');
  console.log('  ✅ Uncheck Row 1 + Check Row 2 resulted in ONLY Row 2 checked!');

  console.log('\n🎉 ALL MULTI-CHECKBOX DEFAULT ON & UNCHECK TESTS PASSED PERFECTLY!\n');
})();
