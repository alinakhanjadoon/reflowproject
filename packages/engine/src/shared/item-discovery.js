/**
 * ReFlow — Deterministic Item Discovery
 *
 * Finds repeated records on the current page from the element the user
 * interacted with during recording. This module is intentionally independent
 * from replay execution so discovery can be tested and evolved separately.
 */

class ItemDiscovery {
  /**
   * Discover a repeated collection around a recorded target.
   *
   * The browser-side portion deliberately uses structural evidence instead of
   * relying only on nth-child selectors. It returns diagnostics suitable for
   * showing the user before batch execution.
   *
   * @param {import('puppeteer-core').Page} page
   * @param {object} target Recorded target/fingerprint
   * @param {object} options Discovery options
   * @returns {Promise<object>}
   */
  static async discover(page, target, options = {}) {
    if (!page) throw new Error('ItemDiscovery.discover requires a Puppeteer page.');
    if (!target) return { success: false, reason: 'No recorded target supplied.' };
    if (target.role === 'SETUP' || target.isNavigationOrChrome === true) {
      return { success: false, reason: 'Target element belongs to site navigation or setup controls.' };
    }

    const minItems = Number.isInteger(options.minItems) ? options.minItems : 2;
    const minScore = typeof options.minScore === 'number' ? options.minScore : 0.55;

    return page.evaluate(({ target, minItems, minScore }) => {
      const visible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0;
      };

      const isNavOrChrome = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const tag = el.tagName.toLowerCase();
        if (['nav', 'header', 'footer', 'mat-toolbar', 'mat-toolbar-row', 'mat-tab-header', 'mat-tab-group', 'mat-tab-nav-bar', 'mat-tab-link', 'mat-sidenav', 'mat-sidenav-container', 'app-header', 'app-nav'].includes(tag)) {
          return true;
        }
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (['navigation', 'menubar', 'tablist', 'tab', 'banner', 'contentinfo', 'toolbar', 'breadcrumb', 'pagination'].includes(role)) {
          return true;
        }
        const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if (/\b(navbar|nav-tabs|nav-item|nav-link|top-bar|app-bar|sidebar-nav|site-header|main-nav|page-header|pager|header-nav|menu-item|menu-link|i21-menu-link)\b/i.test(className)) {
          return true;
        }
        if (el.id && /(^|#|\b)menu-\d+/i.test(el.id)) {
          return true;
        }
        try {
          if (el.closest('nav, header, footer, mat-toolbar, mat-toolbar-row, mat-tab-header, mat-tab-nav-bar, [role="navigation"], [role="tablist"], [role="menubar"], [role="toolbar"], .navbar, .top-bar, .x-menu, .sidebar')) {
            return true;
          }
        } catch {}
        return false;
      };

      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const tokenSet = (value) => new Set(
        normalize(value).split(/[^a-z0-9_#-]+/).filter(Boolean)
      );

      const similarity = (a, b) => {
        const aa = tokenSet(a);
        const bb = tokenSet(b);
        if (!aa.size && !bb.size) return 1;
        if (!aa.size || !bb.size) return 0;
        let intersection = 0;
        for (const token of aa) if (bb.has(token)) intersection++;
        return intersection / Math.max(aa.size, bb.size);
      };

      const structuralSignature = (el) => {
        const children = Array.from(el.children).slice(0, 12)
          .map(child => child.tagName.toLowerCase())
          .join('>');
        return [
          el.tagName.toLowerCase(),
          children,
          el.getAttribute('role') || '',
          (el.getAttribute('data-testid') || '').replace(/\d+/g, '#').replace(/[0-9a-f]{8,}/gi, '#'),
          (el.getAttribute('data-qa') || '').replace(/\d+/g, '#').replace(/[0-9a-f]{8,}/gi, '#')
        ].join('|');
      };

      const stableClasses = (el) => Array.from(el.classList || [])
        .filter(c => c && !/(active|focus|hover|selected|disabled|loading|open|ng-|cdk-|mat-)/i.test(c))
        .map(c => c.replace(/\d+/g, '#'))
        .slice(0, 8)
        .join(' ');

      let recorded = null;

      // Prefer the project's resolver when it is already injected.
      try {
        if (window.SelectorResolver && typeof window.SelectorResolver.resolveElement === 'function') {
          const resolved = window.SelectorResolver.resolveElement(target);
          if (resolved && resolved.success) recorded = resolved.element;
        }
      } catch {}

      // Safe fallback for recorded candidates (CSS & XPath)
      if (!recorded) {
        const candidates = target.candidates || target.selectors?.candidates || [];
        for (const candidate of candidates) {
          if (!candidate || !candidate.value) continue;
          try {
            const val = String(candidate.value).trim();
            if (val.startsWith('/') || val.startsWith('(') || candidate.strategy === 'xpath') {
              const iterator = document.evaluate(val, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
              let node = iterator.iterateNext();
              let firstNonNav = null;
              while (node) {
                if (visible(node)) {
                  if (!isNavOrChrome(node)) {
                    firstNonNav = node;
                    break;
                  }
                  if (!recorded) recorded = node;
                }
                node = iterator.iterateNext();
              }
              if (firstNonNav) {
                recorded = firstNonNav;
                break;
              }
            } else {
              let matches = Array.from(document.querySelectorAll(val)).filter(visible);
              // When multiple matches exist across different modal/dialog containers,
              // prioritize the elements residing in the topmost active modal
              if (matches.length > 1) {
                const getZ = (el) => {
                  const cs = window.getComputedStyle(el);
                  const z = parseInt(cs.zIndex, 10);
                  return isNaN(z) ? 0 : z;
                };
                const modalSelectors = [
                  '.x-window:not(.x-hidden):not(.x-hidden-offsets)',
                  '[role="dialog"]:not([aria-hidden="true"])',
                  'dialog[open]',
                  '.modal.show',
                  '.modal.in',
                  '.modal:not([aria-hidden="true"])',
                  '.ui-dialog:not([style*="display: none"])',
                  '.dx-dialog',
                  '.ant-modal:not(.ant-modal-hidden)'
                ];
                const allModals = Array.from(document.querySelectorAll(modalSelectors.join(', '))).filter(visible);
                if (allModals.length > 0) {
                  allModals.sort((a, b) => getZ(b) - getZ(a));
                  const topModal = allModals[0];
                  const inTopModal = matches.filter(el => topModal.contains(el));
                  if (inTopModal.length > 0) {
                    matches = inTopModal;
                  }
                }
              }
              const nonNav = matches.find(el => !isNavOrChrome(el));
              if (nonNav) {
                recorded = nonNav;
                break;
              } else if (matches.length && !recorded) {
                recorded = matches[0];
              }
            }
          } catch {}
        }
      }

      // Additional fallback: resolve by ID or tag name + text content
      if (!recorded && target.fingerprint) {
        const fp = target.fingerprint;
        if (fp.id) {
          try {
            const el = document.getElementById(fp.id);
            if (visible(el)) recorded = el;
          } catch {}
        }
        if (!recorded && fp.tagName && fp.text) {
          try {
            const normTargetText = normalize(fp.text).slice(0, 40);
            if (normTargetText) {
              const tagElements = Array.from(document.querySelectorAll(fp.tagName)).filter(visible);
              const found = tagElements.find(el => normalize(el.innerText).includes(normTargetText));
              if (found) recorded = found;
            }
          } catch {}
        }
      }

      if (!recorded) {
        return {
          success: false,
          reason: 'Recorded target could not be resolved on the current page.'
        };
      }

      // Check if recorded target itself is navigation or toolbar chrome
      if (isNavOrChrome(recorded)) {
        return {
          success: false,
          reason: 'Recorded element belongs to site navigation or chrome toolbar.'
        };
      }

      const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾▲▴+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B2\u25B4\u25B8\u25BE\u276F\u203A\s]+$/i;
      const DOCUMENT_ID_REGEX = /\b((?:SI|INV|DR|TX|CM|PO|SO|BILL|REC|ORD)-\d+(?:[-_]\w+)*|\b\d{4,10}\b)/i;

      const cleanCellText = (val) => {
        if (val == null) return '';
        let s = String(val).trim().replace(/\s+/g, ' ');
        if (EXPANDER_GLYPH_REGEX.test(s)) return '';
        s = s.replace(/^[▸►▶▼▽▾▲▴+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B2\u25B4\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
        s = s.replace(/[▸►▶▼▽▾▲▴+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B2\u25B4\u25B8\u25BE\u276F\u203A\s]+$/, '').trim();
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

      const buildAncestorSelector = (el) => {
        if (!el) return '';
        if (el.id) return `#${el.id}`;
        const parent = el.parentElement;
        if (parent && parent.id) return `#${parent.id} ${el.tagName.toLowerCase()}`;
        return el.tagName.toLowerCase();
      };

      const recordedParent = recorded.parentElement;
      const ancestors = [];
      let current = recordedParent;

      while (current && current !== document.body) {
        ancestors.push(current);
        current = current.parentElement;
      }

      const candidates = [];

      for (const ancestor of ancestors) {
        if (isNavOrChrome(ancestor)) continue;

        // Table rows (<tr> / [role="row"]) contain table cells (columns), NOT repeating records.
        const ancTag = ancestor.tagName.toLowerCase();
        const ancRole = (ancestor.getAttribute('role') || '').toLowerCase();
        if (ancTag === 'tr' || ancRole === 'row' || ancestor.classList?.contains('x-grid-row')) {
          continue;
        }

        const children = Array.from(ancestor.children).filter(visible);
        if (children.length < minItems) continue;

        // Identify which direct child of this ancestor contains the recorded element
        const itemForRecorded = children.find(child => child === recorded || child.contains(recorded));
        if (!itemForRecorded) continue;
        if (isNavOrChrome(itemForRecorded)) continue;

        const itemTagLower = itemForRecorded.tagName.toLowerCase();
        const itemRole = (itemForRecorded.getAttribute('role') || '').toLowerCase();

        // Table cells (<td> / <th> / [role="gridcell"]) are columns within a row, NOT collection items.
        if (itemTagLower === 'td' || itemTagLower === 'th' || itemRole === 'gridcell' || itemForRecorded.classList?.contains('x-grid-cell')) {
          continue;
        }

        const sameTag = children.filter(child =>
          child.tagName === itemForRecorded.tagName
        );

        const siblingSet = sameTag.length >= minItems ? sameTag : children;
        if (siblingSet.length < minItems) continue;

        const itemSignature = structuralSignature(itemForRecorded);
        const itemClasses = stableClasses(itemForRecorded);

        const matching = siblingSet.filter(child => {
          const structureScore = child === itemForRecorded
            ? 1
            : similarity(structuralSignature(child), itemSignature);
          const classScore = similarity(stableClasses(child), itemClasses);
          return (structureScore * 0.75 + classScore * 0.25) >= minScore;
        });

        if (matching.length < minItems) continue;

        // Anchor Containment Validation:
        // Ensure discovered candidate items actually contain the recorded anchor element or its equivalent
        let anchorContainmentRatio = 1;
        if (recorded && recorded !== itemForRecorded) {
          const recTag = recorded.tagName.toLowerCase();
          const recRole = (recorded.getAttribute('role') || '').toLowerCase();
          let countWithAnchorEquivalent = 0;
          for (const child of matching) {
            if (child === itemForRecorded) {
              countWithAnchorEquivalent++;
              continue;
            }
            const hasEq = (recRole && child.querySelector(`[role="${recRole}"]`)) ||
              (recTag && child.querySelector(recTag));
            if (hasEq) countWithAnchorEquivalent++;
          }
          anchorContainmentRatio = countWithAnchorEquivalent / Math.max(1, matching.length);
        }
        if (anchorContainmentRatio < 0.5) continue;

        // 1. Detect if any sibling is a table header row/table and extract headerColumns & full layout
        let headerColumns = [];
        let rawHeaderLayout = [];
        const isHeaderItem = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === 'thead' || el.closest('thead')) return true;
          const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
          if (/\b(header|thead|column-header|grid-header|header-row)\b/i.test(cls)) return true;
          const ths = el.querySelectorAll('th, [role="columnheader"]');
          const tds = el.querySelectorAll('td, [role="gridcell"]');
          if (ths.length > 0 && tds.length === 0) return true;
          const isRow = tag === 'tr' || el.getAttribute('role') === 'row' || (el.classList && el.classList.contains('x-grid-row'));
          if (isRow && el === el.parentElement?.firstElementChild && (ths.length > 0 || tds.length >= 2)) {
            const hasLinksOrInputs = el.querySelector('a[href], button, input[type="button"], input[type="submit"]');
            if (hasLinksOrInputs) return false;
            const rowText = (el.innerText || el.textContent || '').trim();
            const isDataLike = /\b((?:SI|INV|DR|TX|CM|PO|SO|BILL|REC|ORD)-\d+|\b\d{4,10}\b|\$\s*\d|\d{4}-\d{2}-\d{2})\b/i.test(rowText);
            if (isDataLike) return false;

            const nextRow = el.nextElementSibling;
            const nextRowHasLinks = nextRow?.querySelector('a[href], button, input');
            const hasBold = Array.from(tds).some(c => {
              if (c.querySelector('b, strong, th')) return true;
              try {
                const fw = window.getComputedStyle ? window.getComputedStyle(c).fontWeight : null;
                return fw >= 600 || fw === 'bold';
              } catch { return false; }
            });
            const nextTds = nextRow ? Array.from(nextRow.querySelectorAll('td, [role="gridcell"]')) : [];
            const nextRowHasBold = nextTds.some(c => {
              if (c.querySelector('b, strong, th')) return true;
              try {
                const fw = window.getComputedStyle ? window.getComputedStyle(c).fontWeight : null;
                return fw >= 600 || fw === 'bold';
              } catch { return false; }
            });

            if (nextRowHasLinks || (hasBold && !nextRowHasBold)) {
              return true;
            }
          }
          return false;
        };

        // Try extracting headers from explicit header row or parent grid header
        const explicitHeader = siblingSet.find(isHeaderItem);
        if (explicitHeader) {
          const hCellNodes = Array.from(explicitHeader.querySelectorAll('th, [role="columnheader"], td, .x-column-header'));
          rawHeaderLayout = hCellNodes.map(c => cleanCellText(c.innerText || c.textContent || ''));
          const hCells = rawHeaderLayout.filter(t => t.length > 0 && t.length < 60 && !EXPANDER_GLYPH_REGEX.test(t));
          if (hCells.length > 0) {
            headerColumns = Array.from(new Set(hCells));
          }
        }

        // Also check parent grid / table container for header elements (scoped strictly to item's container)
        const gridContainer = itemForRecorded.parentElement?.closest('.x-grid, [role="grid"], .data-table, .grid-container, table, .dxgvTable, [role="treegrid"]') ||
          itemForRecorded.closest('.x-grid, [role="grid"], .data-table, .grid-container');
        if (gridContainer && headerColumns.length === 0) {
          const headerCt = gridContainer.querySelector('.x-grid-header-ct, thead, .x-grid-header-row, [role="rowgroup"], .ag-header, .mat-header-row') || gridContainer;
          let headerEls = Array.from(headerCt.querySelectorAll('.x-column-header-text, .x-column-header, th, [role="columnheader"], .dxgvHeader, .mat-header-cell, .ag-header-cell, .ant-table-thead th')).filter(visible);
          rawHeaderLayout = headerEls.map(h => {
            const inner = h.querySelector?.('.x-column-header-text, .ag-header-cell-text') || h;
            return cleanCellText(inner.innerText || inner.textContent || inner.getAttribute('aria-label') || '');
          });
          const colTexts = rawHeaderLayout.filter(t => t.length > 0 && t.length < 60 && !EXPANDER_GLYPH_REGEX.test(t));
          if (colTexts.length > 0) {
            headerColumns = Array.from(new Set(colTexts));
          }
        }

        // Exclude header rows from data items
        const dataMatching = matching.filter(child => !isHeaderItem(child));
        const effectiveMatching = dataMatching.length >= minItems ? dataMatching : matching;

        const index = effectiveMatching.indexOf(itemForRecorded);
        if (index < 0 && !effectiveMatching.includes(itemForRecorded) && effectiveMatching.length === 0) continue;

        // Detect which column contained the recorded action element (e.g. "Download Files")
        let recordedCellIndex = -1;
        let recordedTargetColumn = null;
        let recordedActionValue = null;

        if (recorded && itemForRecorded) {
          let recCells = Array.from(itemForRecorded.querySelectorAll('td, th, [role="gridcell"]'));
          if (recCells.length === 0) {
            recCells = Array.from(itemForRecorded.children);
          }
          recordedCellIndex = recCells.findIndex(c => c === recorded || c.contains(recorded));
          if (recordedCellIndex >= 0) {
            if (rawHeaderLayout.length === recCells.length && rawHeaderLayout[recordedCellIndex] && !EXPANDER_GLYPH_REGEX.test(rawHeaderLayout[recordedCellIndex])) {
              recordedTargetColumn = rawHeaderLayout[recordedCellIndex];
            } else {
              const recNonControl = recCells.filter(c => !isControlOrExpanderCell(c));
              const recCell = recCells[recordedCellIndex];
              const nonCtrlIdx = recNonControl.indexOf(recCell);
              if (nonCtrlIdx >= 0 && headerColumns[nonCtrlIdx]) {
                recordedTargetColumn = headerColumns[nonCtrlIdx];
              } else if (headerColumns[recordedCellIndex]) {
                recordedTargetColumn = headerColumns[recordedCellIndex];
              }
            }
          }
          recordedActionValue = cleanCellText(recorded.innerText || recorded.textContent || recorded.getAttribute('value') || recorded.getAttribute('title') || '');
        }

        const ancestorTagLower = ancestor.tagName.toLowerCase();

        // Bonus for recognized repeated item structures (table rows, list items)
        let bonus = 0;
        if ((ancestorTagLower === 'tbody' || ancestorTagLower === 'table') && itemTagLower === 'tr') {
          bonus += 0.2;
        } else if ((ancestorTagLower === 'ul' || ancestorTagLower === 'ol') && itemTagLower === 'li') {
          bonus += 0.2;
        }

        const score = Math.min(
          1,
          0.5 +
          Math.min(0.3, (effectiveMatching.length / Math.max(children.length, 1)) * 0.3) +
          (effectiveMatching.length >= 3 ? 0.2 : 0.1) +
          bonus
        );

        const collType = (itemTagLower === 'tr' || itemRole === 'row' || (rawHeaderLayout.length > 0 && rawHeaderLayout.length === children.length))
          ? 'table-row'
          : (itemTagLower === 'mat-option' || itemRole === 'option' || itemTagLower === 'option'
            ? 'dropdown-option'
            : (itemTagLower === 'li' || itemRole === 'listitem' ? 'list-item' : 'card-grid'));

        candidates.push({
          score,
          itemCount: effectiveMatching.length,
          recordedIndex: Math.max(0, index),
          targetColumn: recordedTargetColumn,
          targetActionValue: recordedActionValue,
          ancestorTag: ancestorTagLower,
          ancestorSelector: buildAncestorSelector(ancestor),
          itemTag: itemTagLower,
          itemClasses: itemClasses,
          itemSignature: itemSignature,
          collectionType: collType,
          headerColumns,
          items: effectiveMatching.map((item, itemIndex) => {
            // Extract named columns from table header for table row records
            const fields = {};
            const itemText = (item.innerText || item.textContent || '').trim().replace(/\s+/g, ' ');
            const isTableRow = itemTagLower === 'tr' ||
              itemTagLower === 'table' ||
              item.getAttribute('role') === 'row' ||
              item.classList?.contains('x-grid-row') ||
              item.classList?.contains('x-grid-item') ||
              item.querySelector('td, .x-grid-cell') !== null;

            if (isTableRow) {
              // Direct cell querying without double-matching child divs
              let cells = Array.from(item.querySelectorAll('td, th, [role="gridcell"], [role="rowheader"]'));
              if (cells.length === 0) {
                cells = Array.from(item.children).filter(c => c.matches?.('td, th, .x-grid-cell, .cell') || c.tagName === 'TD' || c.tagName === 'TH');
              }
              if (cells.length === 0) {
                cells = Array.from(item.querySelectorAll('.x-grid-cell, .dxgv, .cell'));
              }

              // Filter out control and expander cells (checkboxes, arrows, tree expanders)
              const nonControlCells = cells.filter(c => !isControlOrExpanderCell(c));
              const dataCells = nonControlCells.length > 0 ? nonControlCells : cells;

              let mapped = false;
              // Strategy A: Exact positional alignment when raw header layout length matches row cell count
              if (rawHeaderLayout.length > 0 && rawHeaderLayout.length === cells.length) {
                rawHeaderLayout.forEach((hName, idx) => {
                  if (hName && !EXPANDER_GLYPH_REGEX.test(hName)) {
                    const c = cells[idx];
                    let val = cleanCellText(c.innerText || c.textContent || '');
                    if (!val) {
                      const link = c.querySelector('a[href], button, input');
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

              // Strategy B: Control-filtered 1-to-1 mapping
              if (!mapped || Object.keys(fields).filter(k => !k.startsWith('_')).length === 0) {
                if (headerColumns.length > 0 && dataCells.length > 0) {
                  headerColumns.forEach((h, idx) => {
                    if (dataCells[idx] !== undefined) {
                      const c = dataCells[idx];
                      let val = cleanCellText(c.innerText || c.textContent || '');
                      if (!val) {
                        const link = c.querySelector('a[href], button, input');
                        if (link) {
                          val = cleanCellText(link.innerText || link.textContent || link.getAttribute('value') || '');
                        }
                      }
                      if (val && !EXPANDER_GLYPH_REGEX.test(val)) {
                        fields[h] = val;
                      }
                    }
                  });
                }
              }

              // Set clean data cells (excluding controls and expanders)
              fields._cells = dataCells.map(c => cleanCellText(c.innerText || c.textContent || ''));

              // Also check if cells have direct column classes or attribute references
              cells.forEach(cell => {
                const cellText = cleanCellText(cell.innerText || cell.textContent || '');
                const colAttr = cell.getAttribute('data-column') || cell.getAttribute('data-field') || cell.getAttribute('name');
                if (colAttr && cellText && !EXPANDER_GLYPH_REGEX.test(cellText)) {
                  fields[colAttr] = cellText;
                }
              });

              // Also extract specific interactive controls in cells (e.g. Download links, action buttons)
              cells.forEach(cell => {
                const link = cell.querySelector('a[href], button, input');
                if (link) {
                  const linkText = cleanCellText(link.innerText || link.textContent || link.getAttribute('value') || '');
                  if (linkText && !EXPANDER_GLYPH_REGEX.test(linkText)) {
                    let colName = null;
                    if (rawHeaderLayout.length === cells.length) {
                      colName = rawHeaderLayout[cells.indexOf(cell)];
                    }
                    if (!colName) {
                      const dIdx = dataCells.indexOf(cell);
                      if (dIdx >= 0 && headerColumns[dIdx]) colName = headerColumns[dIdx];
                    }
                    if (colName && !fields[colName]) {
                      fields[colName] = linkText;
                    }
                  }
                }
              });

              // Universal status derivation if not in headers or empty
              if (!fields['Status'] || EXPANDER_GLYPH_REGEX.test(fields['Status'])) {
                const statusMatch = itemText.match(/\b(Open|Closed|Pending|Paid|Unpaid|Draft|Approved|Posted|Active|Inactive)\b/i);
                if (statusMatch) {
                  fields['Status'] = statusMatch[1];
                }
              }

              // Universal date derivation if not in headers or empty
              if (!fields['Date'] && !fields['UploadDate'] && !fields['Created']) {
                const dateMatch = itemText.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i);
                if (dateMatch) {
                  fields['Date'] = dateMatch[1];
                }
              }

              // Semantic alias for Due Date if present under alternative name
              if (!fields['Due Date']) {
                const dueCol = headerColumns.find(h => /\bdue\b/i.test(h));
                if (dueCol && fields[dueCol] && !EXPANDER_GLYPH_REGEX.test(fields[dueCol])) {
                  fields['Due Date'] = fields[dueCol];
                }
              }

              // Semantic self-healing for Invoice / Document Number:
              // Ensure Invoice No is NEVER an expander glyph (e.g. '▸') or empty when a valid doc ID exists
              const invColKey = ['Invoice No', 'Invoice Number', 'Invoice #', 'Invoice', 'Inv No', 'Voucher No', 'Doc No']
                .find(k => fields[k] !== undefined) || headerColumns.find(h => /invoice|voucher|doc\s*no/i.test(h));
              if (invColKey) {
                const currVal = fields[invColKey];
                if (!currVal || EXPANDER_GLYPH_REGEX.test(currVal) || !/\d/.test(currVal)) {
                  const docMatch = itemText.match(DOCUMENT_ID_REGEX)?.[1] ||
                    dataCells.map(c => cleanCellText(c.innerText || c.textContent || '')).find(t => DOCUMENT_ID_REGEX.test(t));
                  if (docMatch) {
                    fields[invColKey] = docMatch;
                  }
                }
              }

              // Clean all fields: strip expander glyphs and delete any field consisting purely of expander glyphs
              for (const [k, v] of Object.entries(fields)) {
                if (typeof v === 'string') {
                  if (EXPANDER_GLYPH_REGEX.test(v)) {
                    delete fields[k];
                  } else {
                    fields[k] = cleanCellText(v);
                  }
                }
              }
            } else if (itemTagLower === 'mat-option' || itemRole === 'option' || itemTagLower === 'option') {
              fields['Option'] = itemText;
              fields['Value'] = itemText;
              fields['Type'] = itemText;
            } else {
              // Universal field extraction for cards, grids, and list items
              // 1. Labeled pairs (<label>Key:</label><span>Val</span>, <dt>Key</dt><dd>Val</dd>)
              const labelEls = item.querySelectorAll('dt, label, [class*="label"], [class*="title"], strong, b');
              labelEls.forEach(lbl => {
                const lText = (lbl.innerText || lbl.textContent || '').trim().replace(/[:：]$/, '');
                if (lText && lText.length > 1 && lText.length < 40) {
                  const valEl = lbl.nextElementSibling || lbl.parentElement?.querySelector('[class*="value"], [class*="content"], span:not([class*="label"])');
                  if (valEl && valEl !== lbl) {
                    const val = (valEl.innerText || valEl.textContent || '').trim();
                    if (val && !fields[lText]) fields[lText] = val;
                  }
                }
              });

              // 2. Data attributes and named elements
              const dataEls = item.querySelectorAll('[data-field], [data-col], [data-column], [name]');
              dataEls.forEach(el => {
                const attr = el.getAttribute('data-field') || el.getAttribute('data-column') || el.getAttribute('data-col') || el.getAttribute('name');
                const txt = (el.innerText || el.textContent || '').trim();
                if (attr && txt && !fields[attr]) fields[attr] = txt;
              });

              // 3. Status badges / chips
              const badgeEls = item.querySelectorAll('[class*="status"], [class*="badge"], [class*="tag"], [role="status"]');
              badgeEls.forEach(b => {
                const bTxt = (b.innerText || b.textContent || '').trim();
                if (bTxt && bTxt.length < 30 && !fields['Status'] && !fields['State']) {
                  fields['Status'] = bTxt;
                }
              });

              // 4. Semantic tokens from text
              const idMatch = itemText.match(/\b([A-Z0-9]{2,8}[-_#][A-Z0-9-_#]{2,20}|(?:INV|ORD|TX|PO|SI|CM)-\d+|#\d{4,10})\b/i);
              if (idMatch && !fields['Identifier'] && !fields['ID'] && !fields['Invoice Number']) {
                fields['Identifier'] = idMatch[1];
              }
              const dateMatch = itemText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i);
              if (dateMatch && !fields['Date'] && !fields['Created On']) {
                fields['Date'] = dateMatch[1];
              }
              const amountMatch = itemText.match(/\b([$€£¥₹]\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})*\.\d{2}\s*[$€£¥₹]?)\b/);
              if (amountMatch && !fields['Amount'] && !fields['Total']) {
                fields['Amount'] = amountMatch[1];
              }
            }

            if (fields['Type'] === undefined && fields['type'] === undefined) {
              if (itemTagLower === 'mat-option' || itemRole === 'option' || itemTagLower === 'option') {
                fields['Type'] = itemText;
              }
            }
            fields['fullText'] = itemText;
            fields['label'] = itemText;
            fields['Text'] = itemText;
            fields['_rawText'] = itemText;

            return {
              index: itemIndex,
              text: normalize(itemText).slice(0, 200),
              tagName: item.tagName.toLowerCase(),
              signature: structuralSignature(item),
              fields,
              href: item.querySelector('a[href]')?.href || null,
              id: item.getAttribute('data-id') ||
                item.getAttribute('data-testid') ||
                item.getAttribute('data-qa') ||
                item.id ||
                null
            };
          })
        });
      }

      candidates.sort((a, b) => b.score - a.score);

      const best = candidates[0];
      if (!best || best.score < minScore) {
        return {
          success: false,
          reason: 'No repeated collection met the discovery confidence threshold.',
          confidence: best ? best.score : 0,
          candidates: candidates.slice(0, 5)
        };
      }

      const isIgnoredField = (k) => {
        if (!k || typeof k !== 'string') return true;
        const norm = k.trim().toLowerCase();
        if (norm.startsWith('_')) return true;
        if (['fulltext', 'label', 'text', 'isselectall', 'select', 'selection', 'actions', 'action', 'controls', 'operations', 'manage'].includes(norm)) {
          return true;
        }
        return false;
      };

      const availableCols = new Set();
      for (const h of (best.headerColumns || [])) {
        if (!isIgnoredField(h)) availableCols.add(h);
      }
      for (const itm of best.items || []) {
        for (const k of Object.keys(itm.fields || {})) {
          if (!isIgnoredField(k)) availableCols.add(k);
        }
      }

      return {
        success: true,
        confidence: best.score,
        itemCount: best.itemCount,
        recordedIndex: best.recordedIndex,
        targetColumn: best.targetColumn,
        targetActionValue: best.targetActionValue,
        collectionType: best.collectionType || 'table-row',
        collection: {
          ancestorTag: best.ancestorTag,
          ancestorSelector: best.ancestorSelector,
          itemTag: best.itemTag,
          itemClasses: best.itemClasses,
          itemSignature: best.itemSignature,
          collectionType: best.collectionType || 'table-row',
          headerColumns: best.headerColumns
        },
        items: best.items,
        availableFields: Array.from(availableCols),
        candidates: candidates.slice(0, 5)
      };
    }, { target, minItems, minScore });
  }


  /**
   * Resolve one discovered item again from the current DOM.
   * Returns a Puppeteer ElementHandle so replay can execute the recorded action
   * relative to that item instead of the original recorded element.
   */
  static async getItemHandle(page, discovery, index) {
    if (!page) throw new Error('ItemDiscovery.getItemHandle requires a Puppeteer page.');
    if (!discovery || !discovery.success || !discovery.collection) {
      throw new Error('Invalid discovery result.');
    }

    const expectedItem = (Array.isArray(discovery.items) && discovery.items[index]) ? discovery.items[index] : null;

    return page.evaluateHandle(({ collection, index, expectedItem }) => {
      const visible = (el) => {
        if (!el) return false;
        if (typeof Element !== 'undefined' && !(el instanceof Element)) return false;
        const style = (typeof getComputedStyle === 'function' ? getComputedStyle(el) : el.style) || {};
        const rect = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : { width: 10, height: 10, top: 0, left: 0 };
        const top = rect.top !== undefined ? rect.top : 0;
        const left = rect.left !== undefined ? rect.left : 0;
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0 && top > -500 && left > -500;
      };

      const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

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

      const isTableRowCollection = collection.itemTag === 'tr' ||
        collection.ancestorTag === 'tbody' ||
        collection.ancestorTag === 'table' ||
        (Array.isArray(collection.headerColumns) && collection.headerColumns.length > 0);

      const isHeaderItem = (el) => {
        if (!el) return false;
        if (typeof Element !== 'undefined' && !(el instanceof Element)) return false;
        if (!isTableRowCollection) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'thead' || el.closest('thead')) return true;
        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if (/\b(header|thead|column-header|grid-header|header-row)\b/i.test(cls)) return true;
        const ths = el.querySelectorAll('th, [role="columnheader"]');
        const tds = el.querySelectorAll('td, [role="gridcell"]');
        if (ths.length > 0 && tds.length === 0) return true;
        const isRow = tag === 'tr' || el.getAttribute('role') === 'row' || (el.classList && el.classList.contains('x-grid-row'));
        if (isRow && el === el.parentElement?.firstElementChild && (ths.length > 0 || tds.length >= 2)) {
          const hasLinksOrInputs = el.querySelector('a[href], button, input[type="button"], input[type="submit"]');
          if (hasLinksOrInputs) return false;
          const rowText = (el.innerText || el.textContent || '').trim();
          const isDataLike = /\b((?:SI|INV|DR|TX|CM|PO|SO|BILL|REC|ORD)-\d+|\b\d{4,10}\b|\$\s*\d|\d{4}-\d{2}-\d{2})\b/i.test(rowText);
          if (isDataLike) return false;

          const nextRow = el.nextElementSibling;
          const nextRowHasLinks = nextRow?.querySelector('a[href], button, input');
          const hasBold = Array.from(tds).some(c => {
            if (c.querySelector('b, strong, th')) return true;
            try {
              const fw = window.getComputedStyle ? window.getComputedStyle(c).fontWeight : null;
              return fw >= 600 || fw === 'bold';
            } catch { return false; }
          });
          const nextTds = nextRow ? Array.from(nextRow.querySelectorAll('td, [role="gridcell"]')) : [];
          const nextRowHasBold = nextTds.some(c => {
            if (c.querySelector('b, strong, th')) return true;
            try {
              const fw = window.getComputedStyle ? window.getComputedStyle(c).fontWeight : null;
              return fw >= 600 || fw === 'bold';
            } catch { return false; }
          });

          if (nextRowHasLinks || (hasBold && !nextRowHasBold)) {
            return true;
          }
        }
        return false;
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

      // If multiple ancestor containers exist (e.g. across multiple stacked windows or modals),
      // prioritize the ancestor residing inside the topmost active modal/window!
      if (ancestors.length > 1) {
        const getZ = (el) => {
          const cs = window.getComputedStyle(el);
          const z = parseInt(cs.zIndex, 10);
          return isNaN(z) ? 0 : z;
        };
        const modalSelectors = [
          '.x-window:not(.x-hidden):not(.x-hidden-offsets)',
          '[role="dialog"]:not([aria-hidden="true"])',
          'dialog[open]',
          '.modal.show',
          '.modal.in',
          '.modal:not([aria-hidden="true"])',
          '.ui-dialog:not([style*="display: none"])',
          '.dx-dialog',
          '.ant-modal:not(.ant-modal-hidden)'
        ];
        const allModals = Array.from(document.querySelectorAll(modalSelectors.join(', '))).filter(visible);
        if (allModals.length > 0) {
          allModals.sort((a, b) => getZ(b) - getZ(a));
          const topModal = allModals[0];
          const inTopModal = ancestors.filter(a => topModal.contains(a));
          if (inTopModal.length > 0) {
            ancestors = inTopModal;
          }
        }
      }

      for (const ancestor of ancestors) {
        // Prefer exact structural matches captured during discovery, excluding header rows.
        const exactItems = Array.from(ancestor.children).filter(child =>
          visible(child) &&
          child.tagName.toLowerCase() === collection.itemTag &&
          !isHeaderItem(child) &&
          structuralSignature(child) === collection.itemSignature
        );

        let candidate = null;
        if (exactItems.length > index) {
          candidate = exactItems[index];
        } else {
          // If a portal re-renders a row/card and changes a transient attribute
          // (role, data-testid, etc.), preserve the collection ordering instead
          // of losing the item entirely. The item tag remains the hard boundary.
          const compatibleItems = Array.from(ancestor.children).filter(child =>
            visible(child) &&
            child.tagName.toLowerCase() === collection.itemTag &&
            !isHeaderItem(child)
          );

          if (compatibleItems.length > index) {
            candidate = compatibleItems[index];
          }
        }

        if (candidate) {
          // If expectedItem metadata is available, verify that candidate corresponds to it
          if (expectedItem) {
            const candidateText = normalize(candidate.innerText || candidate.textContent || '').slice(0, 200);
            const candidateId = candidate.getAttribute('data-id') ||
              candidate.getAttribute('data-testid') ||
              candidate.getAttribute('data-qa') ||
              candidate.id ||
              null;

            // 1. Explicit ID verification
            if (expectedItem.id) {
              const matchedById = (
                candidate.id === expectedItem.id ||
                candidate.getAttribute('data-id') === expectedItem.id ||
                candidate.getAttribute('data-testid') === expectedItem.id ||
                candidate.getAttribute('data-qa') === expectedItem.id
              );
              const candidateDirectId = candidate.getAttribute('data-id') || candidate.id;
              if (candidateDirectId && !matchedById) {
                return null;
              }
            }

            // 2. If expectedItem has extracted key field (e.g. Invoice Number / ID), verify it matches
            const keyField = expectedItem.fields && (
              expectedItem.fields['Invoice No'] ||
              expectedItem.fields['Invoice Number'] ||
              expectedItem.fields['Invoice #'] ||
              expectedItem.fields['Invoice'] ||
              expectedItem.fields['Identifier'] ||
              expectedItem.fields['ID'] ||
              expectedItem.fields['Doc No']
            );
            if (keyField && typeof keyField === 'string' && keyField.length >= 3) {
              const normKey = normalize(keyField);
              if (!candidateText.includes(normKey)) {
                return null;
              }
            }
          }

          try { candidate.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
          return candidate;
        }
      }

      return null;
    }, { collection: discovery.collection, index, expectedItem });
  }

  /**
   * Check whether a discovered collection candidate belongs to site navigation or toolbar chrome.
   */
  static isNavigationCandidate(candidate) {
    if (!candidate) return false;
    const combined = [
      candidate.tagName || '',
      candidate.parentTag || '',
      candidate.role || '',
      candidate.ancestorTag || '',
      candidate.ancestorSelector || '',
      Array.isArray(candidate.classes) ? candidate.classes.join(' ') : (candidate.classes || '')
    ].join(' ').toLowerCase();

    if (/\b(mat-toolbar|mat-toolbar-row|mat-tab-header|mat-tab-group|mat-tab-nav-bar|mat-tab-link|mat-sidenav|mat-sidenav-container|app-header|app-nav|navbar)\b/i.test(combined)) {
      return true;
    }
    if (/\b(navigation|menubar|tablist|tab|banner|contentinfo|toolbar|breadcrumb|pagination)\b/i.test(combined)) {
      return true;
    }
    if (/\b(navbar|nav-tabs|nav-item|nav-link|top-bar|app-bar|sidebar-nav|site-header|main-nav|page-header|pager|header-nav|menu-item)\b/i.test(combined)) {
      return true;
    }
    return false;
  }

  /**
   * Select the best candidate from already-collected discovery candidates.
   * Kept pure for deterministic unit testing.
   *
   * @param {Array<object>} candidates
   * @returns {object|null}
   */
  static selectBestCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    return candidates
      .filter(c => c && typeof c.score === 'number' && !this.isNavigationCandidate(c))
      .sort((a, b) => b.score - a.score)[0] || null;
  }
}

module.exports = ItemDiscovery;
