const assert = require('assert');
const ActionGeneralizer = require('../src/shared/action-generalizer');

function run() {
  console.log('🧪 Starting Action Generalizer Unit Tests...\n');

  console.log('🔹 Test 1: Convert nth-row CSS path to item-relative path');
  const relative = ActionGeneralizer.toRelativeCss(
    'table#invoices tbody > tr:nth-child(1) > td:nth-child(5) > a.btn-download',
    'tr'
  );
  assert.strictEqual(relative, 'td:nth-child(5) > a.btn-download');
  console.log('  ✅ Relative selector passed\n');

  console.log('🔹 Test 2: Targeting the item itself returns :scope');
  assert.strictEqual(
    ActionGeneralizer.toRelativeCss('table#invoices > tbody > tr:nth-child(1)', 'tr'),
    ':scope'
  );
  console.log('  ✅ Item-target selector passed\n');

  console.log('🔹 Test 3: Generalize a recorded action');
  const action = {
    type: 'CLICK',
    target: {
      candidates: [{ strategy: 'css-path', value: 'table tbody > tr:nth-child(1) > td > a.btn-download', priority: 5 }],
      fingerprint: { tagName: 'a', text: 'Download' }
    }
  };
  const generalized = ActionGeneralizer.generalizeAction(action, {
    itemTag: 'tr',
    itemSignature: 'tr|td>td|'
  });
  assert.strictEqual(generalized.scope, 'item');
  assert.strictEqual(generalized.target.scope, 'item');
  assert.strictEqual(generalized.target.candidates[0].value, 'td > a.btn-download');
  assert.strictEqual(ActionGeneralizer.isGeneralized(generalized), true);
  console.log('  ✅ Action generalization passed\n');

  console.log('🔹 Test 4: Generalize multiple actions');
  const generalizedActions = ActionGeneralizer.generalizeActions([
    action,
    {
      type: 'CLICK',
      target: {
        candidates: [{ strategy: 'css-path', value: 'table tbody > tr:nth-child(1) > td:nth-child(5) > a.btn-mark', priority: 4 }],
        fingerprint: { tagName: 'a', text: 'Mark' }
      }
    }
  ], { itemTag: 'tr' });
  assert.strictEqual(generalizedActions.length, 2);
  assert(generalizedActions.every(ActionGeneralizer.isGeneralized));
  console.log('  ✅ Multi-action generalization passed\\n');

  console.log('🔹 Test 5: Ignore non-CSS candidates lacking row ancestry');
  const target = ActionGeneralizer.generalizeTarget({
    candidates: [{ strategy: 'xpath', value: '//a[text()="Download"]' }],
    fingerprint: { tagName: 'a', text: 'Download' }
  }, { itemTag: 'tr' });
  assert.strictEqual(target.candidates.length, 0);
  assert.strictEqual(target.fingerprint.text, 'Download');
  console.log('  ✅ Non-CSS non-row candidate handling passed\n');

  console.log('🔹 Test 6: Convert row-anchored absolute XPath to item-relative XPath');
  const relXpath = ActionGeneralizer.toRelativeXPath('//table[@id="invoices"]//tr[1]//button[@title="Download"]', 'tr');
  assert.strictEqual(relXpath, './/button[@title="Download"]');
  const targetXpath = ActionGeneralizer.generalizeTarget({
    candidates: [{ strategy: 'xpath', value: '//table[@id="invoices"]//tr[1]//button[@title="Download"]' }],
    fingerprint: { tagName: 'button', text: 'Download' }
  }, { itemTag: 'tr' });
  assert.strictEqual(targetXpath.candidates.length, 1);
  assert.strictEqual(targetXpath.candidates[0].value, './/button[@title="Download"]');
  assert.strictEqual(targetXpath.candidates[0].strategy, 'xpath');
  console.log('  ✅ Relative XPath generalization passed\n');

  console.log('🔹 Test 7: In-row button with standalone ID is item-scoped and generalized');
  const inRowAction = {
    type: 'CLICK',
    target: {
      candidates: [{ strategy: 'css-path', value: '#download-btn-row-2' }],
      fingerprint: { tagName: 'button', text: 'Download', id: 'download-btn-row-2' }
    }
  };
  assert.strictEqual(ActionGeneralizer.isItemRelative(inRowAction, { itemTag: 'tr' }), true);
  const genInRow = ActionGeneralizer.generalizeAction(inRowAction, { itemTag: 'tr' });
  assert.strictEqual(genInRow.scope, 'item');
  assert.strictEqual(genInRow.target.candidates[0].value, '[id*="download-btn"]');
  console.log('  ✅ Standalone row-indexed ID generalization passed\n');

  console.log('🔹 Test 8: In-row button with static ID is scoped to item');
  const staticIdAction = {
    type: 'CLICK',
    isDownload: true,
    target: {
      candidates: [{ strategy: 'css-path', value: '#download-btn' }],
      fingerprint: { tagName: 'button', text: 'Download', id: 'download-btn', parentTag: 'td' }
    }
  };
  assert.strictEqual(ActionGeneralizer.isItemRelative(staticIdAction, { itemTag: 'tr' }), true);
  const genStatic = ActionGeneralizer.generalizeAction(staticIdAction, { itemTag: 'tr' });
  assert.strictEqual(genStatic.scope, 'item');
  assert.strictEqual(genStatic.target.candidates[0].value, '[id="download-btn"]');
  console.log('  ✅ In-row static ID item-scoping passed\n');

  console.log('🔹 Test 9: Table header download button in <th> is page-scoped, not item-scoped');
  const headerDownloadAction = {
    type: 'CLICK',
    name: 'Download Button',
    isDownload: true,
    target: {
      candidates: [
        { strategy: 'css-path', value: 'table thead th.mat-column-select button.mat-icon-button' },
        { strategy: 'xpath', value: '//table//thead//th[contains(@class,"mat-column-select")]//button' }
      ],
      fingerprint: {
        tagName: 'button',
        parentTag: 'th',
        role: 'button',
        className: 'mat-focus-indicator mat-icon-button'
      }
    }
  };
  const isHeaderRelative = ActionGeneralizer.isItemRelative(headerDownloadAction, { itemTag: 'tr' });
  assert.strictEqual(isHeaderRelative, false, 'Header download button must NOT be item-relative');
  const genHeader = ActionGeneralizer.generalizeAction(headerDownloadAction, { itemTag: 'tr' });
  assert.strictEqual(genHeader.scope, 'page', 'Header download button must be page-scoped');
  console.log('  ✅ Table header download button page-scoping passed\n');

  console.log('🎉 ALL ACTION GENERALIZER TESTS PASSED SUCCESSFULLY!\n');
}

run();
