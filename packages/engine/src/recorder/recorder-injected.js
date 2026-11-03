/**
 * In-Page Recorder Script (Runs inside the browser context)
 * 
 * Injected on new document creation via CDP Page.addScriptToEvaluateOnNewDocument.
 * Captures user interactions (CLICK, DOUBLE_CLICK, TYPE, SELECT),
 * buffers text input to prevent per-keystroke noise, and streams actions
 * to Node.js via window.__workflowCaptureEmitAction.
 */

(function () {
  const CURRENT_RECORDER_VERSION = 8;

  // Clean up any listeners from a previous session
  if (typeof window.__workflowCaptureCleanup === 'function') {
    try { window.__workflowCaptureCleanup(); } catch { }
  }

  window.__workflowCaptureVersion = CURRENT_RECORDER_VERSION;
  window.__workflowCaptureInitialized = true;
  window.__reflowRecorderMode = window.__reflowRecorderMode || 'ACTION';

  // Active input buffer to consolidate typing into a single TYPE action
  let activeInputBuffer = null;
  let isPaused = Boolean(window.__workflowCapturePaused);

  function isRecorderUiEvent(event) {
    if (!event) return false;
    try {
      const badge = document.getElementById('__workflow_capture_badge__');
      const hud = document.getElementById('__reflow_recorder_hud__');
      const overlay = document.getElementById('__reflow_hover_overlay__');
      const target = event.target;
      if (!target) return false;
      if (target === badge || (typeof target.closest === 'function' && target.closest('#__workflow_capture_badge__'))) return true;
      if (target === hud || (typeof target.closest === 'function' && target.closest('#__reflow_recorder_hud__'))) return true;
      if (target === overlay || (typeof target.closest === 'function' && target.closest('#__reflow_hover_overlay__'))) return true;
      if (typeof target.closest === 'function' && target.closest('[data-reflow-ignore="true"]')) return true;
      if (typeof event.composedPath === 'function') {
        const path = event.composedPath() || [];
        if (badge && path.includes(badge)) return true;
        if (hud && path.includes(hud)) return true;
        if (overlay && path.includes(overlay)) return true;
        for (const el of path) {
          if (el && typeof el.getAttribute === 'function' && el.getAttribute('data-reflow-ignore') === 'true') {
            return true;
          }
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  // Diagnostic stamp: records the last pointerdown/mousedown target/time/coordinates, regardless
  // of whether a click/action ever gets recorded for it. Lets you check,
  // after a session, whether the element/icon/canvas received input at all.
  function handlePointerDownDiag(event) {
    if (isRecorderUiEvent(event)) return;
    const target = event.target;
    if (!target) return;
    const isInsideIframe = (typeof window !== 'undefined' && window.self !== window.top);
    window.__workflowCaptureLastPointerDown = {
      tag: target.tagName,
      id: target.id || null,
      title: target.getAttribute?.('title') || null,
      classes: Array.from(target.classList || []),
      time: Date.now(),
      clientX: event.clientX,
      clientY: event.clientY,
      isCanvas: target.tagName === 'CANVAS',
      isIframe: isInsideIframe
    };
  }

  /**
   * Calculate normalized (0-1) coordinates and dimensions if target is a canvas
   */
  function buildCanvasCoordsIfApplicable(targetEl, event) {
    if (!targetEl || targetEl.tagName !== 'CANVAS') return null;
    try {
      const rect = targetEl.getBoundingClientRect();
      const width = rect.width || targetEl.clientWidth || 1;
      const height = rect.height || targetEl.clientHeight || 1;
      const clientX = event && event.clientX !== undefined ? event.clientX : (event && event.pageX ? event.pageX - window.scrollX : rect.left + width / 2);
      const clientY = event && event.clientY !== undefined ? event.clientY : (event && event.pageY ? event.pageY - window.scrollY : rect.top + height / 2);
      const offsetX = Math.max(0, Math.min(width, clientX - rect.left));
      const offsetY = Math.max(0, Math.min(height, clientY - rect.top));
      const relX = Number((offsetX / width).toFixed(4));
      const relY = Number((offsetY / height).toFixed(4));
      return {
        relX,
        relY,
        offsetX: Math.round(offsetX),
        offsetY: Math.round(offsetY),
        canvasWidth: Math.round(width),
        canvasHeight: Math.round(height)
      };
    } catch {
      return null;
    }
  }

  /**
   * Target equality and container-aware matching for event deduplication
   */
  function isSameTarget(elA, elB) {
    if (!elA || !elB) return false;
    if (elA === elB) return true;
    if (elA.contains && elA.contains(elB)) return true;
    if (elB.contains && elB.contains(elA)) return true;
    const parentA = elA.closest && elA.closest('button, a, .dxm-item, .x-btn, [role="button"], [role="menuitem"], canvas');
    const parentB = elB.closest && elB.closest('button, a, .dxm-item, .x-btn, [role="button"], [role="menuitem"], canvas');
    if (parentA && parentB && parentA === parentB) return true;
    return false;
  }

  /**
   * Resolve an inner/decorative leaf target to its nearest semantic interactive ancestor
   * (button, link, combobox/select, menuitem, tab, etc.) while preserving form inputs and explicit checkboxes.
   */
  function normalizeToInteractiveTarget(el) {
    if (!el || el.nodeType !== 1) return el;

    const tag = el.tagName.toLowerCase();

    // Preserve native inputs, textareas, native selects, and canvases
    if (['input', 'textarea', 'select', 'canvas'].includes(tag)) {
      return el;
    }

    // Preserve explicit option checkboxes (e.g. mat-pseudo-checkbox)
    if (tag === 'mat-pseudo-checkbox' || (el.classList && el.classList.contains('mat-pseudo-checkbox'))) {
      return el;
    }

    // Elevate label clicking directly to inner checkbox/radio if present
    const labelParent = tag === 'label' ? el : el.closest?.('label');
    if (labelParent) {
      const innerInput = labelParent.querySelector?.('input[type="checkbox"], input[type="radio"]');
      if (innerInput) return innerInput;
    }

    // Preserve backdrop overlay dismiss clicks
    if ((el.classList && (el.classList.contains('cdk-overlay-backdrop') || el.classList.contains('modal-backdrop'))) ||
      (el.className && typeof el.className === 'string' && el.className.includes('backdrop'))) {
      return el;
    }

    // Elevate to nearest interactive parent
    const interactiveParent = el.closest([
      'button',
      'a',
      '[role="button"]',
      '[role="combobox"]',
      '[role="menuitem"]',
      '[role="tab"]',
      'mat-select',
      '.mat-mdc-select-trigger',
      '.mat-select-trigger',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="reset"]',
      'summary',
      '.btn',
      '.x-btn',
      '.dxbButton'
    ].join(', '));

    if (interactiveParent && interactiveParent !== el) {
      return interactiveParent;
    }

    return el;
  }

  let pendingClickTimer = null;
  let pendingClickTarget = null;
  let pendingClickExtra = null;
  const DBL_CLICK_THRESHOLD_MS = 280;

  // Deduplication & pointer tracking
  let lastHandledEventTime = 0;
  let lastHandledTarget = null;

  /**
   * Flush any pending single click action immediately
   */
  function flushPendingClick() {
    if (pendingClickTimer) {
      clearTimeout(pendingClickTimer);
      pendingClickTimer = null;
      if (pendingClickTarget) {
        emitAction('CLICK', pendingClickTarget, pendingClickExtra || {});
      }
      pendingClickTarget = null;
      pendingClickExtra = null;
    }
  }

  /**
   * Fallback target generator if SelectorResolver is unavailable or encounters an error
   */
  function buildFallbackTarget(el) {
    const candidates = [];
    const tagName = (el.tagName || '').toLowerCase();
    const title = el.getAttribute?.('title') || (el.querySelector && el.querySelector('[title]')?.getAttribute?.('title')) || '';
    const id = el.id && !/^\d+$/.test(el.id) ? el.id : null;

    if (title) {
      candidates.push({ strategy: 'attribute', value: `${tagName}[title="${title.replace(/"/g, '\\"')}"]`, uniqueness: 1, priority: 3 });
      candidates.push({ strategy: 'attribute', value: `[title="${title.replace(/"/g, '\\"')}"]`, uniqueness: 1, priority: 3 });
      if (/save|export|pdf|print|download/i.test(title)) {
        candidates.push({ strategy: 'attribute', value: `[title*="save" i]`, uniqueness: 1, priority: 3 });
        candidates.push({ strategy: 'attribute', value: `[title*="export" i]`, uniqueness: 1, priority: 3 });
        candidates.push({ strategy: 'attribute', value: `[title*="download" i]`, uniqueness: 1, priority: 3 });
      }
    }

    if (id) {
      candidates.push({ strategy: 'id', value: `#${id}`, uniqueness: 1, priority: 1 });
    }

    if (tagName === 'canvas') {
      candidates.push({ strategy: 'tag', value: 'canvas', uniqueness: 1, priority: 5 });
      if (id) {
        candidates.push({ strategy: 'id', value: `#${id}`, uniqueness: 1, priority: 1 });
      }
      if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.split(/\s+/).filter(Boolean)[0];
        if (firstClass) {
          candidates.push({ strategy: 'class', value: `canvas.${firstClass}`, uniqueness: 1, priority: 3 });
        }
      }
    }

    const toolbarItem = el.closest && el.closest('.dxm-item, [id*="Toolbar_Menu"], .x-btn');
    if (toolbarItem && toolbarItem !== el) {
      const tbTitle = toolbarItem.getAttribute?.('title');
      if (tbTitle) {
        candidates.push({ strategy: 'attribute', value: `li[title="${tbTitle.replace(/"/g, '\\"')}"]`, uniqueness: 1, priority: 3 });
      }
      if (toolbarItem.id) {
        candidates.push({ strategy: 'id', value: `#${toolbarItem.id}`, uniqueness: 1, priority: 1 });
      }
    }

    const text = (el.textContent || '').trim();
    if (text && text.length < 60) {
      candidates.push({ strategy: 'text', value: `//${tagName}[normalize-space()='${text}']`, uniqueness: 1, priority: 4 });
    }

    let friendlyName = title || text || (id ? id.replace(/[_\-]+/g, ' ') : '') || tagName;
    if (tagName === 'button' && !friendlyName.toLowerCase().includes('button')) friendlyName += ' Button';
    else if (tagName === 'input' && !friendlyName.toLowerCase().includes('field') && !friendlyName.toLowerCase().includes('input')) friendlyName += ' Field';

    return {
      candidates,
      friendlyName,
      elementName: friendlyName,
      fingerprint: {
        tagName,
        id,
        name: el.getAttribute?.('name') || null,
        type: el.getAttribute?.('type') || null,
        role: el.getAttribute?.('role') || null,
        text: text.slice(0, 100),
        classes: Array.from(el.classList || []),
        attributes: title ? { title } : {},
        dimensions: {
          width: Math.round(el.getBoundingClientRect?.().width || 0),
          height: Math.round(el.getBoundingClientRect?.().height || 0)
        }
      }
    };
  }

  const SNIFF_EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

  function cleanSniffedText(val) {
    if (val == null) return '';
    let s = String(val).trim().replace(/\s+/g, ' ');
    if (SNIFF_EXPANDER_GLYPH_REGEX.test(s)) return '';
    s = s.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
    s = s.replace(/[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/, '').trim();
    return s;
  }

  function safeCssEscape(str) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    return String(str || '').replace(/["\\]/g, '\\$&');
  }

  /**
   * Fast in-page contextual sniffer (<5ms):
   * Captures surrounding table headers, visible sibling rows, dropdown options,
   * and radio/checkbox groups on interaction.
   */
  function sniffElementContext(element) {
    if (!element || element.nodeType !== 1) return null;

    const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const columns = [];
    const fieldValues = {};
    let tableContext = null;
    let dropdownOptions = [];
    let groupInfo = null;

    try {
      // 1. Surrounding Table & Nested Sub-table Sniffing
      const tableSelector = 'table, [role="grid"], [role="table"], [role="treegrid"], .dxgvTable, .v-data-table';
      const tableEl = element.closest ? element.closest(tableSelector) : null;

      if (tableEl) {
        const isSubTable = Boolean(tableEl.parentElement && tableEl.parentElement.closest && tableEl.parentElement.closest(tableSelector));

        // Column headers for this specific table (excluding headers of nested sub-tables inside it and explicit row headers)
        const allHeaderEls = Array.from(tableEl.querySelectorAll('th, [role="columnheader"], thead td, .dxgvHeader'))
          .filter(h => {
            if (h.closest ? h.closest(tableSelector) !== tableEl : false) return false;
            // Exclude explicit row headers
            if (h.getAttribute?.('scope') === 'row' || h.getAttribute?.('role') === 'rowheader') return false;
            return true;
          });

        let directHeaderEls = allHeaderEls;
        if (allHeaderEls.length > 0) {
          const headerRowMap = new Map();
          allHeaderEls.forEach(th => {
            const row = th.closest ? th.closest('tr, [role="row"]') : null;
            if (row && (row.tagName === 'TR' || row.getAttribute?.('role') === 'row')) {
              if (!headerRowMap.has(row)) headerRowMap.set(row, []);
              headerRowMap.get(row).push(th);
            }
          });

          if (headerRowMap.size > 1) {
            // Multiple header rows (grouped headers or filter rows): pick the primary row with most text headers
            let bestRowHeaders = allHeaderEls;
            let maxHeaders = 0;
            for (const [r, ths] of headerRowMap.entries()) {
              const textThs = ths.filter(th => {
                const txt = cleanSniffedText(
                  th.innerText || th.textContent ||
                  th.getAttribute?.('data-field') || th.getAttribute?.('data-column') || th.getAttribute?.('col-id') ||
                  th.getAttribute?.('aria-label') || th.getAttribute?.('title') || ''
                );
                return txt && !SNIFF_EXPANDER_GLYPH_REGEX.test(txt);
              });
              if (textThs.length >= maxHeaders) {
                maxHeaders = textThs.length;
                bestRowHeaders = ths;
              }
            }
            directHeaderEls = bestRowHeaders;
          }
        }

        const getHeaderText = (th) => {
          if (!th) return '';
          return cleanSniffedText(
            th.innerText ||
            th.textContent ||
            th.getAttribute?.('data-field') ||
            th.getAttribute?.('data-column') ||
            th.getAttribute?.('col-id') ||
            th.getAttribute?.('aria-label') ||
            th.getAttribute?.('title') ||
            th.querySelector?.('[title]')?.getAttribute?.('title') ||
            th.querySelector?.('[aria-label]')?.getAttribute?.('aria-label') ||
            ''
          );
        };

        // Retain 1-to-1 raw header layout for exact positional column alignment
        const rawHeaders = directHeaderEls.map(getHeaderText);
        const headerNames = [];
        for (let i = 0; i < Math.min(rawHeaders.length, 30); i++) {
          const txt = rawHeaders[i];
          if (txt && !headerNames.includes(txt) && txt.length <= 60 && !SNIFF_EXPANDER_GLYPH_REGEX.test(txt)) {
            headerNames.push(txt);
          }
        }

        // Active row and clicked column detection
        const activeRow = element.closest('tr, [role="row"]');
        const activeCell = element.closest('td, th, [role="gridcell"], [role="cell"]');
        let activeColName = null;

        if (activeCell) {
          // Direct column header click (excluding row headers)
          const isRowHeader = activeCell.getAttribute?.('scope') === 'row' || activeCell.getAttribute?.('role') === 'rowheader';
          if (!isRowHeader && (activeCell.tagName === 'TH' || activeCell.getAttribute?.('role') === 'columnheader')) {
            const hText = getHeaderText(activeCell);
            if (hText && headerNames.includes(hText)) {
              activeColName = hText;
            }
          }
          // Grid cell with explicit field attribute
          if (!activeColName) {
            const cellField = cleanSniffedText(activeCell.getAttribute?.('data-field') || activeCell.getAttribute?.('data-column') || activeCell.getAttribute?.('col-id') || '');
            if (cellField && headerNames.includes(cellField)) {
              activeColName = cellField;
            }
          }
          // Grid cell with ARIA column index
          if (!activeColName && activeCell.getAttribute?.('aria-colindex')) {
            const cIdx = parseInt(activeCell.getAttribute('aria-colindex'), 10) - 1;
            if (cIdx >= 0 && rawHeaders[cIdx] && headerNames.includes(rawHeaders[cIdx])) {
              activeColName = rawHeaders[cIdx];
            }
          }
          // Row cell positional matching
          if (!activeColName && activeRow) {
            const rowCells = Array.from(activeRow.querySelectorAll('td, th, [role="gridcell"], [role="cell"]'))
              .filter(c => c.closest(tableSelector) === tableEl);
            const cellIdx = rowCells.indexOf(activeCell);
            if (cellIdx >= 0) {
              if (rawHeaders.length === rowCells.length && rawHeaders[cellIdx] && headerNames.includes(rawHeaders[cellIdx])) {
                activeColName = rawHeaders[cellIdx];
              } else if (headerNames[cellIdx]) {
                activeColName = headerNames[cellIdx];
              }
            }
          }
        }

        // Sibling rows & distinct column values
        const allRows = Array.from(tableEl.querySelectorAll('tbody tr, tr, [role="row"]'))
          .filter(r => {
            if (r.closest ? r.closest(tableSelector) !== tableEl : false) return false;
            // Exclude header rows in thead or rows that only contain header cells
            const theadEl = r.closest ? r.closest('thead') : null;
            if (theadEl && (theadEl.tagName === 'THEAD' || theadEl.getAttribute?.('role') === 'rowgroup')) return false;
            // Exclude footer/summary rows
            const tfootEl = r.closest ? r.closest('tfoot') : null;
            if (tfootEl && (tfootEl.tagName === 'TFOOT' || tfootEl.getAttribute?.('role') === 'rowgroup')) return false;
            // If row has th/columnheader AND has no data cells (td/gridcell), it's a header row
            const hasHeader = Boolean(r.querySelector?.('th, [role="columnheader"]'));
            const hasDataCell = Boolean(r.querySelector?.('td, [role="gridcell"], [role="cell"]'));
            if (hasHeader && !hasDataCell) return false;
            return true;
          });

        const rowValuesMap = {};
        headerNames.forEach(h => { rowValuesMap[h] = new Set(); });
        const activeRowValues = {};

        const maxRowsToSniff = Math.min(allRows.length, 15);
        for (let rIdx = 0; rIdx < maxRowsToSniff; rIdx++) {
          const row = allRows[rIdx];
          const cells = Array.from(row.querySelectorAll ? row.querySelectorAll('td, th, [role="gridcell"], [role="cell"]') : [])
            .filter(c => c.closest ? c.closest(tableSelector) === tableEl : true);

          // Skip details expander row (single cell spanning multiple columns)
          if (cells.length === 1 && rawHeaders.length > 1 && (cells[0].getAttribute?.('colspan') || cells[0].classList?.contains('details') || (cells[0].className && typeof cells[0].className === 'string' && cells[0].className.includes('expand')))) {
            continue;
          }

          const getCellVal = (cell) => {
            if (!cell) return '';
            let val = cleanSniffedText(cell.innerText || cell.textContent || '');
            if (!val) {
              const inputEl = cell.querySelector?.('input, textarea, select');
              if (inputEl && inputEl.type !== 'checkbox' && inputEl.type !== 'radio') {
                val = cleanSniffedText(inputEl.value || inputEl.getAttribute?.('value') || '');
              }
            }
            return (val && val.length <= 100 && !SNIFF_EXPANDER_GLYPH_REGEX.test(val)) ? val : '';
          };

          // Positional alignment Strategy A: Exact 1-to-1 layout alignment
          if (rawHeaders.length > 0 && rawHeaders.length === cells.length) {
            for (let cIdx = 0; cIdx < cells.length; cIdx++) {
              const h = rawHeaders[cIdx];
              if (h && headerNames.includes(h)) {
                const val = getCellVal(cells[cIdx]);
                if (val) {
                  rowValuesMap[h].add(val);
                  if (row === activeRow) {
                    activeRowValues[h] = val;
                  }
                }
              }
            }
          } else {
            // Positional alignment Strategy B: Fallback index alignment
            for (let cIdx = 0; cIdx < Math.min(cells.length, headerNames.length); cIdx++) {
              const h = headerNames[cIdx];
              const val = getCellVal(cells[cIdx]);
              if (val) {
                rowValuesMap[h].add(val);
                if (row === activeRow) {
                  activeRowValues[h] = val;
                }
              }
            }
          }
        }

        const consolidatedRowValues = {};
        for (const [col, valSet] of Object.entries(rowValuesMap)) {
          if (valSet.size > 0) {
            const vals = Array.from(valSet);
            consolidatedRowValues[col] = vals;
            fieldValues[col] = vals;
          }
        }

        headerNames.forEach(h => {
          if (!columns.includes(h)) columns.push(h);
        });

        tableContext = {
          headers: headerNames,
          columns: headerNames,
          activeColumn: activeColName,
          activeRowValues,
          rowValues: consolidatedRowValues,
          isSubTable,
          rowCount: allRows.length
        };
      }

      // 2. Dropdown & Options Sniffing (Native & Custom)
      // 2a. Native <select>
      const selectEl = element.tagName === 'SELECT' ? element : (element.closest?.('select') || element.querySelector?.('select'));
      if (selectEl && selectEl.options) {
        for (let i = 0; i < Math.min(selectEl.options.length, 50); i++) {
          const opt = selectEl.options[i];
          const val = cleanSniffedText(opt.text || opt.value || '');
          if (val && !dropdownOptions.includes(val)) {
            dropdownOptions.push(val);
          }
        }
        let fieldName = cleanSniffedText(selectEl.getAttribute?.('aria-label') || '');
        if (!fieldName && selectEl.labels && selectEl.labels[0]) {
          fieldName = cleanSniffedText(selectEl.labels[0].innerText || selectEl.labels[0].textContent || '');
        }
        if (!fieldName && selectEl.id) {
          try {
            const lbl = document.querySelector(`label[for="${safeCssEscape(selectEl.id)}"]`);
            if (lbl) fieldName = cleanSniffedText(lbl.innerText || lbl.textContent || '');
          } catch { }
        }
        if (!fieldName) {
          fieldName = cleanSniffedText(selectEl.closest?.('label')?.innerText || selectEl.name || selectEl.id || selectEl.getAttribute?.('placeholder') || '');
        }
        if (fieldName && dropdownOptions.length > 0) {
          if (!columns.includes(fieldName)) columns.push(fieldName);
          fieldValues[fieldName] = dropdownOptions.slice();
        }
      }

      // 2b. Custom Dropdown Options (clicked on option or trigger)
      const optionEl = element.closest?.('[role="option"], mat-option, .mat-mdc-option, .dropdown-item, [role="menuitem"], .select2-results__option, .ant-select-item-option, .dropdown-menu li, .dropdown-menu a, [role="listbox"] li, [role="menu"] li');
      if (optionEl) {
        const listbox = optionEl.closest?.('[role="listbox"], mat-select-panel, .mat-select-panel, .dropdown-menu, [role="menu"], ul, .select2-results__options, .ant-select-dropdown');
        if (listbox && typeof listbox.querySelectorAll === 'function') {
          const siblingOpts = Array.from(listbox.querySelectorAll('[role="option"], mat-option, .mat-mdc-option, .dropdown-item, [role="menuitem"], .select2-results__option, .ant-select-item-option, li, a'));
          for (let i = 0; i < Math.min(siblingOpts.length, 50); i++) {
            const opt = siblingOpts[i];
            const val = cleanSniffedText(opt.innerText || opt.textContent || opt.getAttribute('value') || '');
            if (val && !dropdownOptions.includes(val)) {
              dropdownOptions.push(val);
            }
          }
        }
        let fieldCandidate = cleanSniffedText(listbox?.getAttribute?.('aria-label') || '');
        if (!fieldCandidate && listbox?.getAttribute?.('aria-labelledby')) {
          try {
            const lbl = document.getElementById(listbox.getAttribute('aria-labelledby'));
            if (lbl) fieldCandidate = cleanSniffedText(lbl.innerText || lbl.textContent || '');
          } catch { }
        }
        if (!fieldCandidate && listbox?.id) {
          try {
            const trigger = document.querySelector(`[aria-controls="${safeCssEscape(listbox.id)}"], [aria-owns="${safeCssEscape(listbox.id)}"]`);
            if (trigger) fieldCandidate = cleanSniffedText(trigger.getAttribute('aria-label') || trigger.innerText || trigger.textContent || '');
          } catch { }
        }
        if (!fieldCandidate) {
          fieldCandidate = cleanSniffedText(
            element.closest?.('.dropdown, .select-container, .form-group')?.querySelector?.('label, button')?.innerText ||
            element.closest?.('label')?.innerText ||
            listbox?.getAttribute?.('id') ||
            ''
          );
        }
        if (fieldCandidate && dropdownOptions.length > 0) {
          if (!columns.includes(fieldCandidate)) columns.push(fieldCandidate);
          fieldValues[fieldCandidate] = dropdownOptions.slice();
        }
      } else {
        const isCombobox = (typeof element.matches === 'function' && element.matches('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], mat-select, .mat-mdc-select-trigger, .dropdown-toggle, .ant-select-selector'))
          ? element
          : (element.closest?.('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], mat-select, .dropdown-toggle') || null);
        if (isCombobox) {
          let openMenu = null;
          const ctrlId = isCombobox.getAttribute?.('aria-controls') || isCombobox.getAttribute?.('aria-owns');
          if (ctrlId) {
            try { openMenu = document.getElementById(ctrlId); } catch { }
          }
          if (!openMenu) {
            openMenu = isCombobox.parentElement?.querySelector?.('.dropdown-menu, [role="listbox"], [role="menu"]') ||
              isCombobox.closest?.('.dropdown, .dropdown-container, .select-container, .custom-select, [role="combobox"]')?.querySelector?.('.dropdown-menu, [role="listbox"], [role="menu"]') ||
              document.querySelector?.('[role="listbox"], mat-select-panel, .mat-select-panel, .dropdown-menu.show, .dropdown-menu[style*="block"], .select2-dropdown, .ant-select-dropdown:not(.ant-select-dropdown-hidden)');
          }
          if (openMenu && typeof openMenu.querySelectorAll === 'function') {
            const siblingOpts = Array.from(openMenu.querySelectorAll('[role="option"], mat-option, .mat-mdc-option, .dropdown-item, [role="menuitem"], li, a'));
            for (let i = 0; i < Math.min(siblingOpts.length, 50); i++) {
              const opt = siblingOpts[i];
              const val = cleanSniffedText(opt.innerText || opt.textContent || '');
              if (val && !dropdownOptions.includes(val)) {
                dropdownOptions.push(val);
              }
            }
          }
          const fieldCandidate = cleanSniffedText(
            isCombobox.getAttribute?.('aria-label') ||
            isCombobox.getAttribute?.('name') ||
            (isCombobox.labels && isCombobox.labels[0]?.innerText) ||
            isCombobox.closest?.('label')?.innerText ||
            isCombobox.getAttribute?.('placeholder') ||
            isCombobox.getAttribute?.('id') ||
            ''
          );
          if (fieldCandidate && dropdownOptions.length > 0) {
            if (!columns.includes(fieldCandidate)) columns.push(fieldCandidate);
            fieldValues[fieldCandidate] = dropdownOptions.slice();
          }
        }
      }

      // 2c. Radio & Checkbox Groups
      const inputType = element.tagName === 'INPUT' ? (element.type || '').toLowerCase() : '';
      if (inputType === 'radio' || inputType === 'checkbox' || element.getAttribute?.('role') === 'radio') {
        const name = element.getAttribute?.('name');
        let groupItems = [];
        if (name) {
          try { groupItems = Array.from(document.querySelectorAll(`input[name="${safeCssEscape(name)}"]`)); } catch { }
        }
        if (groupItems.length === 0) {
          const fieldset = element.closest?.('fieldset, [role="radiogroup"], [role="group"]');
          if (fieldset) {
            groupItems = Array.from(fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
          }
        }
        if (groupItems.length > 1) {
          const groupVals = [];
          for (const item of groupItems) {
            const parentLabel = item.closest?.('label');
            const labelTxt = cleanSniffedText(parentLabel?.innerText || item.getAttribute?.('aria-label') || item.value || '');
            if (labelTxt && !groupVals.includes(labelTxt)) {
              groupVals.push(labelTxt);
            }
          }
          if (groupVals.length > 0) {
            const grpField = name || cleanSniffedText(element.closest?.('fieldset')?.querySelector?.('legend')?.textContent || '') || 'Group';
            groupInfo = { name: grpField, values: groupVals };
            if (!columns.includes(grpField)) columns.push(grpField);
            fieldValues[grpField] = groupVals;
          }
        }
      }
    } catch (err) {
      console.warn('[Workflow Capture] Sniffer notice:', err);
    }

    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
    if (elapsed > 5) {
      console.debug(`[Workflow Capture] Sniff took ${elapsed.toFixed(1)}ms`);
    }

    return {
      columns: Array.from(new Set(columns)),
      fieldValues,
      table: tableContext,
      options: dropdownOptions.length > 0 ? dropdownOptions : undefined,
      group: groupInfo || undefined
    };
  }

  /**
   * Safe helper to emit action to Node.js bridge across main frames and iframes
   */
  function emitAction(type, targetElement, extra = {}) {
    if (isPaused || !targetElement) return;

    targetElement = normalizeToInteractiveTarget(targetElement);

    // Normalize container clicks (e.g. DevExpress .dxm-content or .dxm-item) to inner icon if present
    if (targetElement.querySelector && !targetElement.getAttribute?.('title')) {
      const innerImg = targetElement.querySelector('img[title], [title]');
      if (innerImg && (targetElement.closest?.('.dxm-item, .x-btn, .toolbar') || targetElement.classList?.contains('dxm-content'))) {
        targetElement = innerImg;
      }
    }

    try {
      // Sniff contextual table columns, row values, dropdown options, and radio/checkbox groups
      let sniffedContext = null;
      try {
        sniffedContext = sniffElementContext(targetElement);
      } catch { }

      let target = null;
      if (window.SelectorResolver && typeof window.SelectorResolver.captureTarget === 'function') {
        try {
          target = window.SelectorResolver.captureTarget(targetElement);
        } catch (err) {
          console.warn('[Workflow Capture] captureTarget threw:', err);
        }
      }

      if (!target || !target.candidates || target.candidates.length === 0) {
        target = buildFallbackTarget(targetElement);
      }

      // Attach canvas coordinates to target payload if present
      if (extra.canvasCoords) {
        target.canvasCoords = extra.canvasCoords;
      }

      const isInsideIframe = (typeof window !== 'undefined' && window.self !== window.top);
      let frameInfo = null;
      if (isInsideIframe) {
        frameInfo = {
          isIframe: true,
          location: window.location.href,
          title: document.title || ''
        };
      }

      const friendlyName = target?.friendlyName || target?.elementName ||
        (window.SelectorResolver && typeof window.SelectorResolver.generateFriendlyName === 'function' ? window.SelectorResolver.generateFriendlyName(targetElement, target?.fingerprint) : null) ||
        'Element';

      const actionUid = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const cleanExtra = { ...extra };
      delete cleanExtra.canvasCoords;
      delete cleanExtra.captureTimestamp;
      const actionTimestamp = Date.now();
      const pageUrl = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : null;

      const mergedOptions = extra.options || extra.selectOptions || sniffedContext?.options;

      const payload = {
        uid: actionUid,
        type,
        name: friendlyName,
        elementName: friendlyName,
        timestamp: actionTimestamp,
        captureTimestamp: Number(extra.captureTimestamp) || actionTimestamp,
        target,
        scrollOffset: {
          x: Math.round(window.scrollX || window.pageXOffset || 0),
          y: Math.round(window.scrollY || window.pageYOffset || 0)
        },
        ...(pageUrl ? { url: pageUrl } : {}),
        ...(frameInfo ? { frame: frameInfo } : {}),
        ...(sniffedContext ? {
          context: sniffedContext,
          ...(sniffedContext.columns && sniffedContext.columns.length > 0 ? { columns: sniffedContext.columns } : {}),
          ...(sniffedContext.table ? { table: sniffedContext.table } : {}),
          ...(sniffedContext.fieldValues && Object.keys(sniffedContext.fieldValues).length > 0 ? { fieldValues: sniffedContext.fieldValues } : {}),
        } : {}),
        ...(mergedOptions && mergedOptions.length > 0 ? { options: mergedOptions, selectOptions: mergedOptions } : {}),
        ...cleanExtra
      };

      // 1. PRIMARY ZERO-DEPENDENCY TRANSPORT: Native console transport
      // Dispatches via CDP page.on('console') across all execution contexts, iframes, and after navigations
      try {
        const msgStr = '__WORKFLOW_CAPTURE_ACTION__:' + JSON.stringify(payload);
        console.debug(msgStr);
        console.info(msgStr);
      } catch { }

      // 2. Direct function on current window (if CDP binding is present)
      try {
        if (typeof window.__workflowCaptureEmitAction === 'function') {
          window.__workflowCaptureEmitAction(payload);
        }
      } catch { }

      // 3. Fallback: Route to top/parent window
      if (isInsideIframe) {
        try {
          if (window.top && window.top !== window && typeof window.top.__workflowCaptureEmitAction === 'function') {
            window.top.__workflowCaptureEmitAction(payload);
          }
        } catch { }

        try {
          if (window.parent && window.parent !== window && typeof window.parent.__workflowCaptureEmitAction === 'function') {
            window.parent.__workflowCaptureEmitAction(payload);
          }
        } catch { }

        try {
          if (window.top && window.top !== window) {
            window.top.postMessage({
              type: '__WORKFLOW_CAPTURE_EMIT_ACTION__',
              payload
            }, '*');
          }
        } catch { }
      }

      // 4. Reachable opener window function
      try {
        if (window.opener && typeof window.opener.__workflowCaptureEmitAction === 'function') {
          window.opener.__workflowCaptureEmitAction(payload);
        }
      } catch { }
    } catch (err) {
      console.error('[Workflow Capture] Failed to capture action:', err);
    }
  }

  /**
   * Helper to detect if an input element represents a password field,
   * even if an eye toggle has temporarily changed type="text"
   */
  function isPasswordField(element) {
    if (!element || element.tagName !== 'INPUT') return false;
    const type = (element.type || '').toLowerCase();
    if (type === 'password') {
      try { element.dataset.wfIsPassword = 'true'; } catch { }
      return true;
    }
    if (element.dataset && element.dataset.wfIsPassword === 'true') {
      return true;
    }
    const name = (element.name || '').toLowerCase();
    const id = (element.id || '').toLowerCase();
    const autocomplete = (element.getAttribute?.('autocomplete') || '').toLowerCase();
    if (/pass(word)?/i.test(name) || /pass(word)?/i.test(id) || /current-password|new-password/i.test(autocomplete)) {
      try { element.dataset.wfIsPassword = 'true'; } catch { }
      return true;
    }
    return false;
  }

  /**
   * Helper to detect if an element is a password visibility toggle (eye icon, reveal button)
   */
  function isPasswordVisibilityToggle(element) {
    if (!element || element.nodeType !== 1) return false;

    // 1. Never classify form submission, login, or action buttons as eye toggles!
    const tagName = element.tagName.toUpperCase();
    const type = (element.getAttribute?.('type') || element.type || '').toLowerCase();
    if (type === 'submit' || tagName === 'FORM' || tagName === 'INPUT') {
      return false;
    }

    const text = (element.textContent || '').trim().toLowerCase();
    // If it has substantial text, check if it's a login, sign-in, or submit button
    if (text.length > 0 && /(log ?in|sign ?in|submit|continue|next|enter|proceed|register|sign ?up|auth)/i.test(text)) {
      return false;
    }

    // 2. Check aria-label and title for explicit password toggle semantics
    const aria = (element.getAttribute?.('aria-label') || '').toLowerCase();
    const title = (element.getAttribute?.('title') || '').toLowerCase();
    const explicitTogglePattern = /(show|hide|toggle|reveal|view)\s*(password|pin|credentials?)|password\s*(visibility|toggle|reveal)/i;
    if (explicitTogglePattern.test(aria) || explicitTogglePattern.test(title)) {
      return true;
    }

    // 3. Check for dedicated eye icon classes / ids
    const cls = (typeof element.className === 'string' ? element.className : (element.getAttribute?.('class') || '')).toLowerCase();
    const id = (element.id || '').toLowerCase();
    const eyeClassPattern = /(fa-eye|fa-eye-slash|bi-eye|lucide-eye|feather-eye|icon-eye|eye-icon|password-toggle|toggle-password|reveal-password|pwd-toggle)/i;
    if (eyeClassPattern.test(cls) || eyeClassPattern.test(id)) {
      return true;
    }

    // 4. Check enclosing button / toggle container if element is an inner icon (svg, path, i, span)
    if (['SVG', 'PATH', 'I', 'SPAN', 'IMG'].includes(tagName)) {
      const parentBtn = (typeof element.closest === 'function')
        ? element.closest('button, [role="button"]')
        : null;
      if (parentBtn) {
        const pType = (parentBtn.getAttribute?.('type') || parentBtn.type || '').toLowerCase();
        if (pType === 'submit') return false;

        const pText = (parentBtn.textContent || '').trim().toLowerCase();
        if (pText.length > 0 && /(log ?in|sign ?in|submit|continue|next|enter|proceed)/i.test(pText)) {
          return false;
        }

        const pAria = (parentBtn.getAttribute?.('aria-label') || '').toLowerCase();
        const pTitle = (parentBtn.getAttribute?.('title') || '').toLowerCase();
        const pCls = (typeof parentBtn.className === 'string' ? parentBtn.className : (parentBtn.getAttribute?.('class') || '')).toLowerCase();
        const pId = (parentBtn.id || '').toLowerCase();

        if (explicitTogglePattern.test(pAria) || explicitTogglePattern.test(pTitle) || eyeClassPattern.test(pCls) || eyeClassPattern.test(pId)) {
          return true;
        }

        // SVG icon with eye class
        if (/\beye\b|eye-slash|eye-off/i.test(cls) || /\beye\b|eye-slash|eye-off/i.test(id)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Flush any active typing buffer as a single consolidated TYPE action
   */
  function flushInputBuffer() {
    if (!activeInputBuffer) return;
    const { element, value, isPassword, startTime } = activeInputBuffer;
    activeInputBuffer = null;

    if (isPaused) return;
    if (!element) return;

    // Capture the actual typed value (do not redact password)
    const finalValue = value;

    emitAction('TYPE', element, {
      value: finalValue,
      captureTimestamp: startTime,
      meta: {
        isPassword: Boolean(isPassword),
        charCount: (value || '').length
      }
    });
  }

  /**
   * Input event handler: Buffers text instead of spamming per-keystroke actions
   */
  function handleInput(event) {
    if (isPaused || isRecorderUiEvent(event)) return;
    const target = event.target;
    if (!target || !['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    const inputType = (target.type || '').toLowerCase();
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(inputType)) return;

    const isPassword = isPasswordField(target);
    const currentValue = target.value || '';

    if (activeInputBuffer && activeInputBuffer.element === target) {
      activeInputBuffer.value = currentValue;
      if (isPassword) activeInputBuffer.isPassword = true;
    } else {
      flushInputBuffer();
      activeInputBuffer = {
        element: target,
        value: currentValue,
        isPassword,
        startTime: Date.now()
      };
    }
  }

  /**
   * Flush on blur or focusout
   */
  function handleBlur(event) {
    if (isPaused || isRecorderUiEvent(event)) return;
    if (activeInputBuffer && activeInputBuffer.element === event.target) {
      flushInputBuffer();
    }
  }

  /**
   * Keydown listener to detect Enter/Tab/Escape submission & key actions
   */
  function handleKeyDown(event) {
    if (isPaused || isRecorderUiEvent(event)) return;
    flushPendingClick();
    const key = event.key;
    const target = event.target;
    const captureTimestamp = Date.now();

    if (key === 'Enter') {
      if (activeInputBuffer && activeInputBuffer.element === target) {
        flushInputBuffer();
      }

      emitAction('KEY_PRESS', target || document.activeElement || document.body, {
        key: 'Enter',
        captureTimestamp,
        code: event.code || 'Enter',
        keyCode: event.keyCode || 13,
        value: 'Enter',
        meta: {
          key: 'Enter',
          isSubmit: true
        }
      });
    } else if (key === 'Tab' || key === 'Escape') {
      if (activeInputBuffer && activeInputBuffer.element === target) {
        flushInputBuffer();
      }
      emitAction('KEY_PRESS', target || document.activeElement || document.body, {
        key: key,
        captureTimestamp,
        code: event.code || key,
        keyCode: event.keyCode,
        value: key,
        meta: {
          key: key
        }
      });
    }
  }

  let scrollDebounceTimer = null;
  let lastEmittedScroll = { x: 0, y: 0, target: null };

  /**
   * Safe helper to emit SCROLL action to Node.js bridge
   */
  function emitScrollAction({ isWindow, scrollX, scrollY, targetElement }) {
    if (isPaused) return;

    try {
      let target = null;
      let friendlyName = isWindow ? 'Scroll Page' : 'Scroll Container';

      if (!isWindow && targetElement && targetElement.nodeType === 1) {
        if (window.SelectorResolver && typeof window.SelectorResolver.captureTarget === 'function') {
          try {
            target = window.SelectorResolver.captureTarget(targetElement);
          } catch { }
        }
        if (!target || !target.candidates || target.candidates.length === 0) {
          target = buildFallbackTarget(targetElement);
        }
        friendlyName = `Scroll ${target?.friendlyName || target?.elementName || 'Container'}`;
      }

      const isInsideIframe = (typeof window !== 'undefined' && window.self !== window.top);
      let frameInfo = null;
      if (isInsideIframe) {
        frameInfo = {
          isIframe: true,
          location: window.location.href,
          title: document.title || ''
        };
      }

      const actionUid = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const actionTimestamp = Date.now();
      const pageUrl = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : null;

      const payload = {
        uid: actionUid,
        type: 'SCROLL',
        name: friendlyName,
        elementName: friendlyName,
        timestamp: actionTimestamp,
        captureTimestamp: actionTimestamp,
        scrollX,
        scrollY,
        isWindow: Boolean(isWindow),
        target: target || null,
        scrollOffset: {
          x: Math.round(window.scrollX || window.pageXOffset || 0),
          y: Math.round(window.scrollY || window.pageYOffset || 0)
        },
        ...(pageUrl ? { url: pageUrl } : {}),
        ...(frameInfo ? { frame: frameInfo } : {})
      };

      try {
        const msgStr = '__WORKFLOW_CAPTURE_ACTION__:' + JSON.stringify(payload);
        console.debug(msgStr);
        console.info(msgStr);
      } catch { }

      if (typeof window.__workflowCaptureEmitAction === 'function') {
        window.__workflowCaptureEmitAction(payload);
      }

      if (isInsideIframe) {
        if (window.top && window.top !== window && typeof window.top.__workflowCaptureEmitAction === 'function') {
          window.top.__workflowCaptureEmitAction(payload);
        }
      }
    } catch (err) {
      console.warn('[Workflow Capture] emitScrollAction error:', err);
    }
  }

  /**
   * Debounced scroll event listener (400ms) to capture window or container scroll
   */
  function handleScroll(event) {
    if (isPaused || isRecorderUiEvent(event)) return;

    if (scrollDebounceTimer) {
      clearTimeout(scrollDebounceTimer);
    }

    const scrollTarget = event?.target;

    scrollDebounceTimer = setTimeout(() => {
      try {
        const isDocOrWindow = !scrollTarget ||
          scrollTarget === document ||
          scrollTarget === window ||
          scrollTarget === document.documentElement ||
          scrollTarget === document.body;

        if (isDocOrWindow) {
          const currentX = Math.round(window.scrollX || window.pageXOffset || 0);
          const currentY = Math.round(window.scrollY || window.pageYOffset || 0);

          if (Math.abs(currentX - lastEmittedScroll.x) < 50 && Math.abs(currentY - lastEmittedScroll.y) < 50) {
            return;
          }

          lastEmittedScroll = { x: currentX, y: currentY, target: null };

          emitScrollAction({
            isWindow: true,
            scrollX: currentX,
            scrollY: currentY,
            targetElement: null
          });
        } else if (scrollTarget && scrollTarget.nodeType === 1) {
          // Container scroll
          const currentX = Math.round(scrollTarget.scrollLeft || 0);
          const currentY = Math.round(scrollTarget.scrollTop || 0);

          if (lastEmittedScroll.target === scrollTarget &&
            Math.abs(currentX - lastEmittedScroll.x) < 50 &&
            Math.abs(currentY - lastEmittedScroll.y) < 50) {
            return;
          }

          lastEmittedScroll = { x: currentX, y: currentY, target: scrollTarget };

          emitScrollAction({
            isWindow: false,
            scrollX: currentX,
            scrollY: currentY,
            targetElement: scrollTarget
          });
        }
      } catch (err) {
        console.warn('[Workflow Capture] handleScroll error:', err);
      }
    }, 400);
  }

  /**
   * Helper to detect if an element is or is part of a checkbox control
   */
  function detectCheckbox(element) {
    if (!element || element.nodeType !== 1) return null;

    if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes((element.type || '').toLowerCase())) {
      return { element, input: element };
    }
    const role = (element.getAttribute?.('role') || '').toLowerCase();
    if (role === 'checkbox' || role === 'switch' || element.hasAttribute?.('aria-checked') || element.hasAttribute?.('aria-pressed')) {
      const childInput = element.querySelector?.('input[type="checkbox"], input[type="radio"]');
      return { element, input: childInput || null };
    }
    if (element.tagName === 'MAT-PSEUDO-CHECKBOX' || (element.classList && element.classList.contains('mat-pseudo-checkbox'))) {
      return { element, input: null };
    }

    // Check parent label or label associated via `for` / `htmlFor`
    if (element.tagName === 'LABEL' || element.closest?.('label')) {
      const lbl = element.tagName === 'LABEL' ? element : element.closest('label');
      const forId = lbl.htmlFor || lbl.getAttribute?.('for');
      if (forId) {
        try {
          const forInput = document.getElementById(forId);
          if (forInput && forInput.tagName === 'INPUT' && ['checkbox', 'radio'].includes((forInput.type || '').toLowerCase())) {
            return { element: lbl, input: forInput };
          }
        } catch {}
      }
      const innerInput = lbl.querySelector?.('input[type="checkbox"], input[type="radio"]');
      if (innerInput) {
        return { element: lbl, input: innerInput };
      }
    }

    const container = element.closest?.('mat-checkbox, dx-check-box, [role="checkbox"], [role="switch"], .mat-mdc-checkbox, .dx-checkbox, .ant-checkbox-wrapper, .ant-checkbox');
    if (container) {
      const innerInput = container.querySelector?.('input[type="checkbox"], input[type="radio"]');
      return { element: container, input: innerInput };
    }

    const childInput = element.querySelector?.('input[type="checkbox"], input[type="radio"]');
    if (childInput) {
      return { element, input: childInput };
    }

    // Check parent mat-option or [role="option"] for dropdown multi-select checkboxes
    const optionContainer = element.closest?.('mat-option, [role="option"], .mat-mdc-option');
    if (optionContainer) {
      const innerCb = optionContainer.querySelector?.('mat-pseudo-checkbox, .mat-pseudo-checkbox, [role="checkbox"], input[type="checkbox"]');
      if (innerCb || optionContainer.classList?.contains('mat-mdc-option-multiple') || optionContainer.getAttribute?.('aria-selected') !== null) {
        return { element: optionContainer, input: innerCb };
      }
    }

    // Modern component data attributes (Radix UI, shadcn, Mantine)
    if (element.hasAttribute?.('data-state') || element.hasAttribute?.('data-checked')) {
      return { element, input: null };
    }

    return null;
  }

  /**
   * Helper to inspect the current or post-interaction checked state of a checkbox
   */
  function readCheckboxChecked(cbInfo) {
    if (!cbInfo || !cbInfo.element) return false;
    const { element, input } = cbInfo;

    if (input && typeof input.checked === 'boolean') {
      return Boolean(input.checked);
    }
    if (element.tagName === 'INPUT' && typeof element.checked === 'boolean') {
      return Boolean(element.checked);
    }

    // Check parent mat-option or [role="option"] for dropdown multi-select checkboxes
    const opt = element.closest?.('mat-option, [role="option"], .mat-mdc-option, .mat-option');
    if (opt) {
      const ariaSelected = opt.getAttribute?.('aria-selected');
      if (ariaSelected !== null && ariaSelected !== undefined) {
        return ariaSelected === 'true';
      }
      if (opt.classList) {
        if (opt.classList.contains('mat-mdc-option-selected') ||
          opt.classList.contains('mat-option-selected') ||
          opt.classList.contains('selected') ||
          opt.classList.contains('is-selected')) {
          return true;
        }
      }
      if (opt.querySelector?.('.mat-pseudo-checkbox-checked')) {
        return true;
      }
    }

    const aria = element.getAttribute?.('aria-checked') ??
      element.querySelector?.('[aria-checked]')?.getAttribute?.('aria-checked') ??
      element.closest?.('[aria-checked]')?.getAttribute?.('aria-checked');
    if (aria !== null && aria !== undefined) {
      return aria === 'true';
    }

    const pressed = element.getAttribute?.('aria-pressed') ??
      element.querySelector?.('[aria-pressed]')?.getAttribute?.('aria-pressed');
    if (pressed !== null && pressed !== undefined) {
      return pressed === 'true';
    }

    const dataState = element.getAttribute?.('data-state') ??
      element.querySelector?.('[data-state]')?.getAttribute?.('data-state') ??
      element.closest?.('[data-state]')?.getAttribute?.('data-state');
    if (dataState === 'checked' || dataState === 'on') return true;
    if (dataState === 'unchecked' || dataState === 'off') return false;

    const dataChecked = element.getAttribute?.('data-checked') ??
      element.querySelector?.('[data-checked]')?.getAttribute?.('data-checked') ??
      element.closest?.('[data-checked]')?.getAttribute?.('data-checked');
    if (dataChecked === 'true' || dataChecked === '') return true;
    if (dataChecked === 'false') return false;

    const matCb = element.closest?.('mat-checkbox, .mat-mdc-checkbox, dx-check-box, .ant-checkbox-wrapper, .ant-checkbox');
    if (matCb && matCb.classList) {
      if (matCb.classList.contains('mat-mdc-checkbox-checked') ||
        matCb.classList.contains('mat-checkbox-checked') ||
        matCb.classList.contains('dx-checkbox-checked') ||
        matCb.classList.contains('ant-checkbox-checked') ||
        matCb.classList.contains('ant-checkbox-wrapper-checked')) {
        return true;
      }
    }

    if (element.classList) {
      if (element.classList.contains('mat-mdc-checkbox-checked') ||
        element.classList.contains('mat-checkbox-checked') ||
        element.classList.contains('dx-checkbox-checked') ||
        element.classList.contains('ant-checkbox-checked') ||
        element.classList.contains('mat-pseudo-checkbox-checked') ||
        element.classList.contains('checked') ||
        element.classList.contains('is-checked')) {
        return true;
      }
    }
    const pseudo = element.querySelector?.('.mat-pseudo-checkbox-checked');
    if (pseudo) return true;

    return false;
  }

  /**
   * Change event handler for SELECT dropdowns and checkboxes/radios
   */
  function handleChange(event) {
    if (isPaused || isRecorderUiEvent(event)) return;
    const target = event.target;
    if (!target) return;
    const captureTimestamp = Date.now();

    if (target.tagName === 'SELECT') {
      const selectedOption = target.options[target.selectedIndex];
      const selectedValue = selectedOption ? selectedOption.value : target.value;
      const selectedText = selectedOption ? selectedOption.text.trim() : '';
      const allOptions = Array.from(target.options || []).map(o => (o.text || o.value || '').trim()).filter(Boolean);

      emitAction('SELECT', target, {
        value: selectedValue,
        captureTimestamp,
        options: allOptions,
        selectOptions: allOptions,
        meta: {
          text: selectedText,
          selectedIndex: target.selectedIndex
        }
      });
    } else if (target.tagName === 'INPUT' && ['checkbox', 'radio'].includes((target.type || '').toLowerCase())) {
      const now = Date.now();
      const isChecked = Boolean(target.checked);
      if (lastHandledTarget && isSameTarget(lastHandledTarget, target) && target._lastEmittedChecked === isChecked && (now - lastHandledEventTime) < 300) {
        return;
      }
      target._lastEmittedChecked = isChecked;
      lastHandledEventTime = now;
      lastHandledTarget = target;
      emitAction('CLICK', target, {
        isCheckbox: true,
        captureTimestamp,
        desiredState: isChecked,
        checked: isChecked,
        ...(isChecked === false ? { isUncheck: true } : {}),
        meta: {
          triggerSignal: 'change',
          checked: isChecked
        }
      });
    } else if (['INPUT', 'TEXTAREA'].includes(target.tagName)) {
      if (activeInputBuffer && activeInputBuffer.element === target) {
        flushInputBuffer();
      }
    }
  }

  /**
   * Core interaction event processor for CLICK actions across multiple signals:
   * pointerdown, mousedown, click, mouseup, pointerup.
   * Deduplicates rapid signals on the same target within 250ms,
   * so an action is captured even if frameworks swallow click or use mousedown-only.
   */
  function handleInteractionEvent(event, signalType) {
    if (isPaused || isRecorderUiEvent(event)) return;

    // Ignore programmatic synthetic events (e.g. scripts calling element.click() to download blobs)
    if (event.isTrusted === false) {
      return;
    }

    const rawTarget = event.target;
    if (!rawTarget) return;

    // Ignore transient programmatic download anchors (<a href="blob:..." download> created and clicked by JS)
    if (rawTarget.tagName === 'A') {
      const href = rawTarget.getAttribute?.('href') || rawTarget.href || '';
      const isBlob = typeof href === 'string' && (href.startsWith('blob:') || href.includes('blob:'));
      const isZero = (rawTarget.offsetWidth === 0 && rawTarget.offsetHeight === 0);
      const hasDownloadAttr = rawTarget.hasAttribute?.('download');
      if ((isBlob || isZero || hasDownloadAttr) && (!rawTarget.textContent || rawTarget.textContent.trim().length === 0)) {
        return;
      }
    }

    // Don't record CLICK on select elements (handled by change)
    if (rawTarget.tagName === 'SELECT' || rawTarget.tagName === 'OPTION') {
      return;
    }

    // Don't record clicks on password visibility toggles (eye icons, show/hide password buttons)
    if (isPasswordVisibilityToggle(rawTarget)) {
      if (activeInputBuffer) {
        flushInputBuffer();
      }
      return;
    }

    // Flush any pending typing if clicking on a different element
    if (activeInputBuffer && activeInputBuffer.element !== rawTarget) {
      flushInputBuffer();
    }

    // Elevate leaf elements (svg, path, icon, span) to nearest interactive container
    let target = normalizeToInteractiveTarget(rawTarget);
    if (target.querySelector && !target.getAttribute?.('title')) {
      const innerImg = target.querySelector('img[title], [title]');
      if (innerImg && (target.closest?.('.dxm-item, .x-btn, .toolbar') || target.classList?.contains('dxm-content'))) {
        target = innerImg;
      }
    }

    if (isPasswordVisibilityToggle(target)) {
      if (activeInputBuffer) {
        flushInputBuffer();
      }
      return;
    }

    const now = Date.now();
    const canvasCoords = buildCanvasCoordsIfApplicable(rawTarget, event);

    // Double-click detection via W3C event.detail
    if (event.detail === 2) {
      lastHandledEventTime = now;
      lastHandledTarget = target;
      emitAction('DOUBLE_CLICK', target, {
        detail: 2,
        triggerSignal: signalType,
        captureTimestamp: now,
        ...(canvasCoords ? { canvasCoords } : {})
      });
      return;
    }

    // Deduplicate rapid signals on same target within 250ms
    if (lastHandledTarget && isSameTarget(lastHandledTarget, target) && (now - lastHandledEventTime) < 250) {
      return;
    }

    lastHandledEventTime = now;
    lastHandledTarget = target;

    // Checkbox State Detection:
    // Determine the exact user-intended state:
    // If the checkbox was clicked, inspect post-interaction state.
    // If it started checked and ended unchecked -> desiredState: false, isUncheck: true.
    // If it started unchecked and ended checked -> desiredState: true.
    // If DOM hasn't updated yet at 70ms: infer toggle from initial state (!initialChecked).
    const cbInfo = detectCheckbox(target);
    if (cbInfo) {
      const initialChecked = readCheckboxChecked(cbInfo);
      setTimeout(() => {
        const postChecked = readCheckboxChecked(cbInfo);
        let finalDesired;
        if (initialChecked !== postChecked) {
          finalDesired = postChecked;
        } else {
          finalDesired = !initialChecked;
        }
        const isTrueUncheck = (finalDesired === false);

        emitAction('CLICK', target, {
          detail: event.detail || 1,
          triggerSignal: signalType,
          captureTimestamp: now,
          isCheckbox: true,
          desiredState: finalDesired,
          checked: finalDesired,
          ...(isTrueUncheck ? { isUncheck: true } : {}),
          ...(canvasCoords ? { canvasCoords } : {})
        });
      }, 70);
      return;
    }

    emitAction('CLICK', target, {
      detail: event.detail || 1,
      triggerSignal: signalType,
      captureTimestamp: now,
      ...(canvasCoords ? { canvasCoords } : {})
    });
  }


  /**
   * Universal action emitter accessible across injected contexts
   */
  window.__recordAction = function (rawAction) {
    if (isPaused || !rawAction) return;
    const actionUid = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const actionTimestamp = rawAction.timestamp || Date.now();
    const pageUrl = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href : null;
    const isInsideIframe = (typeof window !== 'undefined' && window.self !== window.top);
    let frameInfo = null;
    if (isInsideIframe) {
      frameInfo = {
        isIframe: true,
        location: window.location.href,
        title: document.title || ''
      };
    }

    const payload = {
      uid: actionUid,
      type: rawAction.type,
      name: rawAction.name || rawAction.fieldName || rawAction.type,
      elementName: rawAction.name || rawAction.fieldName || rawAction.type,
      timestamp: actionTimestamp,
      captureTimestamp: actionTimestamp,
      target: rawAction.target || null,
      scrollOffset: {
        x: Math.round(window.scrollX || window.pageXOffset || 0),
        y: Math.round(window.scrollY || window.pageYOffset || 0)
      },
      ...(pageUrl ? { url: pageUrl } : {}),
      ...(frameInfo ? { frame: frameInfo } : {}),
      ...(rawAction.fieldName ? { fieldName: rawAction.fieldName, columnName: rawAction.fieldName } : {}),
      ...(rawAction.columnName ? { columnName: rawAction.columnName } : {}),
      ...(rawAction.sampleValue !== undefined ? { sampleValue: rawAction.sampleValue } : {}),
      ...rawAction
    };

    try {
      const msgStr = '__WORKFLOW_CAPTURE_ACTION__:' + JSON.stringify(payload);
      console.debug(msgStr);
      console.info(msgStr);
    } catch { }

    try {
      if (typeof window.__workflowCaptureEmitAction === 'function') {
        window.__workflowCaptureEmitAction(payload);
      }
    } catch { }

    if (isInsideIframe) {
      try {
        if (window.top && window.top !== window && typeof window.top.__workflowCaptureEmitAction === 'function') {
          window.top.__workflowCaptureEmitAction(payload);
        }
      } catch { }
    }
  };

  function cleanToIdentifier(str) {
    if (!str || typeof str !== 'string') return 'Extracted_Field';
    let s = str.replace(/[:*#?!]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/[^a-zA-Z0-9_\s]/g, '');
    s = s.trim().replace(/\s+/g, '_');
    if (!s) return 'Extracted_Field';
    if (/^[0-9]/.test(s)) s = 'Field_' + s;
    return s.slice(0, 40);
  }

  function inferFieldName(el) {
    if (!el || el.nodeType !== 1) return 'Extracted_Field';
    const aria = el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.getAttribute?.('title') || el.getAttribute?.('name') || '';
    if (aria && aria.trim().length > 1 && aria.trim().length < 40) {
      return cleanToIdentifier(aria);
    }

    if (el.id) {
      try {
        const labelEl = document.querySelector(`label[for="${safeCssEscape(el.id)}"]`);
        if (labelEl && labelEl.innerText) {
          return cleanToIdentifier(labelEl.innerText);
        }
      } catch { }
    }
    const parentLabel = el.closest?.('label');
    if (parentLabel && parentLabel.innerText) {
      const txt = parentLabel.innerText.replace(el.innerText || '', '').trim();
      if (txt) return cleanToIdentifier(txt);
    }

    let prev = el.previousElementSibling;
    while (prev) {
      if (['LABEL', 'TH', 'DT', 'SPAN', 'STRONG', 'B'].includes(prev.tagName) && prev.innerText?.trim()) {
        return cleanToIdentifier(prev.innerText);
      }
      prev = prev.previousElementSibling;
    }

    const td = el.closest?.('td, [role="cell"]');
    if (td && td.parentElement) {
      const colIndex = Array.from(td.parentElement.children).indexOf(td);
      const table = td.closest('table, [role="grid"], [role="table"]');
      if (table && colIndex >= 0) {
        const ths = table.querySelectorAll('th, [role="columnheader"]');
        if (ths[colIndex] && ths[colIndex].innerText?.trim()) {
          return cleanToIdentifier(ths[colIndex].innerText);
        }
      }
    }

    const rowContainer = el.closest?.('tr, div, dl, p');
    if (rowContainer) {
      const textNodes = Array.from(rowContainer.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim());
      if (textNodes.length > 0) {
        const firstText = textNodes[0].textContent.replace(/[:\-]/g, '').trim();
        if (firstText && firstText.length < 30) {
          return cleanToIdentifier(firstText);
        }
      }
    }

    const text = (el.innerText || el.textContent || '').trim().slice(0, 30);
    if (text && !/^\d+$/.test(text) && text.length < 25) {
      return cleanToIdentifier(text);
    }

    return 'Extracted_Field';
  }

  function flashElementCapturedBadge(el, fieldName) {
    try {
      const rect = el.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.setAttribute('data-reflow-ignore', 'true');
      Object.assign(badge.style, {
        position: 'fixed',
        top: Math.max(4, rect.top - 26) + 'px',
        left: Math.max(4, rect.left) + 'px',
        background: '#059669',
        color: '#ffffff',
        fontSize: '11px',
        fontWeight: '700',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '3px 8px',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        transition: 'opacity 300ms ease, transform 300ms ease',
        transform: 'translateY(0)',
        opacity: '1'
      });
      badge.textContent = '✓ Captured: ' + fieldName;
      document.body.appendChild(badge);
      setTimeout(() => {
        badge.style.opacity = '0';
        badge.style.transform = 'translateY(-6px)';
        setTimeout(() => badge.remove(), 350);
      }, 1800);
    } catch { }
  }

  let activeHoverEl = null;
  let hoverOverlay = null;

  function updateHoverOverlay(el) {
    if (window.__reflowRecorderMode !== 'CAPTURE_FIELD' || !el || el === document.body || el === document.documentElement || isRecorderUiEvent({ target: el })) {
      if (hoverOverlay && hoverOverlay.parentNode) hoverOverlay.remove();
      activeHoverEl = null;
      return;
    }
    activeHoverEl = el;
    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = '__reflow_hover_overlay__';
      hoverOverlay.setAttribute('data-reflow-ignore', 'true');
      Object.assign(hoverOverlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        border: '2px solid #10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.12)',
        borderRadius: '4px',
        zIndex: '2147483646',
        transition: 'all 60ms ease-out',
        boxSizing: 'border-box'
      });
    }
    const rect = el.getBoundingClientRect();
    hoverOverlay.style.top = rect.top + 'px';
    hoverOverlay.style.left = rect.left + 'px';
    hoverOverlay.style.width = rect.width + 'px';
    hoverOverlay.style.height = rect.height + 'px';
    if (!hoverOverlay.parentNode && document.body) {
      document.body.appendChild(hoverOverlay);
    }
  }

  function detectPrimaryTable() {
    const selectors = [
      'table:not([data-reflow-ignore])',
      '[role="grid"]',
      '[role="table"]',
      '.x-grid-view',
      '.ag-root',
      '.dxgvTable',
      '.v-data-table',
      '.mat-table'
    ];
    for (const sel of selectors) {
      const tables = Array.from(document.querySelectorAll(sel))
        .filter(t => !isRecorderUiEvent({ target: t }));
      if (tables.length > 0) {
        let best = tables[0];
        let maxScore = 0;
        for (const t of tables) {
          const rect = t.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const rows = t.querySelectorAll('tr, [role="row"]').length;
            const score = (rect.width * rect.height) + (rows * 5000);
            if (score > maxScore) {
              maxScore = score;
              best = t;
            }
          }
        }
        return best;
      }
    }
    return null;
  }

  function handleFieldCaptureClick(event) {
    try {
      const targetEl = event.target;
      if (!targetEl || isRecorderUiEvent(event)) return;

      let targetFingerprint = null;
      if (window.SelectorResolver && typeof window.SelectorResolver.captureTarget === 'function') {
        try {
          targetFingerprint = window.SelectorResolver.captureTarget(targetEl);
        } catch (err) {
          console.warn('[Workflow Capture] captureTarget error:', err);
        }
      }
      if (!targetFingerprint || !targetFingerprint.candidates || targetFingerprint.candidates.length === 0) {
        targetFingerprint = buildFallbackTarget(targetEl);
      }

      const sampleText = (targetEl.value || targetEl.innerText || targetEl.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

      const inferredName = inferFieldName(targetEl);
      const chosenFieldName = (inferredName || 'Extracted_Field').trim();

      const actionPayload = {
        type: 'EXTRACT_TEXT',
        name: 'Extract ' + chosenFieldName,
        elementName: 'Extract ' + chosenFieldName,
        fieldName: chosenFieldName,
        columnName: chosenFieldName,
        sampleValue: sampleText,
        value: chosenFieldName,
        timestamp: Date.now(),
        url: window.location.href,
        target: targetFingerprint
      };

      if (typeof window.__recordAction === 'function') {
        window.__recordAction(actionPayload);
      } else {
        emitAction('EXTRACT_TEXT', targetEl, {
          fieldName: chosenFieldName,
          columnName: chosenFieldName,
          sampleValue: sampleText,
          value: chosenFieldName
        });
      }

      flashElementCapturedBadge(targetEl, chosenFieldName);
    } catch (err) {
      console.warn('[Workflow Capture] handleFieldCaptureClick error:', err);
    } finally {
      // Guaranteed reset back to ACTION mode so subsequent interactions are captured normally
      window.__reflowRecorderMode = 'ACTION';
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.style.cursor = '';
        }
        const hud = document.getElementById('__reflow_recorder_hud__');
        if (hud && hud.shadowRoot) {
          const btnAction = hud.shadowRoot.getElementById('btnAction');
          const btnCapture = hud.shadowRoot.getElementById('btnCapture');
          if (btnAction) btnAction.classList.add('active-action');
          if (btnCapture) btnCapture.classList.remove('active-capture');
        }
        const hoverEl = document.getElementById('__reflow_hover_overlay__');
        if (hoverEl && hoverEl.parentNode) hoverEl.remove();
      } catch { }
    }
  }

  function renderReflowRecorderHud() {
    try {
      if (typeof window === 'undefined' || window !== window.top) return;
      if (typeof document === 'undefined') return;
      if (document.getElementById('__reflow_recorder_hud__')) return;

      const container = document.body || document.documentElement;
      if (!container) return;

      window.__reflowRecorderMode = window.__reflowRecorderMode || 'ACTION';

      const hud = document.createElement('div');
      hud.id = '__reflow_recorder_hud__';
      hud.setAttribute('data-reflow-ignore', 'true');
      Object.assign(hud.style, {
        position: 'fixed',
        bottom: '18px',
        right: '18px',
        zIndex: '2147483647',
        pointerEvents: 'auto'
      });
      hud.style.setProperty('position', 'fixed', 'important');
      hud.style.setProperty('bottom', '18px', 'important');
      hud.style.setProperty('right', '18px', 'important');
      hud.style.setProperty('z-index', '2147483647', 'important');

      const shadow = hud.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .hud-pill {
          position: relative;
          display: flex;
          align-items: center;
          gap: 6px;
          background: #0f172a;
          padding: 5px 8px;
          border-radius: 9999px;
          border: 1px solid #334155;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
          user-select: none;
        }
        .hud-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 600;
          border-radius: 9999px;
          border: 1px solid transparent;
          background: transparent;
          color: #94a3b8;
          cursor: pointer;
          transition: all 140ms ease;
          white-space: nowrap;
        }
        .hud-btn:hover {
          color: #f1f5f9;
          background: rgba(255, 255, 255, 0.08);
        }
        .hud-btn.active-action {
          background: #1e293b;
          color: #38bdf8;
          border-color: #0284c7;
          box-shadow: 0 0 10px rgba(14, 165, 233, 0.3);
        }
        .hud-btn.active-capture {
          background: rgba(16, 185, 129, 0.2);
          color: #34d399;
          border-color: #10b981;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.35);
        }
        .toast {
          position: absolute;
          bottom: calc(100% + 8px);
          right: 0;
          background: #059669;
          color: #fff;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 200ms ease, transform 200ms ease;
          pointer-events: none;
          white-space: nowrap;
        }
        .toast.visible {
          opacity: 1;
          transform: translateY(0);
        }
      </style>
      <div class="hud-pill">
        <button type="button" class="hud-btn active-action" id="btnAction" title="Standard Interaction Mode">
          <span>🖱️</span><span>Action Mode</span>
        </button>
        <button type="button" class="hud-btn" id="btnCapture" title="Click any value to extract to Excel">
          <span>📊</span><span>Capture Field</span>
        </button>
        <button type="button" class="hud-btn" id="btnScrapeTable" title="Detect & scrape table on page">
          <span>📋</span><span>Scrape Table</span>
        </button>
        <div class="toast" id="hudToast"></div>
      </div>
    `;

      const btnAction = shadow.getElementById('btnAction');
      const btnCapture = shadow.getElementById('btnCapture');
      const btnScrapeTable = shadow.getElementById('btnScrapeTable');
      const toast = shadow.getElementById('hudToast');

      const showToast = (msg, isError = false) => {
        if (!toast) return;
        toast.textContent = msg;
        toast.style.background = isError ? '#ef4444' : '#059669';
        toast.classList.add('visible');
        setTimeout(() => toast.classList.remove('visible'), 2400);
      };

      const setMode = (mode) => {
        window.__reflowRecorderMode = mode;
        if (mode === 'CAPTURE_FIELD') {
          btnCapture.classList.add('active-capture');
          btnAction.classList.remove('active-action');
          document.documentElement.style.cursor = 'crosshair';
          showToast('Capture Field Mode: Click any value to extract');
        } else {
          btnAction.classList.add('active-action');
          btnCapture.classList.remove('active-capture');
          document.documentElement.style.cursor = '';
          if (hoverOverlay && hoverOverlay.parentNode) hoverOverlay.remove();
          activeHoverEl = null;
        }
      };

      btnAction.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMode('ACTION');
      });

      btnCapture.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMode(window.__reflowRecorderMode === 'CAPTURE_FIELD' ? 'ACTION' : 'CAPTURE_FIELD');
      });

      btnScrapeTable.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tableEl = detectPrimaryTable();
        if (!tableEl) {
          showToast('No table detected on current page', true);
          return;
        }

        let targetFingerprint = null;
        if (window.SelectorResolver && typeof window.SelectorResolver.captureTarget === 'function') {
          try {
            targetFingerprint = window.SelectorResolver.captureTarget(tableEl);
          } catch { }
        }
        if (!targetFingerprint || !targetFingerprint.candidates || targetFingerprint.candidates.length === 0) {
          targetFingerprint = buildFallbackTarget(tableEl);
        }

        const tablePayload = {
          type: 'EXTRACT_TABLE',
          name: 'Full Table Export',
          elementName: 'Full Table Export',
          fieldName: 'Full_Table_Export',
          columnName: 'Full_Table_Export',
          timestamp: Date.now(),
          url: window.location.href,
          target: targetFingerprint
        };

        if (typeof window.__recordAction === 'function') {
          window.__recordAction(tablePayload);
        } else {
          emitAction('EXTRACT_TABLE', tableEl, { fieldName: 'Full_Table_Export' });
        }

        showToast('📋 Table Scrape Captured!');
      });

      container.appendChild(hud);
    } catch (err) {
      console.warn('[Workflow Capture] Failed to render Reflow HUD:', err);
    }
  }

  const onPointerDown = (e) => {
    if (isRecorderUiEvent(e)) return;
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    handlePointerDownDiag(e);
    handleInteractionEvent(e, 'pointerdown');
  };
  const onMouseDown = (e) => {
    if (isRecorderUiEvent(e)) return;
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    handlePointerDownDiag(e);
    handleInteractionEvent(e, 'mousedown');
  };
  const onClick = (e) => {
    if (isRecorderUiEvent(e)) return;
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleFieldCaptureClick(e);
      return;
    }
    handleInteractionEvent(e, 'click');
  };
  const onPointerUp = (e) => {
    if (isRecorderUiEvent(e)) return;
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    handleInteractionEvent(e, 'pointerup');
  };
  const onMouseUp = (e) => {
    if (isRecorderUiEvent(e)) return;
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    handleInteractionEvent(e, 'mouseup');
  };

  /**
   * Optional visual badge to let the user know recording is active in Chrome
   * Strictly rendered only on the top window, NEVER in child iframes
   */
  function renderRecordingBadge() {
    try {
      if (typeof window !== 'undefined' && window.self !== window.top) return;
    } catch { }

    if (document.getElementById('__workflow_capture_badge__')) return;
    const container = document.body || document.documentElement;
    if (!container) return;

    const badge = document.createElement('div');
    badge.id = '__workflow_capture_badge__';
    const shadow = badge.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; top: 14px; right: 14px; z-index: 2147483647; pointer-events: auto; font-family: "Plus Jakarta Sans", Inter, "Segoe UI", sans-serif; color-scheme: light; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .root { display: flex; align-items: center; gap: 9px; }
        .panel { width: 208px; padding: 11px; border: 1px solid rgba(255,255,255,.12); border-radius: 15px; background: #111827; color: #f8fafc; box-shadow: 0 12px 32px rgba(15,23,42,.28), 0 2px 6px rgba(15,23,42,.18); transform-origin: top right; animation: panel-in 160ms ease-out; }
        .is-collapsed .panel { display: none; }
        @keyframes panel-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .topline, .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .topline { margin-bottom: 9px; }
        .status { display: inline-flex; align-items: center; gap: 7px; min-width: 0; color: #cbd5e1; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.16); }
        .paused .dot { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.16); }
        .saved .dot { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,.16); }
        .count { white-space: nowrap; border: 1px solid rgba(148,163,184,.24); border-radius: 7px; padding: 4px 7px; background: rgba(255,255,255,.05); color: #e2e8f0; font: 700 10px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; }
        .actions { justify-content: flex-start; }
        .saved-message { color: #cbd5e1; font-size: 12px; font-weight: 600; }
        button { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 9px; border: 1px solid rgba(148,163,184,.22); border-radius: 8px; background: rgba(255,255,255,.07); color: #f8fafc; font: 650 11px/1 "Plus Jakarta Sans", Inter, "Segoe UI", sans-serif; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease; }
        button:hover { background: rgba(255,255,255,.13); border-color: rgba(148,163,184,.42); }
        button:active { transform: translateY(1px); }
        button:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
        .save { margin-left: auto; border-color: #4f46e5; background: #4f46e5; }
        .save:hover { border-color: #4338ca; background: #4338ca; }
        button:disabled { opacity: .6; cursor: wait; }
        svg { width: 14px; height: 14px; flex: none; }
        .mascot { width: 48px; height: 48px; position: relative; display: grid; place-items: center; padding: 4px; border: 1px solid rgba(199,210,254,.85); border-radius: 15px; background: linear-gradient(145deg,#fff,#dbeafe); box-shadow: 0 8px 24px rgba(15,23,42,.28), 0 0 0 4px rgba(99,102,241,.12); cursor: pointer; }
        .is-paused .mascot { border-color: #fbbf24; box-shadow: 0 8px 24px rgba(15,23,42,.28), 0 0 0 4px rgba(245,158,11,.16); }
        .mascot:hover { transform: translateY(-1px); border-color: #818cf8; }
        .mascot svg { width: 38px; height: 38px; }
        .mini-count { position: absolute; top: -7px; right: -8px; min-width: 20px; height: 20px; display: grid; place-items: center; padding: 0 5px; border: 2px solid #111827; border-radius: 10px; background: #4f46e5; color: #fff; font: 700 9px/1 ui-monospace, monospace; }
        .close { width: 23px; min-height: 23px; padding: 0; border: 0; background: transparent; color: #94a3b8; font-size: 15px; }
        .close:hover { background: rgba(255,255,255,.1); color: #fff; }
        @media (prefers-reduced-motion: reduce) { .panel, button { animation: none; transition: none; } }
      </style>
      <div class="root">
        <section class="panel" aria-label="Workflow recorder controls">
          <div class="topline">
            <div class="status"><span class="dot"></span><span id="statusText" role="status" aria-live="polite">CAPTURING</span></div>
            <span class="count" id="stepCount" aria-live="polite">0 steps</span>
            <button class="close" id="closeButton" type="button" aria-label="Collapse recorder controls" title="Minimize">−</button>
          </div>
          <div class="actions">
            <button id="pauseButton" type="button" aria-label="Pause workflow capture">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 3h3v10H4zm5 0h3v10H9z"/></svg><span>Pause</span>
            </button>
            <button id="resumeButton" type="button" aria-label="Resume workflow capture" hidden>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2.8v10.4c0 .5.5.8.9.5l8-5.2a.6.6 0 0 0 0-1l-8-5.2a.6.6 0 0 0-.9.5Z"/></svg><span>Resume</span>
            </button>
            <button class="save" id="saveButton" type="button" aria-label="Stop recording and save workflow">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 2h8l2 2v10H3V2Zm2 1v4h6V3H5Zm0 7v3h6v-3H5Z"/></svg><span>Save</span>
            </button>
          </div>
        </section>
        <button class="mascot" id="mascotButton" type="button" aria-label="Collapse recorder controls" title="Workflow recorder">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect x="7" y="18" width="50" height="34" rx="16" fill="#f8fafc" stroke="#a5b4fc" stroke-width="2"/>
            <rect x="14" y="23" width="36" height="19" rx="9" fill="#172033"/>
            <circle cx="24" cy="32" r="3" fill="#38bdf8"/><circle cx="40" cy="32" r="3" fill="#38bdf8"/>
            <path d="M20 47h24l-3 9H23z" fill="#e0e7ff" stroke="#a5b4fc" stroke-width="1.5"/>
            <circle cx="32" cy="51" r="2.5" fill="#6366f1"/>
            <path d="M5 30h4M55 30h4M32 11v6" stroke="#818cf8" stroke-width="2" stroke-linecap="round"/>
            <circle cx="32" cy="9" r="2.5" fill="#38bdf8"/>
          </svg>
          <span class="mini-count" id="miniCount" aria-hidden="true">0</span>
        </button>
      </div>`;
    const pauseButton = shadow.getElementById('pauseButton');
    const resumeButton = shadow.getElementById('resumeButton');
    const saveButton = shadow.getElementById('saveButton');
    const closeButton = shadow.getElementById('closeButton');
    const mascotButton = shadow.getElementById('mascotButton');
    const root = shadow.querySelector('.root');
    const toggleControls = () => {
      const isCollapsed = root.classList.toggle('is-collapsed');
      mascotButton.setAttribute('aria-label', isCollapsed ? 'Open recorder controls' : 'Collapse recorder controls');
      if (isCollapsed) mascotButton.focus();
    };
    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleControls();
    });
    mascotButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleControls();
    });
    const ignoreControlEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    pauseButton.addEventListener('click', async (event) => {
      ignoreControlEvent(event);
      pauseButton.disabled = true;
      try {
        await window.__workflowCapturePause?.();
      } catch (error) {
        pauseButton.disabled = false;
        console.error('[Workflow Capture] Could not pause recording:', error);
      }
    });
    resumeButton.addEventListener('click', async (event) => {
      ignoreControlEvent(event);
      resumeButton.disabled = true;
      try {
        await window.__workflowCaptureResume?.();
      } catch (error) {
        resumeButton.disabled = false;
        console.error('[Workflow Capture] Could not resume recording:', error);
      }
    });
    saveButton.addEventListener('click', async (event) => {
      ignoreControlEvent(event);
      saveButton.disabled = true;
      saveButton.querySelector('span').textContent = 'Saving…';
      try {
        await window.__workflowCaptureSave?.();
      } catch (error) {
        saveButton.disabled = false;
        saveButton.querySelector('span').textContent = 'Save';
        console.error('[Workflow Capture] Could not save recording:', error);
      }
    });
    Object.assign(badge.style, {
      position: 'fixed',
      top: '14px',
      right: '14px',
      zIndex: '2147483647',
      pointerEvents: 'auto'
    });
    badge.style.setProperty('position', 'fixed', 'important');
    badge.style.setProperty('top', '14px', 'important');
    badge.style.setProperty('right', '14px', 'important');
    badge.style.setProperty('z-index', '2147483647', 'important');
    badge.style.setProperty('pointer-events', 'auto', 'important');
    container.appendChild(badge);
  }

  function setPaused(paused) {
    isPaused = Boolean(paused);
    window.__workflowCapturePaused = isPaused;
    if (isPaused) {
      activeInputBuffer = null;
      if (pendingClickTimer) clearTimeout(pendingClickTimer);
      pendingClickTimer = null;
      pendingClickTarget = null;
      pendingClickExtra = null;
    }
    const badge = document.getElementById('__workflow_capture_badge__');
    const shadow = badge?.shadowRoot;
    if (!shadow) return;
    const panel = shadow.querySelector('.panel');
    const root = shadow.querySelector('.root');
    const status = shadow.getElementById('statusText');
    const pauseButton = shadow.getElementById('pauseButton');
    const resumeButton = shadow.getElementById('resumeButton');
    if (panel) panel.classList.toggle('paused', isPaused);
    if (root) root.classList.toggle('is-paused', isPaused);
    if (status) status.textContent = isPaused ? 'PAUSED' : 'CAPTURING';
    if (pauseButton) {
      pauseButton.hidden = isPaused;
      pauseButton.disabled = false;
    }
    if (resumeButton) {
      resumeButton.hidden = !isPaused;
      resumeButton.disabled = false;
    }
  }

  function updateBadgeCount(count) {
    const countElement = document.getElementById('__workflow_capture_badge__')?.shadowRoot?.getElementById('stepCount');
    if (countElement) countElement.textContent = `${count} ${count === 1 ? 'step' : 'steps'}`;
    const miniCount = document.getElementById('__workflow_capture_badge__')?.shadowRoot?.getElementById('miniCount');
    if (miniCount) miniCount.textContent = count > 99 ? '99+' : String(count);
  }

  window.__workflowCaptureSetPaused = setPaused;
  window.__workflowCaptureFlushBuffer = flushInputBuffer;
  window.__workflowCaptureUpdateUI = (state = {}) => {
    if (state.count !== undefined) updateBadgeCount(Number(state.count) || 0);
    if (state.isPaused !== undefined) setPaused(state.isPaused);
  };
  window.__workflowCaptureStopUI = () => {
    const hud = document.getElementById('__reflow_recorder_hud__');
    if (hud) hud.remove();
    const hoverEl = document.getElementById('__reflow_hover_overlay__');
    if (hoverEl) hoverEl.remove();
    if (document.documentElement) document.documentElement.style.cursor = '';
    const badge = document.getElementById('__workflow_capture_badge__');
    if (badge?.shadowRoot) {
      const shadow = badge.shadowRoot;
      shadow.querySelector('.panel')?.classList.add('saved');
      const status = shadow.getElementById('statusText');
      if (status) status.textContent = 'SAVED';
      const actions = shadow.querySelector('.actions');
      if (actions) actions.innerHTML = '<span class="saved-message">Workflow saved successfully</span>';
      setTimeout(() => badge.remove(), 1400);
    }
    if (typeof window.__workflowCaptureCleanup === 'function') window.__workflowCaptureCleanup();
  };

  // Register capture-phase event listeners on window and document
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('input', handleInput, true);
  window.addEventListener('change', handleChange, true);
  window.addEventListener('blur', handleBlur, true);
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
  const onGlobalMouseOver = (e) => {
    if (window.__reflowRecorderMode === 'CAPTURE_FIELD') {
      updateHoverOverlay(e.target);
    }
  };
  window.addEventListener('mouseover', onGlobalMouseOver, true);

  // Guarantee interception on document for frameworks that bind to document or stop bubbling
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('blur', handleBlur, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
  }

  // Direct element listener binding for DevExpress / dynamic ERP toolbars
  let lastToolbarScan = 0;
  function attachToolbarListeners() {
    if (typeof document === 'undefined') return;
    const now = Date.now();
    if (now - lastToolbarScan < 400) return;
    lastToolbarScan = now;
    try {
      const selector = 'img[title*="Export"], img[title*="save" i], img[title*="export" i], .dxm-item, .dxm-content, .dxm-image, [id*="Toolbar_Menu"], canvas, button, [role="button"], [role="menuitem"]';
      const elements = document.querySelectorAll(selector);
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.__wfAttached) continue;
        el.__wfAttached = true;
        el.addEventListener('pointerdown', onPointerDown, true);
        el.addEventListener('mousedown', onMouseDown, true);
        el.addEventListener('click', onClick, true);
        el.addEventListener('mouseup', onMouseUp, true);
        el.addEventListener('pointerup', onPointerUp, true);
      }
    } catch { }
  }

  attachToolbarListeners();

  // MutationObserver to immediately bind newly rendered DevExpress toolbar items
  if (typeof MutationObserver !== 'undefined') {
    const targetNode = document.body || document.documentElement;
    if (targetNode) {
      try {
        const observer = new MutationObserver(() => attachToolbarListeners());
        observer.observe(targetNode, { childList: true, subtree: true });
        window.__workflowCaptureObserver = observer;
      } catch { }
    }
  }

  // Periodic fallback to guarantee toolbar elements receive listeners even if MutationObserver missed them
  const toolbarPoll = setInterval(attachToolbarListeners, 250);
  window.__workflowCapturePoll = toolbarPoll;

  // Relay actions from child iframes via postMessage
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === '__WORKFLOW_CAPTURE_EMIT_ACTION__' && event.data.payload) {
      if (!isPaused && typeof window.__workflowCaptureEmitAction === 'function') {
        window.__workflowCaptureEmitAction(event.data.payload);
      } else if (window.top && window.top !== window && typeof window.top.__workflowCaptureEmitAction === 'function') {
        window.top.__workflowCaptureEmitAction(event.data.payload);
      }
    }
  });

  const renderAllRecorderUi = () => {
    try { renderRecordingBadge(); } catch (err) { console.warn('[Workflow Capture] renderRecordingBadge error:', err); }
    try { renderReflowRecorderHud(); } catch (err) { console.warn('[Workflow Capture] renderReflowRecorderHud error:', err); }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAllRecorderUi);
  } else {
    renderAllRecorderUi();
  }

  // Expose cleanup function to cleanly unbind on script upgrade
  window.__workflowCaptureCleanup = () => {
    if (window.__workflowCaptureObserver) {
      try { window.__workflowCaptureObserver.disconnect(); } catch { }
      window.__workflowCaptureObserver = null;
    }
    if (window.__workflowCapturePoll) {
      clearInterval(window.__workflowCapturePoll);
      window.__workflowCapturePoll = null;
    }
    if (scrollDebounceTimer) {
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = null;
    }
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('input', handleInput, true);
    window.removeEventListener('change', handleChange, true);
    window.removeEventListener('blur', handleBlur, true);
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('scroll', handleScroll, true);
    try { window.removeEventListener('mouseover', onGlobalMouseOver, true); } catch { }
    const remHud = document.getElementById('__reflow_recorder_hud__');
    if (remHud) remHud.remove();
    const remHover = document.getElementById('__reflow_hover_overlay__');
    if (remHover) remHover.remove();
    if (document.documentElement) document.documentElement.style.cursor = '';
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('blur', handleBlur, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('scroll', handleScroll, true);
    }
  };

  window.__workflowCaptureDocRef = typeof document !== 'undefined' ? document : null;
  if (typeof document !== 'undefined') {
    document.__workflowCaptureDocReady = true;
  }
  window.__workflowCaptureReady = true;
  console.log('[Workflow Capture] In-page recorder listeners attached successfully (v6).');
})();
