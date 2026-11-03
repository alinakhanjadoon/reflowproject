/**
 * src/replay/loop/grid-selection-adapter.js
 * Implements Selection Strategy patterns for ExtJS, AG-Grid, DevExpress,
 * standard HTML tables, ARIA grids, Angular Material dropdowns, and pagination controls.
 */

const ItemDiscovery = require('../../shared/item-discovery');
const logger = require('../../utils/logger');

class GridSelectionAdapter {
  constructor(options = {}) {
    this.replayEngine = options.replayEngine || null;
  }

  /**
   * Checks whether the discovered collection/table is still present and accessible in the DOM.
   */
  async isCollectionPresent(page, discovery) {
    if (!page || !discovery || !discovery.collection) return false;
    try {
      if (typeof page.isClosed === 'function' && page.isClosed()) return false;

      // 1. In ExtJS, check if any rendered/visible grid exists with rows
      const hasExtGrid = await page.evaluate(() => {
        if (window.Ext && window.Ext.ComponentQuery) {
          try {
            const grids = window.Ext.ComponentQuery.query('grid, gridpanel');
            return grids.some(g => {
              if (!g.rendered || !g.isVisible || !g.isVisible()) return false;
              const el = g.getEl && g.getEl().dom;
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' &&
                rect.width > 50 && rect.height > 50 && rect.top > -500 && rect.left > -500 &&
                g.getStore && g.getStore() && g.getStore().getCount() > 0;
            });
          } catch (e) {
            return false;
          }
        }
        return false;
      }).catch(() => false);
      if (hasExtGrid) return true;

      // 2. Direct page check: see if collection container exists and is visible in main page DOM without traversing child frames
      const selector = discovery.collection.ancestorSelector || discovery.collection.containerSelector || '.x-grid, [role="grid"], table tbody';
      const existsInMainPage = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20 && rect.top > -500 && rect.left > -500;
      }, selector).catch(() => false);
      if (existsInMainPage) return true;

      // 3. Safe handle fallback across frames
      const handle = await ItemDiscovery.getItemHandle(page, discovery, 0).catch(() => null);
      const el = handle ? handle.asElement() : null;
      if (el) {
        const isElVisible = await el.evaluate(node => {
          if (!node || !node.isConnected) return false;
          const s = window.getComputedStyle(node);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          const r = node.getBoundingClientRect();
          return r.width > 5 && r.height > 5 && r.top > -500 && r.left > -500;
        }).catch(() => false);
        if (typeof el.dispose === 'function') await el.dispose().catch(() => { });
        if (isElVisible) return true;
      }
      if (handle && typeof handle.dispose === 'function') await handle.dispose().catch(() => { });
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Clears any active row selections in ExtJS, AG-Grid, or standard HTML tables
   * to ensure sequential 1-by-1 iteration without multi-selection accumulation.
   */
  async clearGridSelections(page, discovery) {
    if (!page) return;
    try {
      if (typeof page.isClosed === 'function' && page.isClosed()) return;
      await page.evaluate(() => {
        // 1. ExtJS Component API: deselectAll on all rendered/visible grids
        if (window.Ext && window.Ext.ComponentQuery) {
          try {
            const grids = window.Ext.ComponentQuery.query('grid, gridpanel');
            for (const grid of grids) {
              const sm = grid.getSelectionModel && grid.getSelectionModel();
              if (sm && typeof sm.deselectAll === 'function') {
                sm.deselectAll();
              }
            }
          } catch (e) {}
        }

        // 2. DOM-based deselect: cleanly remove selection classes and attributes
        // NEVER synthesize blind DOM .click() events which trigger cascading application events!
        const selectedRows = Array.from(document.querySelectorAll(
          '.x-grid-item-selected, .x-grid-row-selected, tr.selected, [aria-selected="true"]'
        ));

        for (const row of selectedRows) {
          row.classList.remove('x-grid-item-selected', 'x-grid-row-selected', 'selected');
          row.removeAttribute('aria-selected');
          const innerCheckboxes = row.querySelectorAll('input[type="checkbox"]:checked');
          for (const cb of innerCheckboxes) {
            cb.checked = false;
          }
        }

        // 3. Header select-all checker deselect without blind click
        const headerCheckers = document.querySelectorAll('.x-grid-hd-checker-on, .x-column-header-checkbox.x-grid-hd-checker-on');
        for (const hc of headerCheckers) {
          hc.classList.remove('x-grid-hd-checker-on');
        }
      });
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      logger.warn(`[GridSelectionAdapter] clearGridSelections note: ${err.message}`);
    }
  }

