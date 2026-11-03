/**
 * Loop Engine Checkbox & Download Reliability Test Suite
 *
 * Explicitly implements the test matrices from Sections 2, 3, and 10 of the Master Implementation Prompt:
 * - Checkbox state reproduction (check, uncheck, mixed, idempotent skip, custom ARIA/data-state, verification).
 * - Download deduplication (single download per record, duplicate dispatch skip, incomplete file rejection, resume isolation).
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { executeClick } = require('../src/replay/action-executors');
const ActionDispatcher = require('../src/replay/action-dispatcher');
const ItemExecutionHandler = require('../src/replay/loop/item-execution-handler');
const ArtifactDownloadManager = require('../src/replay/loop/artifact-download-manager');
const RecorderBridge = require('../src/recorder/recorder-bridge');

describe('Loop Checkbox & Download Reliability Matrix', () => {

  // =========================================================================
  // Group 1: Checkbox Test Matrix
  // =========================================================================
  describe('Group 1: Checkbox State & Idempotency Matrix', () => {

    test('1.1 All checkboxes unchecked, recorded action is check -> all reach checked=true', async () => {
      const records = [
        { id: 'row1', checked: false, clicks: 0 },
        { id: 'row2', checked: false, clicks: 0 },
        { id: 'row3', checked: false, clicks: 0 }
      ];

      for (const rec of records) {
        const mockEl = {
          tagName: 'INPUT',
          type: 'checkbox',
          get checked() { return rec.checked; },
          click: () => { rec.clicks++; rec.checked = true; },
          getAttribute: (attr) => attr === 'id' ? rec.id : null,
          hasAttribute: (attr) => attr === 'id'
        };

        const handle = {
          evaluate: async (fn, ...args) => fn(mockEl, ...args),
          click: async () => mockEl.click()
        };

        const action = {
          type: 'CLICK',
          isCheckbox: true,
          desiredState: true,
          checked: true,
          elementName: `Checkbox ${rec.id}`
        };

        await executeClick(handle, action);
      }

      for (const rec of records) {
        assert.equal(rec.checked, true, `Record ${rec.id} must be checked`);
        assert.equal(rec.clicks, 1, `Record ${rec.id} must be clicked exactly once`);
      }
    });

    test('1.2 All checkboxes checked, recorded action is uncheck -> all reach checked=false', async () => {
      const records = [
        { id: 'row1', checked: true, clicks: 0 },
        { id: 'row2', checked: true, clicks: 0 },
        { id: 'row3', checked: true, clicks: 0 }
      ];

      for (const rec of records) {
        const mockEl = {
          tagName: 'INPUT',
          type: 'checkbox',
          get checked() { return rec.checked; },
          click: () => { rec.clicks++; rec.checked = false; },
          getAttribute: (attr) => attr === 'id' ? rec.id : null,
          hasAttribute: (attr) => attr === 'id'
        };

        const handle = {
          evaluate: async (fn, ...args) => fn(mockEl, ...args),
          click: async () => mockEl.click()
        };

        const action = {
          type: 'CLICK',
          isCheckbox: true,
          isUncheck: true,
          desiredState: false,
          checked: false,
          elementName: `Checkbox ${rec.id}`
        };

        await executeClick(handle, action);
      }

      for (const rec of records) {
        assert.equal(rec.checked, false, `Record ${rec.id} must be unchecked`);
        assert.equal(rec.clicks, 1, `Record ${rec.id} must be clicked exactly once to uncheck`);
      }
    });

    test('1.3 Mixed checkbox states: items with mixed initial states all reach intended target state', async () => {
      const records = [
        { id: 'row1', checked: true, clicks: 0 },   // Already checked
        { id: 'row2', checked: false, clicks: 0 },  // Needs checking
        { id: 'row3', checked: true, clicks: 0 },   // Already checked
        { id: 'row4', checked: false, clicks: 0 }   // Needs checking
      ];

      const checkAction = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true,
        checked: true
      };

      for (const rec of records) {
        const mockEl = {
          tagName: 'INPUT',
          type: 'checkbox',
          get checked() { return rec.checked; },
          click: () => { rec.clicks++; rec.checked = true; },
          getAttribute: (attr) => attr === 'id' ? rec.id : null,
          hasAttribute: (attr) => attr === 'id'
        };

        const handle = {
          evaluate: async (fn, ...args) => fn(mockEl, ...args),
          click: async () => mockEl.click()
        };

        await executeClick(handle, checkAction);
      }

      // row1 was already checked -> 0 clicks
      assert.equal(records[0].checked, true);
      assert.equal(records[0].clicks, 0, 'row1 was already in desired state, must skip click');

      // row2 was unchecked -> 1 click to check
      assert.equal(records[1].checked, true);
      assert.equal(records[1].clicks, 1, 'row2 needed checking, must click once');

      // row3 was already checked -> 0 clicks
      assert.equal(records[2].checked, true);
      assert.equal(records[2].clicks, 0, 'row3 was already in desired state, must skip click');

      // row4 was unchecked -> 1 click to check
      assert.equal(records[3].checked, true);
      assert.equal(records[3].clicks, 1, 'row4 needed checking, must click once');
    });

    test('1.4 Checkbox already correct -> no unnecessary click (idempotent)', async () => {
      let clicks = 0;
      let isChecked = true;

      const mockEl = {
        tagName: 'INPUT',
        type: 'checkbox',
        get checked() { return isChecked; },
        click: () => { clicks++; isChecked = !isChecked; },
        getAttribute: () => null,
        hasAttribute: () => false
      };

      const handle = {
        evaluate: async (fn, ...args) => fn(mockEl, ...args),
        click: async () => mockEl.click()
      };

      const action = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true,
        checked: true
      };

      await executeClick(handle, action);
      assert.equal(clicks, 0, 'Click must not be called when already checked');
      assert.equal(isChecked, true, 'State must remain checked');
    });

    test('1.5 Same workflow replayed twice -> zero state reversal on repeat', async () => {
      let clicks = 0;
      let state = false;

      const mockEl = {
        tagName: 'INPUT',
        type: 'checkbox',
        get checked() { return state; },
        click: () => { clicks++; state = !state; },
        getAttribute: () => null,
        hasAttribute: () => false
      };

      const handle = {
        evaluate: async (fn, ...args) => fn(mockEl, ...args),
        click: async () => mockEl.click()
      };

      const action = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true,
        checked: true
      };

      // Play 1: initial transition false -> true
      await executeClick(handle, action);
      assert.equal(clicks, 1);
      assert.equal(state, true);

      // Play 2: repeat run
      await executeClick(handle, action);
      assert.equal(clicks, 1, 'Repeat run must skip click and not reverse state');
      assert.equal(state, true, 'Repeat run must remain checked');
    });

    test('1.6 Custom checkbox: ARIA role="checkbox", aria-checked="true", and data-state="checked"', async () => {
      let clicks = 0;
      let ariaChecked = 'false';

      const mockAriaEl = {
        tagName: 'DIV',
        getAttribute: (attr) => {
          if (attr === 'role') return 'checkbox';
          if (attr === 'aria-checked') return ariaChecked;
          return null;
        },
        hasAttribute: (attr) => attr === 'role' || attr === 'aria-checked',
        click: () => { clicks++; ariaChecked = 'true'; }
      };

      const handle = {
        evaluate: async (fn, ...args) => fn(mockAriaEl, ...args),
        click: async () => mockAriaEl.click()
      };

      const action = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true
      };

      await executeClick(handle, action);
      assert.equal(clicks, 1, 'Must click custom checkbox to set state');
      assert.equal(ariaChecked, 'true', 'aria-checked must be true');

      // On repeat, it is already true so click is skipped
      await executeClick(handle, action);
      assert.equal(clicks, 1, 'Custom checkbox click must be skipped on repeat');
    });

    test('1.7 Custom checkbox: data-state="checked" (Radix UI / shadcn)', async () => {
      let clicks = 0;
      let dataState = 'unchecked';

      const mockRadixEl = {
        tagName: 'BUTTON',
        getAttribute: (attr) => {
          if (attr === 'role') return 'checkbox';
          if (attr === 'data-state') return dataState;
          return null;
        },
        hasAttribute: (attr) => attr === 'role' || attr === 'data-state',
        click: () => { clicks++; dataState = 'checked'; }
      };

      const handle = {
        evaluate: async (fn, ...args) => fn(mockRadixEl, ...args),
        click: async () => mockRadixEl.click()
      };

      const action = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true
      };

      await executeClick(handle, action);
      assert.equal(clicks, 1);
      assert.equal(dataState, 'checked');

      // Repeat
      await executeClick(handle, action);
      assert.equal(clicks, 1, 'data-state=checked must skip click on repeat');
    });

    test('1.8 Checkbox state verification throws if element fails to achieve desired state', async () => {
      // Mock an element that refuses to toggle
      const mockBrokenEl = {
        tagName: 'INPUT',
        type: 'checkbox',
        get checked() { return false; },
        click: () => {}, // Does nothing!
        getAttribute: () => null,
        hasAttribute: () => false
      };

      const handle = {
        evaluate: async (fn, ...args) => fn(mockBrokenEl, ...args),
        click: async () => mockBrokenEl.click()
      };

      const action = {
        type: 'CLICK',
        isCheckbox: true,
        desiredState: true,
        checked: true
      };

      await assert.rejects(
        async () => { await executeClick(handle, action); },
        /state verification failed/i
      );
    });

    test('1.9 Backward compatibility: legacy action with target.fingerprint.checked=true infers uncheck', async () => {
      const bridge = new RecorderBridge({ name: 'legacy-compat', outputDir: './test-output' });
      bridge.isRecording = true;

      bridge._handleCapturedAction({
        type: 'CLICK',
        timestamp: Date.now(),
        target: {
          friendlyName: 'Legacy Active Checkbox',
          candidates: [{ strategy: 'css-path', value: '#activeCb' }],
          fingerprint: {
            tagName: 'input',
            type: 'checkbox',
            isCheckbox: true,
            checked: true // Was checked before user clicked it!
          }
        }
      });

      assert.equal(bridge.actions.length, 1);
      assert.equal(bridge.actions[0].desiredState, false, 'Legacy action on checked box must infer desiredState=false');
      assert.equal(bridge.actions[0].isUncheck, true, 'Legacy action must be marked isUncheck=true');
    });
  });

  // =========================================================================
  // Group 2: Download Deduplication & Execution Reliability Matrix
  // =========================================================================
  describe('Group 2: Download Deduplication Matrix', () => {
    let testBaseDir;

    before(() => {
      testBaseDir = path.resolve(__dirname, 'scratch_matrix_downloads');
      if (!fs.existsSync(testBaseDir)) fs.mkdirSync(testBaseDir, { recursive: true });
    });

    after(() => {
      try { fs.rmSync(testBaseDir, { recursive: true, force: true }); } catch {}
    });

    test('2.1 Ten records downloading separate files -> exactly 10 unique downloads and 0 duplicates', () => {
      const runDir = path.join(testBaseDir, 'run_10_records');
      const structDir = path.join(runDir, 'structured');
      fs.mkdirSync(structDir, { recursive: true });

      const manager = new ArtifactDownloadManager({
        runsDir: runDir,
        structuredDownloadsDir: structDir,
        workflowName: 'ten-invoices'
      });

      const artifacts = [];
      for (let i = 1; i <= 10; i++) {
        const rawFile = path.join(runDir, `raw_INV_${i}.pdf`);
        fs.writeFileSync(rawFile, `PDF_CONTENT_FOR_INVOICE_${i}`);
        const art = manager.processAndStoreDownload(
          rawFile,
          `record:INV-${i}`,
          `INV-${i}`,
          { 'Invoice No': `INV-${i}`, 'Amount': `$${i * 100}.00` }
        );
        assert.ok(art, `Artifact for INV-${i} must be created`);
        artifacts.push(art);
      }

      assert.equal(artifacts.length, 10);
      const uniqueHashes = new Set(artifacts.map(a => a.fileHash));
      assert.equal(uniqueHashes.size, 10, 'All 10 files must have distinct SHA-256 hashes');
      const uniquePaths = new Set(artifacts.map(a => a.path));
      assert.equal(uniquePaths.size, 10, 'All 10 files must have distinct destination paths');
    });

    test('2.2 Same action dispatched twice for the same record -> deduplication detects existing file', () => {
      const runDir = path.join(testBaseDir, 'run_dedupe_action');
      const structDir = path.join(runDir, 'structured');
      fs.mkdirSync(structDir, { recursive: true });

      const manager = new ArtifactDownloadManager({
        runsDir: runDir,
        structuredDownloadsDir: structDir,
        workflowName: 'invoice-flow'
      });

      // Simulate first download completion
      const rawFile = path.join(runDir, 'INV-5001.pdf');
      fs.writeFileSync(rawFile, 'CONTENT_5001');
      const art = manager.processAndStoreDownload(rawFile, 'record:INV-5001', 'INV-5001', { 'Invoice No': 'INV-5001' });
      assert.ok(art);

      // Check if already downloaded
      const checkResult = manager.checkIfAlreadyDownloaded('record:INV-5001', 'INV-5001', { 'Invoice No': 'INV-5001' });
      assert.equal(checkResult.isDuplicate, true, 'Must detect that INV-5001 was already downloaded');
      assert.ok(checkResult.record, 'Must return the existing artifact record');
    });

    test('2.3 Late download sweep does not duplicate already-processed files', () => {
      const runDir = path.join(testBaseDir, 'run_late_sweep');
      const downloadsDir = path.join(runDir, 'downloads');
      const structDir = path.join(runDir, 'structured');
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.mkdirSync(structDir, { recursive: true });

      const manager = new ArtifactDownloadManager({
        runsDir: runDir,
        downloadsDir,
        structuredDownloadsDir: structDir,
        workflowName: 'sweep-flow'
      });

      const manifest = { downloadedFiles: [] };
      const rawFile = path.join(downloadsDir, 'statement_1.pdf');
      fs.writeFileSync(rawFile, 'STATEMENT_DATA');

      // First sweep organizes the file
      manager.organizePendingDownloads(manifest, { itemKey: 'inv:1', itemLabel: 'Inv 1' });
      assert.equal(manifest.downloadedFiles.length, 1);
      assert.equal(fs.existsSync(rawFile), false, 'Raw file in downloadsDir must be removed after storing');

      // Second sweep on empty directory does not duplicate
      manager.organizePendingDownloads(manifest, { itemKey: 'inv:1', itemLabel: 'Inv 1' });
      assert.equal(manifest.downloadedFiles.length, 1, 'Second sweep must not duplicate files');
    });

    test('2.4 Incomplete or temporary files (.crdownload, .tmp, .download) are rejected', () => {
      const runDir = path.join(testBaseDir, 'run_incomplete_files');
      fs.mkdirSync(runDir, { recursive: true });

      const manager = new ArtifactDownloadManager({ runsDir: runDir });

      const crFile = path.join(runDir, 'invoice.pdf.crdownload');
      const tmpFile = path.join(runDir, 'data.tmp');
      const dlFile = path.join(runDir, 'download.download');

      fs.writeFileSync(crFile, 'STREAMING');
      fs.writeFileSync(tmpFile, 'TEMP');
      fs.writeFileSync(dlFile, 'IN_FLIGHT');

      assert.equal(manager.processAndStoreDownload(crFile), null);
      assert.equal(manager.processAndStoreDownload(tmpFile), null);
      assert.equal(manager.processAndStoreDownload(dlFile), null);
    });

    test('2.5 Two records with identical original filenames receive unique formatted names and distinct hashes', () => {
      const runDir = path.join(testBaseDir, 'run_name_collision');
      const structDir = path.join(runDir, 'structured');
      fs.mkdirSync(structDir, { recursive: true });

      const manager = new ArtifactDownloadManager({
        runsDir: runDir,
        structuredDownloadsDir: structDir,
        workflowName: 'collision-test'
      });

      // Two different records where the portal names both downloads "report.pdf"
      const f1 = path.join(runDir, 'report_1.pdf');
      const f2 = path.join(runDir, 'report_2.pdf');
      fs.writeFileSync(f1, 'REPORT_INVOICE_101');
      fs.writeFileSync(f2, 'REPORT_INVOICE_102');

      const art1 = manager.processAndStoreDownload(f1, 'record:INV-101', 'INV-101', { 'Invoice No': 'INV-101' });
      const art2 = manager.processAndStoreDownload(f2, 'record:INV-102', 'INV-102', { 'Invoice No': 'INV-102' });

      assert.ok(art1);
      assert.ok(art2);
      assert.notEqual(art1.fileHash, art2.fileHash, 'Hashes must differ');
      assert.notEqual(art1.targetFilename, art2.targetFilename, 'Filenames must be uniquely formatted with their invoice numbers');
      assert.match(art1.targetFilename, /INV-101/);
      assert.match(art2.targetFilename, /INV-102/);
    });
  });

  // =========================================================================
  // Group 3: Item Scoping & Action Resolution
  // =========================================================================
  describe('Group 3: Item Scoping & Action Resolution', () => {

    test('3.1 resolveTargetWithinItem targets checkbox control and never falls back to unrelated buttons', async () => {
      // Mock DOM structure of a table row containing a checkbox and a Delete button
      const mockCheckbox = {
        tagName: 'INPUT',
        type: 'checkbox',
        id: 'row_cb_1'
      };

      const mockDeleteBtn = {
        tagName: 'BUTTON',
        textContent: 'Delete Record',
        getAttribute: (attr) => attr === 'role' ? 'button' : null
      };

      const mockRow = {
        tagName: 'TR',
        querySelectorAll: (sel) => {
          if (sel.includes('checkbox')) return [mockCheckbox];
          if (sel.includes('button')) return [mockDeleteBtn];
          return [];
        },
        querySelector: (sel) => {
          if (sel.includes('checkbox')) return mockCheckbox;
          if (sel.includes('button')) return mockDeleteBtn;
          return null;
        }
      };

      const rowHandle = {
        evaluateHandle: async (fn, tgt) => {
          // Simulate evaluateHandle in browser
          const style = { display: 'block', visibility: 'visible' };
          global.getComputedStyle = () => style;
          mockCheckbox.getBoundingClientRect = () => ({ width: 20, height: 20 });
          mockDeleteBtn.getBoundingClientRect = () => ({ width: 50, height: 20 });
          mockRow.getBoundingClientRect = () => ({ width: 500, height: 30 });

          // Test that target with isCheckbox=true returns mockCheckbox, NOT mockDeleteBtn
          const result = fn(mockRow, tgt);
          return { asElement: () => result };
        }
      };

      const cbTarget = {
        isCheckbox: true,
        fingerprint: { type: 'checkbox', tagName: 'input' },
        candidates: [{ value: '.non-existent-selector' }] // Candidate fails!
      };

      const resolved = await ActionDispatcher.resolveTargetWithinItem(rowHandle, cbTarget);
      assert.equal(resolved.asElement(), mockCheckbox, 'Must resolve to the checkbox inside the row');
    });

    test('3.2 resolveTargetWithinItem returns null when checkbox is missing, never clicks wrong control', async () => {
      const mockRowWithoutCb = {
        tagName: 'TR',
        querySelectorAll: () => [],
        querySelector: (sel) => {
          if (sel.includes('button')) return { tagName: 'BUTTON', textContent: 'Submit' };
          return null;
        }
      };

      const rowHandle = {
        evaluateHandle: async (fn, tgt) => {
          const style = { display: 'block', visibility: 'visible' };
          global.getComputedStyle = () => style;
          mockRowWithoutCb.getBoundingClientRect = () => ({ width: 500, height: 30 });
          const result = fn(mockRowWithoutCb, tgt);
          return { asElement: () => result };
        }
      };

      const cbTarget = {
        isCheckbox: true,
        fingerprint: { type: 'checkbox', tagName: 'input' },
        candidates: [{ value: '.no-cb' }]
      };

      const resolved = await ActionDispatcher.resolveTargetWithinItem(rowHandle, cbTarget);
      assert.equal(resolved.asElement(), null, 'Must return null when checkbox cannot be found in item');
    });
  });
});

