/**
 * src/replay/loop/item-execution-handler.js
 * Manages item identification, field extraction, filter condition evaluation,
 * and individual item attempt execution with retry backoffs and state recovery.
 */

const fs = require('fs');
const path = require('path');
const ItemDiscovery = require('../../shared/item-discovery');
const LoopDetector = require('../../shared/loop-detector');
const ActionGeneralizer = require('../../shared/action-generalizer');
const { ConditionEvaluator } = require('../../shared/condition-evaluator');
const { isLoginAction, detectLoginSequence, isSessionAuthenticated } = require('../../shared/auth-detector');
const { evaluateItemFilter: sharedEvaluateItemFilter, evaluateFilterPreview } = require('../../shared/item-filter');
const logger = require('../../utils/logger');

function _createCellParser() {
  const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;
  const DOCUMENT_ID_REGEX = /\b((?:SI|INV|DR|TX|CM|PO|SO|BILL|REC|ORD)-\d+(?:[-_]\w+)*|\b\d{4,10}\b)/i;

  const cleanCellText = (val) => {
    if (val == null) return '';
    let s = String(val).trim().replace(/\s+/g, ' ');
    if (EXPANDER_GLYPH_REGEX.test(s)) return '';
    s = s.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
    s = s.replace(/[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/, '').trim();
    return s;
  };

  const isControlOrExpanderCell = (cellEl) => {
    if (!cellEl || typeof cellEl !== 'object') return false;
    if (
      cellEl.classList?.contains('x-grid-cell-special') ||
      cellEl.classList?.contains('x-grid-cell-row-checker') ||
      cellEl.classList?.contains('x-selmodel-column') ||
      cellEl.classList?.contains('ant-table-selection-column') ||
      cellEl.classList?.contains('mat-column-select') ||
      (typeof cellEl.querySelector === 'function' && cellEl.querySelector(
        '.x-grid-row-checker, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], .mat-pseudo-checkbox'
      ))
    ) {
      return true;
    }
    if (
      cellEl.classList?.contains('x-grid-row-expander') ||
      cellEl.classList?.contains('ant-table-row-expand-icon') ||
      cellEl.classList?.contains('dt-control') ||
      cellEl.classList?.contains('details-control') ||
      cellEl.classList?.contains('tree-node-toggle') ||
      cellEl.classList?.contains('expander') ||
      cellEl.classList?.contains('expand-btn') ||
      cellEl.classList?.contains('mat-expansion-indicator') ||
      (typeof cellEl.querySelector === 'function' && cellEl.querySelector(
        'button[aria-expanded], [aria-expanded], .expander, .expand-btn, [class*="chevron" i], [class*="expander" i], [class*="tree-toggle" i], [class*="dt-control" i]'
      ))
    ) {
      return true;
    }
    const raw = (cellEl.innerText || cellEl.textContent || '').trim();
    if (raw && EXPANDER_GLYPH_REGEX.test(raw) && raw.length <= 4) {
      return true;
    }
    return false;
  };

  return { EXPANDER_GLYPH_REGEX, DOCUMENT_ID_REGEX, cleanCellText, isControlOrExpanderCell };
}

const CELL_PARSER_SRC = _createCellParser.toString();

class ItemExecutionHandler {
  constructor(options = {}) {
    this.maxItemRetries = Number.isInteger(options.maxItemRetries) ? Math.max(0, options.maxItemRetries) : 1;
    this.gridAdapter = options.gridAdapter || null;
    this.downloadManager = options.downloadManager || null;
    this.stateCoordinator = options.stateCoordinator || null;
    this.replayEngine = options.replayEngine || null;
    this.getIsAborted = options.getIsAborted || (() => false);
    this.downloadTimeoutMs = Number.isInteger(options.downloadTimeoutMs)
      ? options.downloadTimeoutMs
      : (Number.isInteger(options.downloadWaitMs) ? options.downloadWaitMs : 12000);
    this.defaultClickWaitMs = Number.isInteger(options.defaultClickWaitMs)
      ? options.defaultClickWaitMs
      : 2500;
  }

  /**
   * Preserves and restores the collection view between loop items.
   * Guarantees:
   * 1. If collection is already present (same-page actions, direct in-row download), does not navigate or reload.
   * 2. If detail-page navigation occurred, safely returns via history.back() or direct collection URL.
   * 3. NEVER navigates to Home, and NEVER re-executes setup steps from step 0.
   * 4. Waits for collection DOM container to settle with polling before continuing.
   *
   * @param {object} params
   * @param {object} params.page - Puppeteer Page
   * @param {object} params.discovery - ItemDiscovery result object
   * @param {string} [params.collectionUrl] - The authoritative collection URL captured after setup
   * @param {object} [params.runner] - LoopReplayRunner instance
   * @returns {Promise<{ restored: boolean, method: string, reason?: string }>}
   */
  async restoreCollectionContext({ page, discovery, collectionUrl, runner }) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return { restored: false, reason: 'Page closed' };
    }

    const replayEngine = runner?.replayEngine || this.replayEngine;
    if (replayEngine) {
      await replayEngine.dismissOverlays().catch(() => {});
      if (typeof replayEngine._waitForLoadingMasks === 'function') {
        await replayEngine._waitForLoadingMasks(2500).catch(() => {});
      }
    } else if (page.keyboard) {
      await page.keyboard.press('Escape').catch(() => {});
    }

    const checkPresence = async () => {
      if (runner && typeof runner.isCollectionPresent === 'function') {
        return runner.isCollectionPresent(page, discovery);
      }
      return this.gridAdapter ? this.gridAdapter.isCollectionPresent(page, discovery) : true;
    };

    const waitForPresence = async (timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await checkPresence()) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    };

    // 1. Same-page check: Is the collection already present in the active DOM?
    if (await checkPresence()) {
      return { restored: true, method: 'already_present' };
    }

    // 2. Allow brief settle time in case table is rendering/updating
    if (await waitForPresence(1200)) {
      return { restored: true, method: 'settled' };
    }

    // 3. Detail-page navigation handling: URL changed or detail view opened
    const currentUrl = page.url() || '';
    const isDifferentUrl = collectionUrl && currentUrl !== collectionUrl;

    if (isDifferentUrl && typeof page.goBack === 'function') {
      try {
        logger.info(`[Loop Runner] Detail page navigation detected ("${currentUrl}" !== "${collectionUrl}"). Restoring collection view via history.back...`);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (replayEngine && typeof replayEngine.dismissOverlays === 'function') {
          await replayEngine.dismissOverlays().catch(() => {});
        }
        if (await waitForPresence(3500)) {
          logger.info(`[Loop Runner] Successfully restored collection view via browser back navigation.`);
          return { restored: true, method: 'history_back' };
        }
      } catch (backErr) {
        logger.warn(`[Loop Runner] History back navigation note: ${backErr.message}`);
      }
    }

    // 4. Direct navigation to collectionUrl (preserves query params & filters)
    if (collectionUrl) {
      try {
        const targetNavUrl = collectionUrl;
        const nowUrl = page.url() || '';
        if (nowUrl !== targetNavUrl) {
          logger.info(`[Loop Runner] Restoring collection view by navigating to collection URL: ${targetNavUrl}`);
          await page.goto(targetNavUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          if (replayEngine && typeof replayEngine.dismissOverlays === 'function') {
            await replayEngine.dismissOverlays().catch(() => {});
          }
          if (await waitForPresence(4000)) {
            logger.info(`[Loop Runner] Successfully restored collection view at collection URL.`);
            return { restored: true, method: 'collection_url' };
          }
        }
      } catch (gotoErr) {
        logger.warn(`[Loop Runner] Direct collection URL navigation note: ${gotoErr.message}`);
      }
    }

    // 5. Final check
    const finalPresence = await checkPresence();
    if (finalPresence) {
      return { restored: true, method: 'eventual_presence' };
    }

    // Never navigate to Home, and never re-execute setupSteps!
    return {
      restored: false,
      reason: `Collection container not found at ${collectionUrl || currentUrl}. Stopped safely to avoid restarting workflow.`
    };
  }

  /**
   * Determine whether an action can potentially initiate a download.
   * Recognizes explicit keywords, document/action column context, and unlabeled icon buttons.
   */
  static isDownloadPotentialAction(action, targetItem = null) {
    if (!action) return false;
    if (action.isDownload === true) return true;

    const fp = action.target?.fingerprint || {};
    const fpTag = String(fp.tagName || '').toLowerCase();
    const fpRole = String(fp.role || '').toLowerCase();
    const text = String(fp.text || action.text || '').trim();
    const title = String(fp.attributes?.title || action.target?.title || '').trim();
    const href = String(fp.attributes?.href || action.target?.href || '').trim();
    const name = String(action.name || action.elementName || '').trim();
    const candidates = Array.isArray(action.target?.candidates) ? action.target.candidates : [];

    const DL_KEYWORD_REGEX = /download|export|save|pdf|print|file|statement|invoice/i;

    // 1. Text, attribute, or selector keyword match
    if (
      candidates.some(c => c && c.value && DL_KEYWORD_REGEX.test(c.value)) ||
      DL_KEYWORD_REGEX.test(title) ||
      DL_KEYWORD_REGEX.test(href) ||
      DL_KEYWORD_REGEX.test(text) ||
      DL_KEYWORD_REGEX.test(name)
    ) {
      return true;
    }

    // 2. Target table column indicates download or document action
    const targetCol = targetItem?.targetColumn || action.context?.table?.activeColumn;
    if (targetCol && /download|export|save|pdf|print|file|statement|invoice|action/i.test(targetCol)) {
      return true;
    }

    // 3. Button or link element with unlabeled icon / glyph / empty text (classic icon download button)
    const isButtonOrLink = fpTag === 'button' || fpTag === 'a' || fpRole === 'button' ||
      candidates.some(c => c && c.value && /\b(button|btn|icon|action)\b/i.test(c.value));
    const isUnlabeledOrIcon = !text || text.length <= 3 || /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/.test(text);

    if (isButtonOrLink && isUnlabeledOrIcon) {
      return true;
    }

    return false;
  }

  /**
   * Extracts a unique identifier and human-readable label from a loop item
   */
  async extractItemIdentifier(page, discovery, index, isDropdown = false) {
    if (isDropdown) {
      const optText = await page.evaluate((idx) => {
        const opts = Array.from(document.querySelectorAll('mat-option, [role="option"], select option'));
        const el = opts[idx];
        return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : null;
      }, index).catch(() => null);
      const label = optText || `Option #${index + 1}`;
      return { itemKey: `dropdown:${label}`, itemLabel: label };
    }

    // Check pre-discovered item fields first
    if (discovery && Array.isArray(discovery.items) && discovery.items[index]?.fields) {
      const fields = discovery.items[index].fields;
      const invNo = fields['Invoice Number'] || fields['Invoice No'] || fields['Invoice'];
      if (invNo) {
        const label = fields.Type ? `${invNo} (${fields.Type})` : invNo;
        return { itemKey: `invoice:${invNo}`, itemLabel: label, invoiceNumber: invNo };
      }
    }

    let itemHandle = null;
    try {
      itemHandle = await ItemDiscovery.getItemHandle(page, discovery, index);
      const itemEl = itemHandle ? itemHandle.asElement() : null;
      if (itemEl) {
        const info = await itemEl.evaluate(el => {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          const firstLine = text.split(/[\n\r]/)[0].trim();
          const link = el.querySelector('a[href]')?.getAttribute('href') || el.getAttribute('href') || '';
          const dataId = el.getAttribute('data-id') || el.getAttribute('data-testid') || el.getAttribute('id') || '';
          const invMatch = text.match(/\b((?:SI|INV|DR|TX|CM)-\d+(?:[-_]\w+)*|\b\d{5,10}\b)/i);
          return {
            text: firstLine ? firstLine.slice(0, 100) : text.slice(0, 100),
            link,
            dataId,
            invoiceNo: invMatch ? invMatch[1] : null
          };
        });

        const invoiceNo = info.invoiceNo;
        const label = invoiceNo || info.text || info.dataId || `Item #${index + 1}`;
        const key = invoiceNo
          ? `invoice:${invoiceNo}`
          : (info.dataId
            ? `id:${info.dataId}`
            : (info.link ? `link:${info.link}` : `text:${label}`));
        return { itemKey: key, itemLabel: label, invoiceNumber: invoiceNo };
      }
    } catch (err) {
      logger.warn(`[ItemExecutionHandler] Note extracting item identifier for item #${index + 1}: ${err.message}`);
    } finally {
      if (itemHandle) await itemHandle.dispose().catch(() => { });
    }

    return { itemKey: `item_${index + 1}`, itemLabel: `Item #${index + 1}` };
  }

  /**
   * Extracts fields from all discovered items in the collection using the browser DOM.
   * Pure and deterministic extraction of headers and cell values.
   */
  static async extractDiscoveredItems(page, discovery) {
    if (!page || !discovery || !discovery.collection) {
      return (discovery?.items || []).map((it, idx) => ({
        index: it.index !== undefined ? it.index : idx,
        label: it.text || `Item #${idx + 1}`,
        text: it.text || '',
        fields: it.fields || {}
      }));
    }

    try {
      const itemsWithFields = await page.evaluate(({ collection, items, cellParserSrc }) => {
        const visible = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            rect.width > 0 && rect.height > 0;
        };

        const structuralSignature = (el) => {
          const children = Array.from(el.children).slice(0, 12)
            .map(child => child.tagName.toLowerCase()).join('>');
          return [
            el.tagName.toLowerCase(),
            children,
            el.getAttribute('role') || '',
            (el.getAttribute('data-testid') || '').replace(/\d+/g, '#').replace(/[0-9a-f]{8,}/gi, '#'),
            (el.getAttribute('data-qa') || '').replace(/\d+/g, '#').replace(/[0-9a-f]{8,}/gi, '#')
          ].join('|');
        };

        let ancestors = [];
        if (collection.ancestorSelector) {
          try {
            ancestors = Array.from(document.querySelectorAll(collection.ancestorSelector)).filter(visible);
          } catch {}
        }
        if (!ancestors.length && collection.ancestorTag) {
          ancestors = Array.from(document.querySelectorAll(collection.ancestorTag)).filter(visible);
        }

        let domElements = [];
        for (const ancestor of ancestors) {
          const exact = Array.from(ancestor.children).filter(child =>
            visible(child) &&
            child.tagName.toLowerCase() === collection.itemTag &&
            structuralSignature(child) === collection.itemSignature
          );
          if (exact.length > 0) {
            domElements = exact;
            break;
          }
          const compat = Array.from(ancestor.children).filter(child =>
            visible(child) && child.tagName.toLowerCase() === collection.itemTag
          );
          if (compat.length > 0) {
            domElements = compat;
            break;
          }
        }

        const { EXPANDER_GLYPH_REGEX, DOCUMENT_ID_REGEX, cleanCellText, isControlOrExpanderCell } =
          typeof _createCellParser === 'function'
            ? _createCellParser()
            : (new Function('return (' + cellParserSrc + ')()'))();

        function extractFieldsFromElement(el) {
          const fields = {};
          if (!el) return fields;

          let rawHeaderLayout = [];
          let headers = Array.isArray(collection.headerColumns) && collection.headerColumns.length > 0
            ? collection.headerColumns
            : [];

          const gridContainer = (typeof el.parentElement?.closest === 'function' ? el.parentElement.closest('.x-grid, [role="grid"], [role="treegrid"], .dxgvTable, table, .data-table, .grid-container') : null) ||
            (typeof el.closest === 'function' ? el.closest('.x-grid, [role="grid"], [role="treegrid"], .dxgvTable, table') : null) ||
            document.querySelector('.x-grid, table, [role="grid"]');

          if (gridContainer) {
            const headerCt = (typeof gridContainer.querySelector === 'function' ? gridContainer.querySelector('.x-grid-header-ct, thead, .x-grid-header-row, [role="rowgroup"], .ag-header, .mat-header-row') : null) || gridContainer;
            const headerEls = Array.from(typeof headerCt.querySelectorAll === 'function' ? headerCt.querySelectorAll('.x-column-header-text, .x-column-header, th, [role="columnheader"], .dxgvHeader, .mat-header-cell, .ag-header-cell, .ant-table-thead th') : [])
              .filter(visible);
            if (headerEls.length > 0) {
              rawHeaderLayout = headerEls.map(h => {
                const inner = (typeof h.querySelector === 'function' ? h.querySelector('.x-column-header-text, .ag-header-cell-text') : null) || h;
                return cleanCellText(inner.innerText || inner.textContent || inner.getAttribute('aria-label') || '');
              });
              const extractedCols = rawHeaderLayout.filter(t => t.length > 0 && t.length < 60 && !EXPANDER_GLYPH_REGEX.test(t));
              if (extractedCols.length > 0 && !headers.length) {
                headers = Array.from(new Set(extractedCols));
              }
            }
          }

          let cellEls = [];
          if (typeof el.querySelectorAll === 'function') {
            cellEls = Array.from(el.querySelectorAll('td, [role="gridcell"], .dxgv, .cell, mat-cell, .ag-cell'));
          }
          if (!cellEls.length && Array.isArray(el.children)) {
            cellEls = Array.from(el.children);
          }

          const nonControlCells = cellEls.filter(c => !isControlOrExpanderCell(c));
          const dataCellEls = nonControlCells.length > 0 ? nonControlCells : cellEls;

          let mapped = false;
          if (rawHeaderLayout.length > 0 && rawHeaderLayout.length === cellEls.length) {
            rawHeaderLayout.forEach((hName, idx) => {
              if (hName && !EXPANDER_GLYPH_REGEX.test(hName)) {
                const c = cellEls[idx];
                let val = cleanCellText(c?.innerText || c?.textContent || '');
                if (!val) {
                  const link = typeof c?.querySelector === 'function' ? c.querySelector('a, button, input') : null;
                  if (link) {
                    val = cleanCellText(link.innerText || link.textContent || link.getAttribute('value') || '');
                  }
                }
                if (val && !EXPANDER_GLYPH_REGEX.test(val)) {
                  fields[hName] = val;
                  mapped = true;
                }
              }
            });
          }

          if (!mapped || Object.keys(fields).filter(k => !k.startsWith('_')).length === 0) {
            if (headers.length > 0 && dataCellEls.length > 0) {
              headers.forEach((hName, idx) => {
                if (dataCellEls[idx] !== undefined) {
                  const c = dataCellEls[idx];
                  let val = cleanCellText(c?.innerText || c?.textContent || '');
                  if (!val) {
                    const link = typeof c?.querySelector === 'function' ? c.querySelector('a, button, input') : null;
                    if (link) {
                      val = cleanCellText(link.innerText || link.textContent || link.getAttribute('value') || '');
                    }
                  }
                  if (val && !EXPANDER_GLYPH_REGEX.test(val)) {
                    fields[hName] = val;
                  }
                }
              });
            }
          }

          fields._cells = dataCellEls.map(c => cleanCellText(c?.innerText || c?.textContent || ''));

          // Semantic alias for Due Date
          if (!fields['Due Date']) {
            const dueCol = headers.find(h => /\bdue\b/i.test(h));
            if (dueCol && fields[dueCol] && !EXPANDER_GLYPH_REGEX.test(fields[dueCol])) {
              fields['Due Date'] = fields[dueCol];
            }
          }

          if (cellEls.length > 0) {
            cellEls.forEach(c => {
              if (typeof c.getAttribute === 'function') {
                const attr = c.getAttribute('data-field') || c.getAttribute('data-column') || c.getAttribute('data-label') || c.getAttribute('data-name');
                if (attr && attr.trim()) {
                  const val = cleanCellText(c.innerText || c.textContent || '');
                  if (val && !EXPANDER_GLYPH_REGEX.test(val)) {
                    fields[attr.trim()] = val;
                  }
                }
              }
            });
          }

          if (typeof el.querySelectorAll === 'function') {
            const dts = Array.from(el.querySelectorAll('dt'));
            const dds = Array.from(el.querySelectorAll('dd'));
            if (dts.length > 0 && dts.length === dds.length) {
              dts.forEach((dt, idx) => {
                const k = (dt.innerText || dt.textContent || '').trim().replace(/:$/, '');
                const v = cleanCellText(dds[idx].innerText || dds[idx].textContent || '');
                if (k && v && !EXPANDER_GLYPH_REGEX.test(v)) fields[k] = v;
              });
            }
          }

          // Document ID self-healing
          const fullText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          const invColKey = ['Invoice No', 'Invoice Number', 'Invoice #', 'Invoice', 'Inv No', 'Voucher No', 'Doc No']
            .find(k => fields[k] !== undefined) || headers.find(h => /invoice|voucher|doc\s*no/i.test(h));
          if (invColKey) {
            const currVal = fields[invColKey];
            if (!currVal || EXPANDER_GLYPH_REGEX.test(currVal) || !/\d/.test(currVal)) {
              const docMatch = fullText.match(DOCUMENT_ID_REGEX)?.[1] ||
                dataCellEls.map(c => cleanCellText(c.innerText || c.textContent || '')).find(t => DOCUMENT_ID_REGEX.test(t));
              if (docMatch) {
                fields[invColKey] = docMatch;
              }
            }
          }

          // Strip expander glyphs from any field
          for (const [k, v] of Object.entries(fields)) {
            if (typeof v === 'string') {
              if (EXPANDER_GLYPH_REGEX.test(v)) {
                delete fields[k];
              } else {
                fields[k] = cleanCellText(v);
              }
            }
          }

          return fields;
        }

        const total = items ? items.length : domElements.length;
        const result = [];
        for (let i = 0; i < total; i++) {
          const base = items && items[i] ? items[i] : {};
          const domEl = domElements[i] || null;
          const extracted = domEl ? extractFieldsFromElement(domEl) : {};
          const mergedFields = Object.assign({}, base.fields || {}, extracted);
          result.push({
            index: base.index !== undefined ? base.index : i,
            text: base.text || (domEl ? (domEl.innerText || domEl.textContent || '').trim() : ''),
            label: base.text || (domEl ? (domEl.innerText || domEl.textContent || '').trim() : `Item #${i + 1}`),
            tagName: base.tagName || (domEl ? domEl.tagName.toLowerCase() : ''),
            signature: base.signature || (domEl ? structuralSignature(domEl) : ''),
            href: base.href || (domEl ? domEl.querySelector('a[href]')?.href || null : null),
            id: base.id || (domEl ? domEl.id || null : null),
            fields: mergedFields
          });
        }
        return result;
      }, { collection: discovery.collection, items: discovery.items, cellParserSrc: CELL_PARSER_SRC });

      return itemsWithFields;
    } catch (err) {
      return (discovery?.items || []).map((it, idx) => ({
        index: it.index !== undefined ? it.index : idx,
        label: it.text || `Item #${idx + 1}`,
        text: it.text || '',
        fields: it.fields || {}
      }));
    }
  }

  /**
   * Evaluates if a loop item matches the configured filter criteria.
   */
  async evaluateItemFilter(page, discovery, index, filterInput = undefined) {
    const rawFilter = filterInput !== undefined
      ? filterInput
      : ((this.stateCoordinator ? (this.stateCoordinator.itemFilter || this.stateCoordinator.rowFilter) : null) || this.itemFilter || this.rowFilter || null);

    if (!rawFilter || (!rawFilter.value && !rawFilter.text && !rawFilter.conditions && !rawFilter.field)) {
      return { matches: true, reason: 'No filter configured', column: null, actualValue: 'All' };
    }

    const rawVal = rawFilter.value || rawFilter.text;
    if (rawVal === '__any__' || rawVal === 'all') {
      return { matches: true, reason: 'All items accepted (no filter)', column: null, actualValue: 'All' };
    }

    // 1. Fast evaluation from discovery item fields if available
    if (discovery && Array.isArray(discovery.items) && discovery.items[index]?.fields) {
      const itemRecord = Object.assign({}, discovery.items[index], discovery.items[index].fields);
      const targetCol = String(rawFilter.column || rawFilter.field || 'type').toLowerCase();
      const actualVal = itemRecord[rawFilter.column] || itemRecord[rawFilter.field] || itemRecord.Type || itemRecord.label || itemRecord.fullText || '';
      const evalResult = ConditionEvaluator.evaluate(itemRecord, rawFilter);
      return {
        matches: evalResult.matches,
        reason: evalResult.reason || 'Matches configured condition',
        column: targetCol,
        actualValue: actualVal
      };
    }

    let itemHandle = null;
    const targetCol = String(rawFilter.column || rawFilter.field || 'type').toLowerCase();
    try {
      itemHandle = await ItemDiscovery.getItemHandle(page, discovery, index);
      const itemEl = itemHandle ? (itemHandle.asElement ? itemHandle.asElement() : itemHandle) : null;
      if (!itemEl) {
        return {
          matches: false,
          field: rawFilter.column || rawFilter.field || null,
          column: targetCol,
          actualValue: null,
          expectedValue: null,
          operator: null,
          reason: 'Could not resolve element for filter',
          error: 'Could not resolve element for filter'
        };
      }

      const itemRecord = await itemEl.evaluate((el, cellParserSrc) => {
        const { EXPANDER_GLYPH_REGEX, DOCUMENT_ID_REGEX, cleanCellText, isControlOrExpanderCell } =
          typeof _createCellParser === 'function'
            ? _createCellParser()
            : (new Function('return (' + cellParserSrc + ')()'))();

        const fullText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        let cellEls = Array.from(el.querySelectorAll('td, [role="gridcell"]'));
        if (cellEls.length === 0) {
          cellEls = Array.from(el.querySelectorAll('.x-grid-cell, .dxgv, .cell'));
        }

        const nonControlCells = cellEls.filter(c => !isControlOrExpanderCell(c));
        const dataCellEls = nonControlCells.length > 0 ? nonControlCells : cellEls;
        const cells = dataCellEls.map(c => cleanCellText(c.innerText || c.textContent || ''));

        const gridContainer = el.parentElement?.closest('.x-grid, [role="grid"], [role="treegrid"], .dxgvTable, table, .data-table, .grid-container') ||
          el.closest('.x-grid, [role="grid"], .dxgvTable, table') ||
          document.querySelector('.x-grid, table, [role="grid"]');
        const record = {
          fullText,
          label: fullText.slice(0, 100),
          _cells: cells,
          Option: fullText,
          'Document Type': fullText,
          Text: fullText
        };

        let rawHeaderLayout = [];
        if (gridContainer) {
          const headerCt = (typeof gridContainer.querySelector === 'function' ? gridContainer.querySelector('.x-grid-header-ct, thead, .x-grid-header-row') : null) || gridContainer;
          const headerEls = Array.from(typeof headerCt.querySelectorAll === 'function' ? headerCt.querySelectorAll('.x-column-header, th, [role="columnheader"]') : [])
            .filter(h => !h.parentElement?.closest?.('.x-column-header'));
          rawHeaderLayout = headerEls.map(h => {
            const inner = (typeof h.querySelector === 'function' ? h.querySelector('.x-column-header-text') : null) || h;
            return cleanCellText(inner.innerText || inner.textContent || '');
          });
          const colTexts = rawHeaderLayout.filter(t => t.length > 0 && !EXPANDER_GLYPH_REGEX.test(t));

          if (rawHeaderLayout.length === cellEls.length) {
            rawHeaderLayout.forEach((hText, idx) => {
              if (hText && !EXPANDER_GLYPH_REGEX.test(hText) && cellEls[idx]) {
                const val = cleanCellText(cellEls[idx].innerText || cellEls[idx].textContent || '');
                if (val && !EXPANDER_GLYPH_REGEX.test(val)) {
                  record[hText] = val;
                }
              }
            });
          } else {
            colTexts.forEach((hText, idx) => {
              if (hText && cells[idx] !== undefined && !EXPANDER_GLYPH_REGEX.test(cells[idx])) {
                record[hText] = cells[idx];
              }
            });
          }
        }

        // Invoice Number / No fallback
        const currentInv = record['Invoice Number'] || record['Invoice No'] || record['Invoice'];
        if (!currentInv || EXPANDER_GLYPH_REGEX.test(currentInv) || !/\d/.test(currentInv)) {
          const invMatch = fullText.match(DOCUMENT_ID_REGEX)?.[1] ||
            cells.find(c => DOCUMENT_ID_REGEX.test(c));
          if (invMatch) {
            if (record['Invoice No'] !== undefined) record['Invoice No'] = invMatch;
            if (record['Invoice Number'] !== undefined) record['Invoice Number'] = invMatch;
            if (!record['Invoice No'] && !record['Invoice Number']) record['Invoice Number'] = invMatch;
          }
        }

        // Type fallback
        if (!record['Type'] || record['Type'] === fullText || /^(SI|INV|DR|TX|CM)-\d+/i.test(record['Type'])) {
          if (/\bcredit\s*memo\b/i.test(fullText)) record['Type'] = 'Credit Memo';
          else if (/\binvoice\b/i.test(fullText)) record['Type'] = 'Invoice';
          else record['Type'] = fullText;
        }

        // Strip expander glyphs from any field
        for (const [k, v] of Object.entries(record)) {
          if (typeof v === 'string' && EXPANDER_GLYPH_REGEX.test(v)) {
            delete record[k];
          }
        }

        return record;
      }, CELL_PARSER_SRC);

      const actualVal = itemRecord[rawFilter.column] || itemRecord[rawFilter.field] || itemRecord.Type || itemRecord.label || itemRecord.fullText || '';
      const evalResult = ConditionEvaluator.evaluate(itemRecord, rawFilter);
      return {
        matches: evalResult.matches,
        field: rawFilter.column || rawFilter.field || null,
        column: targetCol,
        actualValue: actualVal,
        expectedValue: rawFilter.value,
        operator: rawFilter.operator || 'contains',
        reason: evalResult.reason || (evalResult.matches ? 'Matches configured condition' : 'Does not match condition'),
        error: null
      };
    } catch (err) {
      logger.warn(`[ItemExecutionHandler] Filter check note on item #${index + 1}: ${err.message}`);
      return { matches: true, reason: 'Filter check error fallback', column: targetCol, actualValue: null };
    } finally {
      if (itemHandle) await itemHandle.dispose().catch(() => { });
    }
  }

  /**
   * Efficiently detects all available elements on the page, identifies relevant options/items,
   * excludes non-data controls (like "Select All"), and filters items based on the condition.
   */
  async detectAndFilterItems(page, discovery, isDropdown, rowFilter) {
    const filter = rowFilter || (this.stateCoordinator ? (this.stateCoordinator.itemFilter || this.stateCoordinator.rowFilter) : null) || this.itemFilter || this.rowFilter || null;
    const rawVal = filter ? (filter.value || filter.text) : null;
    const hasConditions = Boolean(filter && Array.isArray(filter.conditions) && filter.conditions.length > 0);
    const isFilterActive = Boolean(filter && (hasConditions || (rawVal && rawVal !== '__any__' && rawVal !== 'all')));
    const targetCol = filter ? String(filter.column || filter.field || filter.conditions?.[0]?.field || 'type').toLowerCase() : 'type';

    let itemsData = [];

    if (isDropdown && page) {
      // For dropdowns: query all visible options in a single evaluate call
      itemsData = await page.evaluate(() => {
        const visible = el => {
          if (!el || !el.isConnected) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const opts = Array.from(document.querySelectorAll('mat-option, [role="option"], select option')).filter(visible);
        return opts.map((el, idx) => {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          return {
            index: idx,
            text,
            isSelectAll: /select\s*all/i.test(text),
            fields: {
              Type: text,
              Option: text,
              'Document Type': text,
              Text: text,
              Value: text,
              fullText: text,
              label: text
            }
          };
        });
      }).catch(() => []);
    }

    // If non-dropdown or dropdown evaluate returned empty, use discovery.items
    if (!itemsData.length && discovery && Array.isArray(discovery.items) && discovery.items.length) {
      itemsData = discovery.items.map((item, idx) => {
        const text = item.text || '';
        return {
          index: item.index !== undefined ? item.index : idx,
          text,
          isSelectAll: /select\s*all/i.test(text),
          fields: item.fields || {
            Type: text,
            Option: text,
            'Document Type': text,
            Text: text,
            Value: text,
            fullText: text,
            label: text
          }
        };
      });
    }

    // Fallback if discovery.items is empty (e.g. synthetic test discovery with only itemCount)
    if (!itemsData.length) {
      const count = discovery ? (discovery.itemCount || 0) : 0;
      const fallbackList = [];
      for (let idx = 0; idx < count; idx++) {
        const itemIdentifier = await this.extractItemIdentifier(page, discovery, idx, isDropdown);
        let matches = true;
        let reason = 'Matches condition';
        if (isDropdown && /select\s*all/i.test(itemIdentifier.itemLabel)) {
          matches = false;
          reason = 'Dropdown "Select All" control excluded from data items';
        } else if (filter) {
          const filterCheck = await this.evaluateItemFilter(page, discovery, idx, filter);
          matches = filterCheck.matches;
          reason = filterCheck.reason;
        }
        fallbackList.push({
          index: idx,
          itemIdentifier,
          matches,
          reason
        });
      }
      return fallbackList;
    }

    // Evaluate all discovered items efficiently
    const evaluatedItems = [];
    for (const item of itemsData) {
      const fields = item.fields || {};
      const businessId = fields['Invoice ID'] || fields['INVOICE ID'] || fields['Invoice Number'] || fields['Invoice No'] || fields['Invoice'] ||
        fields['Order ID'] || fields['Order Number'] || fields['Order No'] || fields['Order'] ||
        fields['Transaction ID'] || fields['Tx ID'] || fields['Payment ID'] || fields['Payment No'] ||
        fields['Ref No'] || fields['Reference No'] || fields['Voucher No'] || fields['Doc ID'] || fields['Document ID'] ||
        fields['id'] || fields['ID'] ||
        (item.text && item.text.match(/\b((?:SI|INV|DR|TX|CM|PO|ORD|REC|STMT)-\d+(?:[-_]\w+)*|\b\d{5,10}\b)/i)?.[1]) || null;

      let itemLabel = item.text || `Item #${item.index + 1}`;
      if (businessId) {
        itemLabel = fields.Type ? `${businessId} (${fields.Type})` : businessId;
      }
      const isInvoice = /^(?:INV|SI)\b/i.test(businessId || '') || Boolean(fields['Invoice ID'] || fields['INVOICE ID'] || fields['Invoice Number'] || fields['Invoice No'] || fields['Invoice']);
      const itemKey = isDropdown
        ? `dropdown:${itemLabel}`
        : (businessId ? (isInvoice ? `invoice:${businessId}` : `record:${businessId}`) : `item_${item.index + 1}`);

      const itemIdentifier = { itemKey, itemLabel, invoiceNumber: businessId, businessId };

      let matches = true;
      let reason = 'Matches condition';

      if (isDropdown && item.isSelectAll) {
        matches = false;
        reason = 'Dropdown "Select All" control excluded from data items';
      } else if (isFilterActive) {
        const itemRecord = Object.assign({}, item, item.fields || {});
        const evalResult = ConditionEvaluator.evaluate(itemRecord, filter);
        matches = evalResult.matches;
        reason = evalResult.reason || (matches ? 'Matches configured condition' : `Filtered out by "${targetCol}"`);
      }

      evaluatedItems.push({
        index: item.index,
        itemIdentifier,
        fields: item.fields,
        matches,
        reason
      });
    }

    return evaluatedItems;
  }

  /**
   * Executes an individual item attempt loop with retry backoffs and DOM restoration.
   */
  async executeItemWithRetries({
    page,
    discovery,
    i,
    itemResult,
    startingActionOffset = 0,
    targetItem,
    itemIdentifier,
    generalizedActions,
    effectiveLoopStepIndex,
    isDropdown,
    triggerStep,
    partition,
    currentPageUrl,
    collectionUrl,
    initialPageUrls,
    currentPage,
    manifest,
    runner
  }) {
    const isAborted = () => (runner ? runner.isAborted : this.getIsAborted());
    const replayEngine = runner?.replayEngine || this.replayEngine;
    const downloadsDir = runner?.downloadsDir || this.downloadManager?.downloadsDir;
    const maxRetries = Number.isInteger(runner?.maxItemRetries) ? runner.maxItemRetries : this.maxItemRetries;
    const targetCollectionUrl = collectionUrl || currentPageUrl;

    const isCollectionPresent = async () => {
      if (runner && typeof runner.isCollectionPresent === 'function') {
        return runner.isCollectionPresent(page, discovery);
      }
      return this.gridAdapter ? this.gridAdapter.isCollectionPresent(page, discovery) : true;
    };

    const ensureDropdownOpen = async (trig) => {
      if (runner && typeof runner.ensureDropdownOpen === 'function') {
        return runner.ensureDropdownOpen(page, trig);
      }
      return this.gridAdapter ? this.gridAdapter.ensureDropdownOpen(page, trig, replayEngine) : false;
    };

    const executeDropdownOptionSingleSelect = async (idx, label) => {
      if (runner && typeof runner.executeDropdownOptionSingleSelect === 'function') {
        return runner.executeDropdownOptionSingleSelect(page, idx, label);
      }
      return this.gridAdapter ? this.gridAdapter.executeDropdownOptionSingleSelect(page, idx, label) : { success: false };
    };

    const clearGridSelections = async () => {
      if (runner && typeof runner.clearGridSelections === 'function') {
        return runner.clearGridSelections(page, discovery);
      }
      if (this.gridAdapter) await this.gridAdapter.clearGridSelections(page, discovery);
    };

    const enforceGridRowSingleSelection = async (idx) => {
      if (runner && typeof runner.enforceGridRowSingleSelection === 'function') {
        return runner.enforceGridRowSingleSelection(page, discovery, idx);
      }
      if (this.gridAdapter) await this.gridAdapter.enforceGridRowSingleSelection(page, discovery, idx);
    };

    const snapshotDownloadedFiles = () => {
      if (runner && typeof runner.snapshotDownloadedFiles === 'function') {
        return runner.snapshotDownloadedFiles();
      }
      return this.downloadManager ? this.downloadManager.snapshotDownloadedFiles() : { runFiles: [], osFiles: [] };
    };

    const waitForDownload = async (prevSnap, waitMs) => {
      if (runner && typeof runner.waitForDownload === 'function') {
        return runner.waitForDownload(prevSnap, waitMs);
      }
      return this.downloadManager ? this.downloadManager.waitForDownload(prevSnap, waitMs) : [];
    };

    const processAndStoreDownload = (src, key, lbl, flds) => {
      if (runner && typeof runner.processAndStoreDownload === 'function') {
        return runner.processAndStoreDownload(src, key, lbl, flds);
      }
      return this.downloadManager ? this.downloadManager.processAndStoreDownload(src, key, lbl, flds) : null;
    };

    const writeLoopCheckpoint = (man, idx, offset, p, pIdx, active) => {
      if (runner && typeof runner.writeLoopCheckpoint === 'function') {
        return runner.writeLoopCheckpoint(man, idx, offset, p, pIdx, active);
      }
      if (this.stateCoordinator) this.stateCoordinator.writeLoopCheckpoint(man, idx, offset, p, pIdx, active);
    };

    itemResult.actions = Array.isArray(itemResult.actions) ? itemResult.actions : [];
    itemResult.downloadedFiles = Array.isArray(itemResult.downloadedFiles) ? itemResult.downloadedFiles : [];
    itemResult.attempts = Number.isInteger(itemResult.attempts) ? itemResult.attempts : 0;
    itemResult.retryCount = Number.isInteger(itemResult.retryCount) ? itemResult.retryCount : 0;

    let completed = false;
    let lastError = null;
    let nextActionOffset = startingActionOffset;

    for (let attempt = 0; attempt <= maxRetries && !completed; attempt++) {
      if (isAborted()) throw new Error('Execution stopped by user');

      itemResult.attempts = attempt + 1;
      if (attempt > 0) {
        itemResult.retryCount = attempt;
        logger.warn('[Loop Runner] Retrying item #' + (i + 1) + ' (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + ')');
        await new Promise(r => setTimeout(r, 500));

        // Reacquire the live DOM item and resume at the failed action checkpoint.
        const restoreRes = await this.restoreCollectionContext({
          page,
          discovery,
          collectionUrl: targetCollectionUrl,
          runner
        });
        if (!restoreRes.restored) {
          logger.warn(`[Loop Runner] Collection view could not be restored before retry: ${restoreRes.reason}`);
        }
      }

      if (replayEngine && typeof replayEngine.resetExtractedRowFields === 'function') {
        replayEngine.resetExtractedRowFields();
      }

      try {
        for (let actionOffset = nextActionOffset; actionOffset < generalizedActions.length; actionOffset++) {
          if (isAborted()) throw new Error('Execution stopped by user');

          const action = generalizedActions[actionOffset];
          const actionType = action.type || action.action || 'CLICK';

          // Evaluate in-loop IF/ELSE condition if attached to this action step
          const actionCondition = action.condition || action.conditions || action.if || action.filter;
          if (actionCondition) {
            const itemRecord = Object.assign({}, targetItem.fields || {}, {
              _rawText: itemIdentifier.itemLabel,
              _index: i
            });
            const condResult = ConditionEvaluator.evaluate(itemRecord, actionCondition);
            if (!condResult.matches) {
              logger.info(`[Loop Runner] Skipping Action #${effectiveLoopStepIndex + actionOffset + 1} (${actionType}) for item #${i + 1}: ${condResult.reason || 'Step condition evaluated to false'}`);
              const skippedResult = {
                index: effectiveLoopStepIndex + actionOffset + 1,
                type: actionType,
                status: 'SKIPPED',
                reason: condResult.reason || 'Step condition evaluated to false'
              };
              itemResult.actions.push(skippedResult);
              nextActionOffset = actionOffset + 1;
              writeLoopCheckpoint(manifest, itemResult.index, nextActionOffset, currentPage, i, itemResult);
              continue;
            }
          }

          const isDownloadAction = actionType === 'CLICK' && Boolean(downloadsDir) && ItemExecutionHandler.isDownloadPotentialAction(action, targetItem);
          const forceRedownload = runner?.forceRedownload === true || this.forceRedownload === true;

          // Deduplication: If this download action already succeeded for this record, do not re-download
          if (isDownloadAction && !forceRedownload) {
            const alreadyDownloaded = (runner && typeof runner.checkIfAlreadyDownloaded === 'function')
              ? runner.checkIfAlreadyDownloaded(itemIdentifier.itemKey, itemIdentifier.invoiceNumber, targetItem.fields || {})
              : (this.artifactDownloadManager?.checkIfAlreadyDownloaded
                  ? this.artifactDownloadManager.checkIfAlreadyDownloaded(itemIdentifier.itemKey, itemIdentifier.invoiceNumber, targetItem.fields || {})
                  : null);

            const alreadyHaveItemFile = Array.isArray(itemResult.downloadedFiles) && itemResult.downloadedFiles.length > 0;

            if (alreadyDownloaded?.isDuplicate) {
              logger.info(`[Loop Runner] Skipping download action for item #${i + 1} ("${itemIdentifier.itemLabel}") - file already downloaded: "${alreadyDownloaded.record?.filename || 'existing artifact'}"`);
              const skipDlResult = {
                index: effectiveLoopStepIndex + actionOffset + 1,
                type: actionType,
                status: 'SKIPPED_DUPLICATE',
                reason: alreadyDownloaded.inFolder ? 'Already exists in download folder' : 'Already recorded as downloaded',
                downloadedFiles: alreadyDownloaded.record ? [alreadyDownloaded.record.filename] : []
              };
              itemResult.actions.push(skipDlResult);
              if (alreadyDownloaded.record && !alreadyHaveItemFile) {
                itemResult.downloadedFiles.push(alreadyDownloaded.record);
              }
              nextActionOffset = actionOffset + 1;
              writeLoopCheckpoint(manifest, itemResult.index, nextActionOffset, currentPage, i, itemResult);
              continue;
            }
          }

          const beforeActionFiles = snapshotDownloadedFiles();

          if (isDropdown && actionOffset === 0 && action.scope === 'item') {
            // Sequential single-selection dropdown checkbox logic:
            // 1. Ensure dropdown is open
            await ensureDropdownOpen(triggerStep);
            // 2. Uncheck previous option(s), check target option i
            const selectResult = await executeDropdownOptionSingleSelect(i, itemIdentifier.itemLabel);
            if (!selectResult.success) {
              throw new Error(`Dropdown option selection failed for item #${i + 1}: ${selectResult.reason || 'Could not verify target option was selected'}`);
            }
            logger.info(`[Loop Runner] Item #${i + 1}/${discovery.itemCount}: Checked "${selectResult.targetText}", previous selections cleared.`);
          } else if (action.scope === 'item') {
            // Table/grid row action:
            // On first item action (actionOffset === 0), clear previously selected rows first
            if (actionOffset === 0) {
              await clearGridSelections();
            }

            const itemHandle = await ItemDiscovery.getItemHandle(page, discovery, i);
            const itemElement = itemHandle.asElement();
            if (!itemElement) {
              await itemHandle.dispose().catch(() => { });
              throw new Error(`Item at index ${i} could not be resolved`);
            }

            try {
              if (replayEngine) {
                await replayEngine.executeActionWithinItem(
                  itemElement,
                  action,
                  effectiveLoopStepIndex + actionOffset
                );
              }

              // If first item action, verify and enforce that only row i is selected (for ERP grids without explicit checkbox steps)
              const isCheckboxStep = Boolean(
                action.isCheckbox ||
                action.desiredState !== undefined ||
                action.target?.fingerprint?.type === 'checkbox' ||
                action.fingerprint?.type === 'checkbox' ||
                (typeof action.target?.selector === 'string' && action.target.selector.includes('checkbox')) ||
                action.target?.candidates?.some(c => typeof c?.value === 'string' && c.value.includes('checkbox'))
              );
              if (actionOffset === 0 && !isCheckboxStep) {
                await enforceGridRowSingleSelection(i);
                logger.info(`[Loop Runner] Item #${i + 1}/${discovery.itemCount}: Selected target row, previous grid selections cleared.`);
              }
            } finally {
              await itemElement.dispose().catch(() => { });
            }
          } else {
            // Page-scoped action (e.g. click backdrop, Run Report, Export to Excel)
            if (replayEngine) {
              await replayEngine.executeAction(
                action,
                effectiveLoopStepIndex + actionOffset
              );
            }
          }

          const actionResult = {
            index: effectiveLoopStepIndex + actionOffset + 1,
            type: actionType,
            status: 'SUCCESS'
          };

          if (actionType === 'CLICK' && downloadsDir) {
            const downloadWaitMs = isDownloadAction
              ? this.downloadTimeoutMs
              : this.defaultClickWaitMs;
            const downloaded = await waitForDownload(beforeActionFiles, downloadWaitMs);
            if (downloaded.length) {
              for (const dl of downloaded) {
                if (dl.sizeBytes === 0 || dl.filename.endsWith('.crdownload') || dl.filename.endsWith('.tmp')) {
                  continue;
                }
                const organized = processAndStoreDownload(dl.path, itemIdentifier.itemKey, itemIdentifier.itemLabel, targetItem.fields || {});
                if (organized) {
                  const alreadyPresent = itemResult.downloadedFiles.some(existing =>
                    (existing.fileHash && existing.fileHash === organized.fileHash) ||
                    existing.filename === organized.filename ||
                    existing.targetFilename === organized.targetFilename
                  );
                  if (!alreadyPresent) {
                    itemResult.downloadedFiles.push(organized);
                  }
                } else {
                  itemResult.downloadedFiles.push(dl);
                }
                // Unlink temporary file from downloadsDir so late sweep does NOT re-process it
                try {
                  if (fs.existsSync(dl.path) && dl.path.startsWith(downloadsDir)) {
                    fs.unlinkSync(dl.path);
                  }
                } catch {}
              }
              actionResult.downloadedFiles = itemResult.downloadedFiles.map(file => file.filename || file.targetFilename);
            }
          }

          itemResult.actions.push(actionResult);
          nextActionOffset = actionOffset + 1;
          writeLoopCheckpoint(
            manifest,
            itemResult.index,
            nextActionOffset,
            currentPage,
            i,
            itemResult
          );
          await new Promise(r => setTimeout(r, 300));
        }

        const extraFields = replayEngine && typeof replayEngine.getExtractedRowFields === 'function'
          ? replayEngine.getExtractedRowFields()
          : {};
        targetItem.fields = { ...(targetItem.fields || {}), ...extraFields };
        itemResult.fields = { ...(targetItem.fields || {}) };

        // Allow the complete per-item procedure to settle before restoring state.
        await new Promise(r => setTimeout(r, 800));

        // Check if any late download arrived for this item (e.g. late export/save response)
        if (downloadsDir && fs.existsSync(downloadsDir)) {
          try {
            const pendingFiles = fs.readdirSync(downloadsDir)
              .filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.download'));
            for (const f of pendingFiles) {
              const rawPath = path.join(downloadsDir, f);
              if (!fs.existsSync(rawPath)) continue;
              const stats = fs.statSync(rawPath);
              if (stats.size === 0) continue;

              const alreadyProcessed = (itemResult.downloadedFiles || []).some(existing =>
                existing.filename === f || existing.targetFilename === f || existing.originalFilename === f
              );
              if (alreadyProcessed) {
                try { fs.unlinkSync(rawPath); } catch {}
                continue;
              }

              const organized = processAndStoreDownload(rawPath, itemIdentifier.itemKey, itemIdentifier.itemLabel, targetItem.fields || {});
              if (organized) {
                itemResult.downloadedFiles = itemResult.downloadedFiles || [];
                const alreadyInItemHashed = itemResult.downloadedFiles.some(existing =>
                  (existing.fileHash && existing.fileHash === organized.fileHash) ||
                  existing.filename === organized.filename
                );
                if (!alreadyInItemHashed) {
                  itemResult.downloadedFiles.push(organized);
                }
                try { fs.unlinkSync(rawPath); } catch {}
              }
            }
          } catch {}
        }

        // Close only auxiliary tabs opened by item actions (e.g. target="_blank" download links)
        // NEVER close the dashboard tab or pre-existing tabs
        try {
          const activeReplayEngine = runner?.replayEngine || this.replayEngine;
          if (activeReplayEngine?.tabManager) {
            await activeReplayEngine.tabManager.cleanupAuxiliaryTabs();
          } else {
            const browserPages = await page.browser().pages();
            for (const p of browserPages) {
              if (p !== page && !p.isClosed()) {
                const pUrl = p.url() || '';
                const isDashboard = pUrl.includes('127.0.0.1:3000') || pUrl.includes('localhost:3000') || pUrl.includes('/app#') || pUrl.includes('/dashboard');
                const wasInitial = initialPageUrls && initialPageUrls.has(pUrl);
                if (!isDashboard && !wasInitial) {
                  await p.close().catch(() => {});
                }
              }
            }
          }
          await page.bringToFront().catch(() => { });
        } catch { }

        // Verify and restore collection view for the next item
        const restoreRes = await this.restoreCollectionContext({
          page,
          discovery,
          collectionUrl: targetCollectionUrl,
          runner
        });
        if (!restoreRes.restored) {
          logger.warn(`[Loop Runner] Collection view not present after item #${i + 1} (${restoreRes.reason})`);
          itemResult.collectionRestorationFailed = true;
          itemResult.collectionRestorationReason = restoreRes.reason;
        } else {
          logger.info(`[ITEM ${i + 1}] Collection view preserved (${restoreRes.method}). Ready for next item.`);
        }

        // Ensure the collection list container is present on the page before next item
        if (discovery.collection && discovery.collection.ancestorSelector) {
          try {
            await page.waitForSelector(discovery.collection.ancestorSelector, { timeout: 3000 }).catch(() => { });
          } catch { }
        }

        completed = true;
      } catch (attemptErr) {
        lastError = attemptErr;
        const diagReport = attemptErr.resolutionReport || attemptErr.details?.resolutionReport;
        const diagReason = diagReport?.reason || diagReport?.attempts?.find(a => a.reason)?.reason;
        const detailStr = diagReason ? ` (${diagReason})` : '';
        logger.warn('[Loop Runner] Item #' + (i + 1) + ' attempt ' + (attempt + 1) + ' failed at action #' + (nextActionOffset + 1) + ': ' + attemptErr.message + detailStr);

        if (attempt < maxRetries) {
          // Keep the checkpoint at the first action that did not complete.
          continue;
        }
      }
    }

    if (!completed) {
      throw lastError || new Error('Item #' + (i + 1) + ' failed after ' + itemResult.attempts + ' attempt(s)');
    }

    itemResult.status = 'SUCCESS';
    if (Array.isArray(itemResult.downloadedFiles) && itemResult.downloadedFiles.length > 0) {
      const firstDl = itemResult.downloadedFiles[0];
      if (firstDl) {
        targetItem.fields = {
          ...(targetItem.fields || {}),
          Downloaded_File: firstDl.filename,
          ...(firstDl.extractedFields || {}),
          ...(firstDl.reconciliationStatus ? { Reconciliation_Status: firstDl.reconciliationStatus } : {}),
          ...(firstDl.reconciliationDelta !== undefined && firstDl.reconciliationDelta !== null ? { Reconciliation_Delta: firstDl.reconciliationDelta } : {})
        };
      }
    }
    itemResult.fields = { ...(targetItem.fields || {}), ...(itemResult.fields || {}) };
    manifest.itemsSucceeded++;
    if (itemResult.downloadedFiles.length) {
      manifest.downloadedFiles.push(...itemResult.downloadedFiles);
    }

    return { completed: true, nextActionOffset };
  }

  /**
   * Encapsulates the entire lifecycle of an item attempt:
   * 1. Setting up active item context and itemResult
   * 2. Checkpointing starting offset
   * 3. Executing item with retries
   * 4. Error isolation, abort detection, and DOM recovery
   * 5. Finalizing manifest and progress notification
   */
  async executeItemAttempt({
    page,
    discovery,
    i,
    targetItem,
    itemIdentifier,
    generalizedActions,
    effectiveLoopStepIndex,
    isDropdown,
    triggerStep,
    partition,
    currentPageUrl,
    initialPageUrls,
    currentPage,
    manifest,
    checkpoint,
    resumePage,
    resumePageItemIndex,
    resumeActionOffset,
    resumeItemIndex,
    onProgress = () => {},
    runner
  }) {
    const isResumingCurrentItem =
      checkpoint &&
      currentPage === resumePage &&
      i === resumePageItemIndex &&
      resumeItemIndex != null;

    if (runner) {
      runner._activeItemContext = {
        itemKey: itemIdentifier.itemKey,
        itemLabel: itemIdentifier.itemLabel,
        fields: targetItem.fields || {},
        invoiceNumber: itemIdentifier.invoiceNumber,
        index: i
      };
    }

    const itemResult = isResumingCurrentItem && checkpoint.activeItem
      ? { ...checkpoint.activeItem, status: 'PENDING', error: null }
      : {
        index: resumeItemIndex != null && currentPage === resumePage && i === resumePageItemIndex
          ? resumeItemIndex
          : manifest.results.reduce((max, result) => Math.max(max, Number(result.index) || 0), 0) + 1,
        itemIndex: i,
        page: currentPage,
        status: 'PENDING',
        itemKey: itemIdentifier.itemKey,
        label: itemIdentifier.itemLabel,
        timestamp: new Date().toISOString(),
        error: null
      };

    const startingActionOffset =
      checkpoint && currentPage === resumePage && i === resumePageItemIndex
        ? resumeActionOffset
        : 0;

    const writeLoopCheckpoint = (man, idx, offset, p, pIdx, active) => {
      if (runner && typeof runner.writeLoopCheckpoint === 'function') {
        return runner.writeLoopCheckpoint(man, idx, offset, p, pIdx, active);
      }
      if (this.stateCoordinator) this.stateCoordinator.writeLoopCheckpoint(man, idx, offset, p, pIdx, active);
    };

    writeLoopCheckpoint(
      manifest,
      itemResult.index,
      startingActionOffset,
      currentPage,
      i,
      itemResult
    );

    const isZeroClickFastScrape = !generalizedActions ||
      generalizedActions.length === 0 ||
      generalizedActions.every(a => {
        const act = (a.type || a.action || '').toUpperCase();
        return act === 'EXTRACT_TABLE' || act === 'LOOP_START' || a.isLoopAnchor || act === 'EXTRACT';
      });

    if (isZeroClickFastScrape) {
      itemResult.status = 'SUCCESS';
      itemResult.fields = { ...(targetItem.fields || {}) };
      itemResult.downloadedFiles = [];
      manifest.itemsSucceeded++;

      if (!Array.isArray(manifest.extractedRows)) {
        manifest.extractedRows = [];
      }
      const rawId = itemIdentifier?.itemKey || itemIdentifier?.invoiceNumber || (typeof itemIdentifier === 'object' ? itemIdentifier.itemLabel : itemIdentifier) || `item_${i + 1}`;
      manifest.extractedRows.push({
        Item_ID: rawId,
        Page: currentPage,
        ...(targetItem.fields || {})
      });

      const existingIdx = manifest.results.findIndex(r => r.index === itemResult.index);
      if (existingIdx >= 0) {
        manifest.results[existingIdx] = itemResult;
      } else {
        manifest.results.push(itemResult);
      }
      if (runner) runner.manifest = manifest;

      const runsDir = runner ? runner.runsDir : (this.downloadManager ? this.downloadManager.runsDir : null);
      if (runsDir) {
        try {
          fs.writeFileSync(path.join(runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        } catch {}
      }

      writeLoopCheckpoint(manifest, null, null, currentPage, i + 1, null);
      if (typeof onProgress === 'function') {
        onProgress({ status: 'ITEM_COMPLETE', itemResult, manifest });
      }
      return { itemResult };
    }

    let nextActionOffset = startingActionOffset;
    try {
      const res = await this.executeItemWithRetries({
        page,
        discovery,
        i,
        itemResult,
        startingActionOffset,
        targetItem,
        itemIdentifier,
        generalizedActions,
        effectiveLoopStepIndex,
        isDropdown,
        triggerStep,
        partition,
        currentPageUrl,
        initialPageUrls,
        currentPage,
        manifest,
        runner
      });
      nextActionOffset = res.nextActionOffset;
    } catch (itemErr) {
      const isAborted = runner ? runner.isAborted : this.getIsAborted();
      if (isAborted) {
        itemResult.status = 'STOPPED';
        itemResult.error = 'Execution stopped by user';
        manifest.status = 'STOPPED';
        const existingIdx = manifest.results.findIndex(r => r.index === itemResult.index);
        if (existingIdx >= 0) {
          manifest.results[existingIdx] = itemResult;
        } else {
          manifest.results.push(itemResult);
        }
        writeLoopCheckpoint(
          manifest,
          itemResult.index,
          nextActionOffset,
          currentPage,
          i,
          itemResult
        );
        return { stopped: true, itemResult };
      }

      logger.error(`[Loop Runner] Error on item #${i + 1}: ${itemErr.message}`);
      itemResult.status = 'FAILED';
      itemResult.error = itemErr.message;
      manifest.itemsFailed++;

      // Attempt recovery
      try {
        const activeReplayEngine = runner?.replayEngine || this.replayEngine;
        if (activeReplayEngine?.tabManager) {
          await activeReplayEngine.tabManager.cleanupAuxiliaryTabs();
        } else {
          const browserPages = await page.browser().pages();
          for (const p of browserPages) {
            if (p !== page && !p.isClosed()) {
              const pUrl = p.url() || '';
              const isDashboard = pUrl.includes('127.0.0.1:3000') || pUrl.includes('localhost:3000') || pUrl.includes('/app#') || pUrl.includes('/dashboard');
              const wasInitial = initialPageUrls && initialPageUrls.has(pUrl);
              if (!isDashboard && !wasInitial) {
                await p.close().catch(() => {});
              }
            }
          }
        }
        await page.bringToFront().catch(() => { });
        const replayEngine = runner?.replayEngine || this.replayEngine;
        if (replayEngine) {
          await replayEngine.dismissOverlays().catch(() => { });
        } else if (page.keyboard) {
          await page.keyboard.press('Escape').catch(() => { });
        }
        await this.restoreCollectionContext({
          page,
          discovery,
          collectionUrl: targetCollectionUrl,
          runner
        });
      } catch {
        // Ignore recovery error
      }
    }

    if (itemResult.status === 'SUCCESS') {
      if (Array.isArray(itemResult.downloadedFiles) && itemResult.downloadedFiles.length > 0) {
        const firstDl = itemResult.downloadedFiles[0];
        if (firstDl) {
          targetItem.fields = {
            ...(targetItem.fields || {}),
            Downloaded_File: firstDl.filename,
            ...(firstDl.extractedFields || {}),
            ...(firstDl.reconciliationStatus ? { Reconciliation_Status: firstDl.reconciliationStatus } : {}),
            ...(firstDl.reconciliationDelta !== undefined && firstDl.reconciliationDelta !== null ? { Reconciliation_Delta: firstDl.reconciliationDelta } : {})
          };
          itemResult.fields = {
            ...(itemResult.fields || {}),
            ...(targetItem.fields || {})
          };
        }
      }

      if (!Array.isArray(manifest.extractedRows)) {
        manifest.extractedRows = [];
      }
      const rawId = itemIdentifier?.itemKey || itemIdentifier?.invoiceNumber || (typeof itemIdentifier === 'object' ? itemIdentifier.itemLabel : itemIdentifier) || `item_${i + 1}`;
      manifest.extractedRows.push({
        Item_ID: rawId,
        Page: currentPage,
        ...(targetItem.fields || {}),
        ...(itemResult.fields || {})
      });
    }

    const existingIdx = manifest.results.findIndex(r => r.index === itemResult.index);
    if (existingIdx >= 0) {
      manifest.results[existingIdx] = itemResult;
    } else {
      manifest.results.push(itemResult);
    }
    if (runner) runner.manifest = manifest;

    const runsDir = runner ? runner.runsDir : (this.downloadManager ? this.downloadManager.runsDir : null);
    if (runsDir) {
      try {
        fs.writeFileSync(path.join(runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch { }
    }

    writeLoopCheckpoint(
      manifest,
      null,
      null,
      currentPage,
      i + 1,
      null
    );
    if (typeof onProgress === 'function') {
      onProgress({ status: 'ITEM_COMPLETE', itemResult, manifest });
    }

    return { itemResult };
  }

  /**
   * Prepares collection discovery, analyzes loop step, and handles dropdown detection
   */
  async prepareCollection({ page, workflow, loopStepIndex, manifest, checkpoint, onProgress, runner }) {
    const replayEngine = runner?.replayEngine || this.replayEngine;
    const steps = workflow.steps || workflow.recordingData?.actions || workflow.actions || [];

    let effectiveLoopStepIndex = Number.isInteger(loopStepIndex) ? loopStepIndex : (workflow.loopStepIndex ?? workflow.settings?.loopStepIndex ?? null);
    if (effectiveLoopStepIndex === null || (steps[effectiveLoopStepIndex] && LoopDetector.isNavigationOrChrome(steps[effectiveLoopStepIndex].target?.candidates?.find(c => c?.strategy === 'css-path')?.value || '', steps[effectiveLoopStepIndex].target?.fingerprint || {}))) {
      const autoIdx = LoopDetector.findLoopCandidateIndex(steps);
      effectiveLoopStepIndex = autoIdx >= 0 ? autoIdx : 0;
    }

    const partition = LoopDetector.partitionWorkflow(steps, effectiveLoopStepIndex);
    const targetStep = partition.loopSteps[0];
    if (!targetStep) return { fallbackToStandard: true };
    const analysis = LoopDetector.analyzeStep(targetStep);
    manifest.loopStepIndex = effectiveLoopStepIndex;

    const isDropdownCandidate = analysis.patternType === 'dropdown-option' || /mat-option/i.test(targetStep.fingerprint?.tagName || targetStep.fingerprint?.parentTag || '');
    const triggerStep = partition.setupSteps.length > 0 ? partition.setupSteps[partition.setupSteps.length - 1] : null;
    if (isDropdownCandidate) {
      if (runner && typeof runner.ensureDropdownOpen === 'function') {
        await runner.ensureDropdownOpen(page, triggerStep);
      } else if (this.gridAdapter) {
        await this.gridAdapter.ensureDropdownOpen(page, triggerStep, replayEngine);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    let discovery = await ItemDiscovery.discover(page, targetStep.target || targetStep.fingerprint, { minItems: 1, minScore: 0.45 }).catch(() => ({ success: false }));
    if (!discovery.success || discovery.itemCount < 1) return { fallbackToStandard: true };
    if (!checkpoint) { manifest.itemsTotal = discovery.itemCount; manifest.pagesProcessed = 1; }

    const isDropdown = (runner && typeof runner.isDropdownOptionCollection === 'function')
      ? runner.isDropdownOptionCollection(discovery.collection, discovery.items)
      : (this.gridAdapter ? this.gridAdapter.isDropdownOptionCollection(discovery.collection, discovery.items) : false);
    const itemsWithFields = Array.isArray(discovery.items) ? discovery.items : [];

    return {
      fallbackToStandard: false,
      effectiveLoopStepIndex,
      partition,
      targetStep,
      analysis,
      discovery,
      isDropdown,
      itemsWithFields,
      triggerStep
    };
  }

  /**
   * Evaluates filter preview counts and checks for missing field configuration errors
   */
  evaluateCollectionPreview({ items = [], filter = null, limit = null, validationError = null }) {
    if (validationError) throw new Error(`Filter configuration error: ${validationError}`);
    const condRules = ConditionEvaluator.normalizeConditions(filter).rules;
    const isRelational = condRules.some(r => ['<=', '>=', '<', '>', 'before', 'after', 'starts_with', 'ends_with', 'in', 'not_in', '!=', 'not_equals', 'date_before', 'date_after', 'date_between', 'last_n_days', 'greater_than', 'less_than'].some(o => String(r.operator || '').toLowerCase().includes(o)));

    let preview;
    if (isRelational) {
      let matchingCount = 0, selectedCount = 0, skippedFilterCount = 0, skippedLimitCount = 0;
      const selectedPreview = [], skippedFilterPreview = [], errors = [];
      if (items.length > 0) {
        for (const rule of condRules) {
          if (!items.some(it => ConditionEvaluator.extractFieldValue(Object.assign({}, it, it?.fields || {}), rule.field) != null)) {
            errors.push(`Configured field "${rule.field}" is not available on item`);
          }
        }
      }
      for (let i = 0; i < items.length; i++) {
        const evalRes = ConditionEvaluator.evaluate(Object.assign({}, items[i], items[i]?.fields || {}), filter);
        if (evalRes.matches) {
          matchingCount++;
          if (limit === null || selectedCount < limit) {
            selectedCount++;
            if (selectedPreview.length < 10) selectedPreview.push({ index: i + 1, label: items[i].label, status: 'SELECTED' });
          } else {
            skippedLimitCount++;
          }
        } else {
          skippedFilterCount++;
          if (skippedFilterPreview.length < 10) skippedFilterPreview.push({ index: i + 1, label: items[i].label, status: 'SKIPPED_FILTER', reason: evalRes.reason });
        }
      }
      preview = { totalCount: items.length, matchingCount, selectedCount, skippedFilterCount, skippedLimitCount, selectedPreview, skippedFilterPreview, errors };
    } else {
      preview = evaluateFilterPreview(filter, items, { loopLimit: limit, previewLimit: items.length });
    }

    if (preview.errors?.length > 0) throw new Error(`Filter configuration error: ${preview.errors.join('; ')}`);
    return { ...preview, isRelational, effectiveFilter: filter };
  }

  /**
   * Safely handles scenarios where zero items match the configured filter
   */
  async handleZeroMatches({ page, discovery, isDropdown, itemsWithFields, preview, manifest, isRelational, effectiveFilter, onProgress, runner }) {
    logger.info(`[Loop Runner] Filter criteria selected 0 of ${discovery.itemCount} item(s). No items to execute.`);
    manifest.itemsTotal = discovery.itemCount;
    manifest.matchingCount = preview.matchingCount;
    manifest.matching = preview.matchingCount;
    manifest.selectedCount = 0;
    manifest.selected = 0;
    manifest.skippedFilterCount = preview.skippedFilterCount;
    manifest.skippedFilter = preview.skippedFilterCount;
    manifest.skippedLimitCount = preview.skippedLimitCount;
    manifest.skippedLimit = preview.skippedLimitCount;
    manifest.skippedDuplicateCount = 0;
    manifest.skippedDuplicate = 0;
    manifest.itemsSkipped = preview.skippedFilterCount + preview.skippedLimitCount;

    const currentPage = 1;
    for (let i = 0; i < discovery.itemCount; i++) {
      const itemIdentifier = (runner && typeof runner.extractItemIdentifier === 'function')
        ? await runner.extractItemIdentifier(page, discovery, i, isDropdown)
        : await this.extractItemIdentifier(page, discovery, i, isDropdown);
      const filterCheck = isRelational
        ? ConditionEvaluator.evaluate(itemsWithFields[i]?.fields || {}, effectiveFilter)
        : sharedEvaluateItemFilter(effectiveFilter, itemsWithFields[i]?.fields || {});
      const skippedResult = {
        index: i + 1,
        itemIndex: i,
        page: currentPage,
        label: itemIdentifier.itemLabel,
        itemKey: itemIdentifier.itemKey,
        status: 'SKIPPED_FILTER',
        skippedReason: filterCheck.reason,
        timestamp: new Date().toISOString()
      };
      manifest.results.push(skippedResult);
      if (typeof onProgress === 'function') onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
    }
    manifest.status = 'COMPLETED';
    manifest.endTime = new Date().toISOString();
    const writeLoopCheckpoint = (m, cItem, cAct, cPage, cPItem, active) => {
      if (runner && typeof runner.writeLoopCheckpoint === 'function') {
        return runner.writeLoopCheckpoint(m, cItem, cAct, cPage, cPItem, active);
      }
      if (this.stateCoordinator) this.stateCoordinator.writeLoopCheckpoint(m, cItem, cAct, cPage, cPItem, active);
    };
    writeLoopCheckpoint(manifest, null, null, currentPage, null, null);
    const runsDir = runner ? runner.runsDir : (this.downloadManager ? this.downloadManager.runsDir : null);
    if (runsDir) {
      try { fs.writeFileSync(path.join(runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
    }
    if (typeof onProgress === 'function') onProgress({ status: manifest.status, manifest });
    return manifest;
  }

  /**
   * Coordinates multi-page loop pagination and sequential item execution
   */
  async runPaginationLoop({ page, workflow, manifest, checkpoint, prep, runner, onProgress }) {
    const { partition, effectiveLoopStepIndex, isDropdown, triggerStep } = prep;
    let discovery = prep.discovery;
    const targetStep = partition.loopSteps[0];
    const generalizedActions = ActionGeneralizer.generalizeActions(partition.loopSteps, discovery.collection);
    logger.info(`[Loop Runner] Discovered ${discovery.itemCount} repeated item(s) with confidence ${Math.round(discovery.confidence * 100)}% (Dropdown Mode: ${isDropdown})`);
    logger.info(`[Loop Runner] Generalized ${generalizedActions.length} loop action(s).`);
    if (typeof onProgress === 'function') onProgress({ status: 'PROCESSING_ITEMS', manifest, discovery, generalizedActions });

    const paginationEnabled = workflow.pagination?.enabled === true;
    const maxPages = Number.isInteger(workflow.pagination?.maxPages) ? Math.max(1, workflow.pagination.maxPages) : 100;
    let currentPage = 1;
    const resumePage = checkpoint?.currentPage ?? 1;
    const resumePageItemIndex = checkpoint?.currentPageItemIndex ?? 0;
    const resumeActionOffset = checkpoint?.currentActionOffset ?? 0;
    const resumeItemIndex = checkpoint?.currentItemIndex ?? null;

    const browserPages = await page.browser().pages();
    const initialPageUrls = new Set(browserPages.map(p => p.url()));

    const advanceToNextPage = async (p, wf) => {
      if (runner && typeof runner.advanceToNextPage === 'function') return runner.advanceToNextPage(p, wf);
      return this.gridAdapter ? this.gridAdapter.advanceToNextPage(p, wf, this.replayEngine) : false;
    };
    const getCollectionFingerprint = async (p, coll) => {
      if (runner && typeof runner.getCollectionFingerprint === 'function') return runner.getCollectionFingerprint(p, coll);
      return this.gridAdapter ? this.gridAdapter.getCollectionFingerprint(p, coll) : null;
    };
    const detectAndFilterItems = async (p, disc, drop, filt) => {
      if (runner && typeof runner.detectAndFilterItems === 'function') return runner.detectAndFilterItems(p, disc, drop, filt);
      return this.detectAndFilterItems(p, disc, drop, filt);
    };
    const checkIfAlreadyDownloaded = (k, inv, flds, h) => {
      if (runner && typeof runner.checkIfAlreadyDownloaded === 'function') return runner.checkIfAlreadyDownloaded(k, inv, flds, h);
      return this.downloadManager ? this.downloadManager.checkIfAlreadyDownloaded(k, inv, flds, h) : { isDuplicate: false };
    };
    const writeLoopCheckpoint = (m, cItem, cAct, cPage, cPItem, active) => {
      if (runner && typeof runner.writeLoopCheckpoint === 'function') return runner.writeLoopCheckpoint(m, cItem, cAct, cPage, cPItem, active);
      if (this.stateCoordinator) this.stateCoordinator.writeLoopCheckpoint(m, cItem, cAct, cPage, cPItem, active);
    };

    while (true) {
      const currentPageUrl = page.url();
      if (currentPage < resumePage) {
        await advanceToNextPage(page, workflow);
        discovery = await ItemDiscovery.discover(page, targetStep.target || targetStep.fingerprint, { minItems: 1, minScore: 0.55 });
        currentPage++;
        manifest.pagesProcessed = currentPage;
        manifest.itemsTotal += discovery.itemCount;
        continue;
      }

      const effectiveFilter = (runner ? (runner.itemFilter || runner.rowFilter) : null) || (this.stateCoordinator ? (this.stateCoordinator.itemFilter || this.stateCoordinator.rowFilter) : null);
      const evaluatedItems = await detectAndFilterItems(page, discovery, isDropdown, effectiveFilter);
      const matchingItems = evaluatedItems.filter(it => it.matches);
      const skippedItems = evaluatedItems.filter(it => !it.matches);
      manifest.matchingCount = (manifest.matchingCount || 0) + matchingItems.length;
      manifest.matching = manifest.matchingCount;

      for (const skipped of skippedItems) {
        const skippedIndex = resumeItemIndex != null && currentPage === resumePage && skipped.index === resumePageItemIndex
          ? resumeItemIndex
          : manifest.results.reduce((max, r) => Math.max(max, Number(r.index) || 0), 0) + 1;
        const skippedResult = {
          index: skippedIndex,
          itemIndex: skipped.index,
          page: currentPage,
          label: skipped.itemIdentifier.itemLabel,
          itemKey: skipped.itemIdentifier.itemKey,
          status: 'SKIPPED_FILTER',
          skippedReason: skipped.reason,
          timestamp: new Date().toISOString()
        };
        manifest.results.push(skippedResult);
        manifest.skippedFilterCount = (manifest.skippedFilterCount || 0) + 1;
        manifest.skippedFilter = manifest.skippedFilterCount;
        manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
      }

      if ((runner && runner.rowFilter) || isDropdown) {
        logger.info(`[Loop Runner] Filter evaluation: ${matchingItems.length}/${evaluatedItems.length} matching item(s) (${skippedItems.length} filtered out). Iterating properly through matching items.`);
      }

      for (let m = 0; m < matchingItems.length; m++) {
        const targetItem = matchingItems[m];
        const i = targetItem.index;
        const itemIdentifier = targetItem.itemIdentifier;

        const isAborted = runner ? runner.isAborted : this.getIsAborted();
        if (isAborted) {
          manifest.status = 'STOPPED';
          writeLoopCheckpoint(manifest, null, 0, currentPage, i, null);
          break;
        }
        if (checkpoint && currentPage === resumePage && i < resumePageItemIndex) continue;

        logger.info(`\n[Loop Runner] --- Processing item [${m + 1}/${matchingItems.length}] (DOM index ${i + 1}: "${itemIdentifier.itemLabel}") ---`);

        const effectiveLimit = runner ? (runner.loopLimit || runner.maxItems) : (this.stateCoordinator ? (this.stateCoordinator.loopLimit || this.stateCoordinator.maxItems) : null);
        if (effectiveLimit && (manifest.selectedCount || 0) >= effectiveLimit) {
          const limitReason = `Beyond loop limit (${effectiveLimit})`;
          logger.info(`[Loop Runner] 🛑 Skipping item #${i + 1} ("${itemIdentifier.itemLabel}") — ${limitReason}`);
          if (runner) runner._limitReached = true;
          const skippedIndex = resumeItemIndex != null && currentPage === resumePage && i === resumePageItemIndex
            ? resumeItemIndex
            : manifest.results.reduce((max, r) => Math.max(max, Number(r.index) || 0), 0) + 1;
          const skippedResult = {
            index: skippedIndex,
            itemIndex: i,
            page: currentPage,
            label: itemIdentifier.itemLabel,
            itemKey: itemIdentifier.itemKey,
            status: 'SKIPPED_LIMIT',
            skippedReason: limitReason,
            timestamp: new Date().toISOString()
          };
          manifest.results.push(skippedResult);
          manifest.skippedLimitCount = (manifest.skippedLimitCount || 0) + 1;
          manifest.skippedLimit = manifest.skippedLimitCount;
          manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
          if (runner) runner.manifest = manifest;
          writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
          if (typeof onProgress === 'function') onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
          continue;
        }

        manifest.selectedCount = (manifest.selectedCount || 0) + 1;
        manifest.selected = manifest.selectedCount;
        const dedupe = checkIfAlreadyDownloaded(itemIdentifier.itemKey, itemIdentifier.invoiceNumber, targetItem.fields || {});

        const itemMode = runner ? runner.itemMode : (this.stateCoordinator ? this.stateCoordinator.itemMode : 'new');
        const forceRedownload = runner ? runner.forceRedownload : (this.downloadManager ? this.downloadManager.forceRedownload : false);

        if (itemMode === 'old' && !dedupe.isDuplicate && !dedupe.isOldData) {
          const skippedResult = {
            index: manifest.results.reduce((max, r) => Math.max(max, Number(r.index) || 0), 0) + 1,
            itemIndex: i,
            page: currentPage,
            label: itemIdentifier.itemLabel,
            itemKey: itemIdentifier.itemKey,
            status: 'SKIPPED_FILTER',
            skippedReason: 'New item (run mode is "old only")',
            timestamp: new Date().toISOString()
          };
          manifest.results.push(skippedResult);
          manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
          if (runner) runner.manifest = manifest;
          writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
          if (typeof onProgress === 'function') onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
          continue;
        }

        if (dedupe.isDuplicate && itemMode === 'new' && !forceRedownload) {
          logger.info(`[Loop Runner] Skipping item #${i + 1} ("${itemIdentifier.itemLabel}") — already downloaded: "${dedupe.record?.filename || 'existing'}"`);
          const skippedIndex = resumeItemIndex != null && currentPage === resumePage && i === resumePageItemIndex
            ? resumeItemIndex
            : manifest.results.reduce((max, r) => Math.max(max, Number(r.index) || 0), 0) + 1;
          const skippedResult = {
            index: skippedIndex,
            itemIndex: i,
            page: currentPage,
            label: itemIdentifier.itemLabel,
            itemKey: itemIdentifier.itemKey,
            status: 'SKIPPED_DUPLICATE',
            skippedReason: dedupe.inFolder ? `Already in download folder: ${dedupe.record?.filename || 'file'}` : `Already downloaded: ${dedupe.record?.filename || 'file'}`,
            existingFile: dedupe.record?.filePath || null,
            downloadedFiles: dedupe.record?.filePath ? [{ filename: dedupe.record.filename, path: path.resolve(process.cwd(), dedupe.record.filePath), relativePath: dedupe.record.filePath, sizeBytes: dedupe.record.fileSizeBytes || 0, skipped: true }] : [],
            timestamp: new Date().toISOString()
          };
          manifest.results.push(skippedResult);
          manifest.skippedDuplicateCount = (manifest.skippedDuplicateCount || 0) + 1;
          manifest.skippedDuplicate = manifest.skippedDuplicateCount;
          manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
          if (runner) runner.manifest = manifest;
          writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
          const runsDir = runner ? runner.runsDir : (this.downloadManager ? this.downloadManager.runsDir : null);
          if (runsDir) {
            try { fs.writeFileSync(path.join(runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
          }
          if (typeof onProgress === 'function') onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
          continue;
        }

        const itemExec = await this.executeItemAttempt({
          page, discovery, i, targetItem, itemIdentifier, generalizedActions, effectiveLoopStepIndex,
          isDropdown, triggerStep, partition, currentPageUrl, initialPageUrls, currentPage,
          manifest, checkpoint, resumePage, resumePageItemIndex, resumeActionOffset, resumeItemIndex,
          onProgress, runner
        });
        if (itemExec?.stopped) break;
      }

      if (!paginationEnabled || currentPage >= maxPages || (runner && runner._limitReached)) break;
      const beforePageFingerprint = await getCollectionFingerprint(page, discovery.collection);
      if (!await advanceToNextPage(page, workflow)) { logger.info('[Loop Runner] Pagination complete.'); break; }

      const nextDiscovery = await ItemDiscovery.discover(page, targetStep.target || targetStep.fingerprint, { minItems: 1, minScore: 0.55 });
      if (!nextDiscovery.success || nextDiscovery.itemCount < 1) break;

      const afterPageFingerprint = await getCollectionFingerprint(page, nextDiscovery.collection);
      if (beforePageFingerprint && afterPageFingerprint && beforePageFingerprint === afterPageFingerprint) break;

      discovery = nextDiscovery;
      manifest.itemsTotal += discovery.itemCount;
      manifest.pagesProcessed = currentPage + 1;
      currentPage++;
      writeLoopCheckpoint(manifest, null, null, currentPage, null, null);
      if (typeof onProgress === 'function') onProgress({ status: 'PAGE_COMPLETE', page: currentPage, manifest, discovery });
    }
  }

  /**
   * Executes linear standard workflow actions sequentially with download capture
   */
  async executeStandardSteps({ page, steps, manifest, onProgress, runner }) {
    const replayEngine = runner?.replayEngine || this.replayEngine;
    const isAborted = () => (runner ? runner.isAborted : this.getIsAborted());
    let startIndex = 0;
    const loginSeq = detectLoginSequence(steps);
    if (loginSeq.hasLoginSequence && await isSessionAuthenticated(page, loginSeq)) {
      logger.info(`[Runner] Session authenticated. Skipping ${loginSeq.loginActionCount} login steps.`);
      for (let s = loginSeq.startIndex; s <= loginSeq.endIndex; s++) {
        const skipResult = { stepIndex: s + 1, type: steps[s].type || 'CLICK', status: 'SKIPPED', reason: 'SESSION_ALREADY_AUTHENTICATED' };
        manifest.itemsSkipped++; manifest.results.push(skipResult);
        if (typeof onProgress === 'function') onProgress({ status: 'STEP_COMPLETE', stepResult: skipResult, manifest });
      }
      startIndex = loginSeq.firstPostLoginIndex;
    }

    const runsDir = runner ? runner.runsDir : (this.downloadManager ? this.downloadManager.runsDir : null);
    const downloadsDir = runner ? runner.downloadsDir : (this.downloadManager ? this.downloadManager.downloadsDir : null);

    const snapshotDownloadedFiles = () => {
      if (runner && typeof runner.snapshotDownloadedFiles === 'function') return runner.snapshotDownloadedFiles();
      return this.downloadManager ? this.downloadManager.snapshotDownloadedFiles() : [];
    };
    const waitForDownload = (snap, timeout) => {
      if (runner && typeof runner.waitForDownload === 'function') return runner.waitForDownload(snap, timeout);
      return this.downloadManager ? this.downloadManager.waitForDownload(snap, timeout) : [];
    };
    const processAndStoreDownload = (src, key, lbl, flds) => {
      if (runner && typeof runner.processAndStoreDownload === 'function') return runner.processAndStoreDownload(src, key, lbl, flds);
      return this.downloadManager ? this.downloadManager.processAndStoreDownload(src, key, lbl, flds) : null;
    };

    for (let i = startIndex; i < steps.length; i++) {
      if (isAborted()) { manifest.status = 'STOPPED'; break; }
      const step = steps[i];
      if (i > 0 && step.timeDeltaMs > 600) {
        const end = Date.now() + Math.min(step.timeDeltaMs, 15000);
        while (Date.now() < end && !isAborted()) await new Promise(r => setTimeout(r, 100));
      }
      if (isAborted()) { manifest.status = 'STOPPED'; break; }

      const beforeFiles = snapshotDownloadedFiles();
      const stepResult = { stepIndex: i + 1, type: step.type || 'CLICK', status: 'PENDING', startTime: new Date().toISOString() };
      try {
        if (replayEngine) await replayEngine.executeAction(step, i);
        stepResult.status = 'SUCCESS';
        manifest.itemsSucceeded++;
        if ((step.type || 'CLICK') === 'CLICK' && downloadsDir) {
          const isDl = ItemExecutionHandler.isDownloadPotentialAction(step);
          const downloadWaitMs = isDl
            ? (this.downloadTimeoutMs || 12000)
            : (this.defaultClickWaitMs || 2500);
          const downloaded = await waitForDownload(beforeFiles, downloadWaitMs);
          if (downloaded.length) {
            stepResult.downloadedFiles = downloaded.map(dl => processAndStoreDownload(dl.path, `step_${i + 1}`, `Step #${i + 1}`) || dl);
          }
        }
      } catch (err) {
        if (isAborted()) { stepResult.status = 'STOPPED'; manifest.status = 'STOPPED'; manifest.results.push(stepResult); break; }
        stepResult.status = 'FAILED'; stepResult.error = err.message; manifest.itemsFailed++;
      }
      stepResult.endTime = new Date().toISOString();
      manifest.results.push(stepResult);
      if (runsDir) {
        try { fs.writeFileSync(path.join(runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch {}
      }
      if (typeof onProgress === 'function') onProgress({ status: 'STEP_COMPLETE', stepResult, manifest });
    }
  }
}

module.exports = ItemExecutionHandler;