  /**
   * Enforces that ONLY the target row index is selected, and all other rows are deselected.
   */
  async enforceGridRowSingleSelection(page, discovery, targetIndex) {
    if (!page) return;
    try {
      if (typeof page.isClosed === 'function' && page.isClosed()) return;
      await page.evaluate((targetIdx) => {
        // 1. ExtJS Component API: select targetIdx on the active/visible grid
        if (window.Ext && window.Ext.ComponentQuery) {
          try {
            const grids = window.Ext.ComponentQuery.query('grid, gridpanel');
            const visibleGrids = grids.filter(g => {
              if (!g.rendered || !g.isVisible || !g.isVisible()) return false;
              const el = g.getEl && g.getEl().dom;
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' &&
                rect.width > 50 && rect.height > 50 && rect.top > -500 && rect.left > -500;
            });

            for (const grid of visibleGrids) {
              const sm = grid.getSelectionModel && grid.getSelectionModel();
              if (sm && typeof sm.select === 'function') {
                sm.deselectAll();
                sm.select(targetIdx);
                return;
              }
            }
          } catch (e) {}
        }

        // 2. DOM-based selection for standard HTML tables / ARIA grids:
        const gridBody = document.querySelector('.x-grid-body, [role="grid"], table tbody') || document;
        // Collect DISTINCT row elements (do not mix table.x-grid-item and tr.x-grid-row)
        let rows = Array.from(gridBody.querySelectorAll('table.x-grid-item')).filter(r => {
          const rect = r.getBoundingClientRect();
          const style = window.getComputedStyle(r);
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.top > -500;
        });
        if (!rows.length) {
          rows = Array.from(gridBody.querySelectorAll('tbody > tr:not(.x-grid-row-before), [role="row"]')).filter(r => {
            if (r.closest('thead, .x-grid-header-ct')) return false;
            const rect = r.getBoundingClientRect();
            const style = window.getComputedStyle(r);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.top > -500;
          });
        }

        const targetRow = rows[targetIdx];
        if (targetRow) {
          const isSelected = targetRow.classList.contains('x-grid-item-selected') ||
            targetRow.classList.contains('x-grid-row-selected') ||
            targetRow.getAttribute('aria-selected') === 'true' ||
            targetRow.querySelector('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]');

          if (!isSelected) {
            const checker = targetRow.querySelector('.x-grid-row-checker, input[type="checkbox"], [role="checkbox"]');
            if (checker) checker.click();
            else targetRow.click();
          }
        }

        // Deselect any other row cleanly without synthetic clicks
        rows.forEach((r, idx) => {
          if (idx !== targetIdx) {
            r.classList.remove('x-grid-item-selected', 'x-grid-row-selected', 'selected');
            r.removeAttribute('aria-selected');
            const innerCbs = r.querySelectorAll('input[type="checkbox"]:checked');
            for (const cb of innerCbs) {
              cb.checked = false;
            }
          }
        });
      }, targetIndex);
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      logger.warn(`[GridSelectionAdapter] enforceGridRowSingleSelection note: ${err.message}`);
    }
  }

  isDropdownOptionCollection(collection, items = []) {
    if (!collection) return false;
    const tag = String(collection.itemTag || '').toLowerCase();
    if (tag === 'mat-option' || tag === 'option') return true;
    if (collection.ancestorTag === 'mat-select' || collection.ancestorTag === 'select') return true;
    if (collection.ancestorSelector && /cdk-overlay|listbox|mat-select/i.test(collection.ancestorSelector)) return true;
    if (Array.isArray(items) && items.some(it => it.tagName === 'mat-option' || it.tagName === 'option')) return true;
    return false;
  }

  async ensureDropdownOpen(page, triggerStep = null, replayEngine = null) {
    const engine = replayEngine || this.replayEngine;
    const isOpen = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('mat-option, [role="option"]'));
      const visible = el => {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return options.some(visible);
    }).catch(() => false);

    if (isOpen) return true;

    logger.info('[GridSelectionAdapter] Dropdown overlay closed. Reopening dropdown for next option...');

    if (triggerStep && engine) {
      try {
        await engine.executeAction(triggerStep);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.warn(`[GridSelectionAdapter] Trigger step replay note: ${err.message}`);
      }
    }

    const stillClosed = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('mat-option, [role="option"]'));
      const visible = el => {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return !options.some(visible);
    }).catch(() => true);

    if (stillClosed) {
      const selectHandle = await page.$('mat-select .mat-mdc-select-trigger, mat-select .mat-mdc-select-value, mat-select, [role="combobox"]').catch(() => null);
      if (selectHandle) {
        try {
          if (engine && typeof engine._setAutomatedAction === 'function') {
            await engine._setAutomatedAction(true, selectHandle);
          }
          await selectHandle.click();
          await new Promise(r => setTimeout(r, 600));
        } finally {
          if (engine && typeof engine._setAutomatedAction === 'function') {
            await engine._setAutomatedAction(false);
          }
          await selectHandle.dispose().catch(() => { });
        }
      }
    }

    const started = Date.now();
    while (Date.now() - started < 3000) {
      const ready = await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('mat-option, [role="option"]'));
        return options.some(el => el.getBoundingClientRect().height > 0);
      }).catch(() => false);
      if (ready) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  async executeDropdownOptionSingleSelect(page, targetIndex, targetText = '') {
    return page.evaluate((targetIdx, expectedText) => {
      const visible = el => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const isOptionSelected = opt => {
        if (!opt) return false;
        if (opt.getAttribute('aria-selected') === 'true') return true;
        if (opt.classList.contains('mat-mdc-option-selected') || opt.classList.contains('mat-selected')) return true;
        const cb = opt.querySelector('.mat-pseudo-checkbox-checked, input[type="checkbox"]:checked');
        return Boolean(cb);
      };

      const cleanText = (str) => String(str || '').replace(/\s+/g, ' ').trim();

      const options = Array.from(document.querySelectorAll('mat-option, [role="option"], select option')).filter(visible);
      if (!options.length) {
        return { success: false, reason: 'No visible dropdown options found' };
      }

      // 1. Locate target option: prefer expectedText match if given, otherwise targetIdx
      let targetOpt = null;
      if (expectedText) {
        const norm = cleanText(expectedText).toLowerCase();
        targetOpt = options.find(o => cleanText(o.textContent).toLowerCase() === norm);
        if (!targetOpt) {
          targetOpt = options.find(o => {
            const t = cleanText(o.textContent).toLowerCase();
            return t && !/select\s*all/i.test(t) && (t.includes(norm) || norm.includes(t));
          });
        }
      }
      if (!targetOpt && targetIdx >= 0 && targetIdx < options.length) {
        targetOpt = options[targetIdx];
      }

      if (!targetOpt) {
        return {
          success: false,
          reason: `Target option not found (index: ${targetIdx}, text: "${expectedText}")`,
          totalOptions: options.length
        };
      }

      const actionsDone = [];

      // 2. Check if target option is already selected AND no other option is selected
      const selectAllOpt = options.find(o => /select\s*all/i.test(cleanText(o.textContent)));
      const otherSelected = options.filter(o => o !== targetOpt && isOptionSelected(o));

      if (isOptionSelected(targetOpt) && otherSelected.length === 0) {
        return {
          success: true,
          targetIndex: options.indexOf(targetOpt),
          targetText: cleanText(targetOpt.textContent).slice(0, 80),
          alreadySelected: true,
          actionsDone
        };
      }

      // 3. Handle "Select All" checkbox if present and currently checked
      if (selectAllOpt && selectAllOpt !== targetOpt && isOptionSelected(selectAllOpt)) {
        if (selectAllOpt.scrollIntoView) selectAllOpt.scrollIntoView({ block: 'nearest' });
        selectAllOpt.click();
        actionsDone.push({ action: 'UNCHECK_SELECT_ALL', text: cleanText(selectAllOpt.textContent).slice(0, 40) });
      }

      // 4. Safely uncheck any OTHER option that is currently selected (e.g. from previous loop item)
      // Never click unselected options!
      for (let idx = 0; idx < options.length; idx++) {
        const opt = options[idx];
        if (opt !== targetOpt && opt !== selectAllOpt && isOptionSelected(opt)) {
          if (opt.scrollIntoView) opt.scrollIntoView({ block: 'nearest' });
          opt.click();
          actionsDone.push({ action: 'UNCHECK', index: idx, text: cleanText(opt.textContent).slice(0, 40) });
        }
      }

      // 5. Click target option to select it
      if (!isOptionSelected(targetOpt)) {
        if (targetOpt.scrollIntoView) targetOpt.scrollIntoView({ block: 'nearest' });
        targetOpt.click();
        actionsDone.push({ action: 'CHECK', index: options.indexOf(targetOpt), text: cleanText(targetOpt.textContent).slice(0, 40) });
      }

      const targetIsNowSelected = isOptionSelected(targetOpt);
      return {
        success: targetIsNowSelected || actionsDone.some(a => a.action === 'CHECK'),
        targetIndex: options.indexOf(targetOpt),
        targetText: cleanText(targetOpt.textContent).slice(0, 80),
        totalOptions: options.length,
        actionsDone
      };
    }, targetIndex, targetText);
  }

  async findNextPageTarget(page, workflow = {}) {
    const explicitSelector = workflow.pagination && workflow.pagination.nextSelector;
    return page.evaluateHandle((selector) => {
      const visible = el => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const disabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');

      if (selector) {
        const el = document.querySelector(selector);
        return el && visible(el) && !disabled(el) ? el : null;
      }

      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-label]'))
        .filter(el => visible(el) && !disabled(el));

      const scored = candidates.map(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const title = (el.getAttribute('title') || '').trim().toLowerCase();
        const combined = [text, aria, title].join(' ');
        let score = 0;
        if (/^next(?: page)?$/.test(text)) score += 8;
        if (/next(?: page)?/.test(aria)) score += 7;
        if (/next(?: page)?/.test(title)) score += 5;
        if (/^›$|^»$|^>$/.test(text)) score += 4;
        if (/pagination|pager/.test(combined)) score += 2;
        if (/previous|back|first|last/.test(combined) && !/next/.test(combined)) score -= 5;
        return { el, score };
      }).filter(x => x.score >= 5).sort((a, b) => b.score - a.score);

      return scored.length ? scored[0].el : null;
    }, explicitSelector);
  }

  async getCollectionFingerprint(page, collection) {
    if (!collection) return '';
    return page.evaluate((meta) => {
      const visible = el => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const ancestors = Array.from(document.querySelectorAll(meta.ancestorTag || '*')).filter(visible);
      for (const ancestor of ancestors) {
        const items = Array.from(ancestor.children).filter(child =>
          visible(child) &&
          child.tagName.toLowerCase() === meta.itemTag
        );
        if (items.length) {
          return items.slice(0, 5).map(item => normalize(item.textContent)).join('||');
        }
      }
      return '';
    }, collection).catch(() => '');
  }

  async advanceToNextPage(page, workflow = {}, replayEngine = null) {
    const engine = replayEngine || this.replayEngine;
    const beforeUrl = page.url();
    const handle = await this.findNextPageTarget(page, workflow);
    const element = handle && handle.asElement();
    if (!element) {
      if (handle) await handle.dispose().catch(() => { });
      return false;
    }

    try {
      if (engine && typeof engine._setAutomatedAction === 'function') {
        await engine._setAutomatedAction(true, element);
      }
      await element.scrollIntoViewIfNeeded().catch(() => { });
      await element.click();
    } finally {
      if (engine && typeof engine._setAutomatedAction === 'function') {
        await engine._setAutomatedAction(false);
      }
      await element.dispose().catch(() => { });
    }

    const timeout = Number.isInteger(workflow.pagination?.waitTimeoutMs)
      ? Math.max(1000, workflow.pagination.waitTimeoutMs)
      : 10000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      await new Promise(r => setTimeout(r, 250));
      if (page.url() !== beforeUrl) return true;
      const state = await page.evaluate(() => document.readyState).catch(() => 'loading');
      if (state === 'complete' || state === 'interactive') {
        // Give AJAX/virtualized grids a little time to replace their rows.
        await new Promise(r => setTimeout(r, 750));
        return true;
      }
    }
    return true;
  }
}

module.exports = GridSelectionAdapter;
