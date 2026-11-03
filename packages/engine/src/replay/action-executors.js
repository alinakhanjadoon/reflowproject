/**
 * Replay Action Executors
 * 
 * Performs simulated user interactions on validated Puppeteer ElementHandles
 * with humanized Bezier mouse curves, randomized typing cadence, and stealth timing.
 */

const { DEFAULT_TIMEOUTS } = require('../shared/constants');
const { ActionExecutionError, ElementNotInteractableError } = require('../utils/errors');
const { moveMouseHumanlike, calculateDelay, calculateTypingDelay } = require('./human-mouse');
const logger = require('../utils/logger');

/**
 * Ensure element is scrolled into view and interactable
 */
async function ensureInteractable(elementHandle, action) {
  // Check visibility, enabled status, and scroll into view natively
  const status = await elementHandle.evaluate((el) => {
    const isBackdrop = Boolean(
      (el.classList && (el.classList.contains('cdk-overlay-backdrop') || el.classList.contains('modal-backdrop'))) ||
      (el.className && typeof el.className === 'string' && el.className.includes('backdrop'))
    );

    let wasInViewport = true;
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        const rectBefore = el.getBoundingClientRect();
        const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
        const winW = typeof window !== 'undefined' ? window.innerWidth : 1280;
        wasInViewport = rectBefore.top >= 0 && rectBefore.bottom <= winH && rectBefore.left >= 0 && rectBefore.right <= winW;
      }
    } catch {}

    if (el.scrollIntoView && !isBackdrop) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
          el.scrollIntoView(true);
        }
      }

      // Sticky header & fixed overlay occlusion detection & auto-offset
      try {
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const midY = rect.top + rect.height / 2;
        if (midX >= 0 && midY >= 0 && midX <= window.innerWidth && midY <= window.innerHeight) {
          const topEl = document.elementFromPoint(midX, midY);
          if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
            const style = window.getComputedStyle(topEl);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const headerOffset = Math.max(80, topEl.getBoundingClientRect().height || 0);
              window.scrollBy(0, -headerOffset);
            }
          }
        }
      } catch {}
    }
    const hasDimensions = (typeof el.offsetWidth === 'number' || typeof el.offsetHeight === 'number' || el.getClientRects)
      ? !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length))
      : true;
    const isVisible = hasDimensions || isBackdrop;
    const isDisabled = el.disabled === true;
    return { isVisible, isDisabled, didScroll: !wasInViewport && !isBackdrop };
  });

  if (!status.isVisible) {
    throw new ElementNotInteractableError('Target element is not visible in DOM', {
      actionIndex: action.index,
      actionType: action.type,
      target: action.target,
      reason: 'Element has 0 dimensions or display:none'
    });
  }

  // Pre-action stabilization settle delay:
  // Allow browser layout shifts, smooth scrolling, and framework hydration to settle
  await new Promise(r => setTimeout(r, status.didScroll ? 250 : 30));

  if (status.isDisabled) {
    logger.warn(`Element for Action #${action.index + 1} has disabled attribute; attempting synthetic click dispatch.`);
  }
}

/**
 * Perform human mouse movement to element if enabled
 */
async function simulateHumanMouseToElement(elementHandle, page, botConfig = {}) {
  if (!page || !botConfig.mouse?.enabled) return;

  try {
    const box = await elementHandle.boundingBox();
    if (!box) return;

    // Target center with natural human jitter offset within element boundaries
    const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
    const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);

    // Get current cursor location or pick plausible starting point
    const fromPoint = {
      x: (page._lastMouseX ?? 100) + (Math.random() * 50 - 25),
      y: (page._lastMouseY ?? 100) + (Math.random() * 50 - 25)
    };

    await moveMouseHumanlike(page, fromPoint, { x: targetX, y: targetY }, botConfig.mouse);
    page._lastMouseX = targetX;
    page._lastMouseY = targetY;

    // Dwell / hover hesitation before click
    if (botConfig.mouse.hoverBeforeClickMs > 0) {
      const hoverDelay = calculateDelay(
        Math.round(botConfig.mouse.hoverBeforeClickMs * 0.7),
        Math.round(botConfig.mouse.hoverBeforeClickMs * 1.3),
        'gaussian'
      );
      await new Promise(r => setTimeout(r, hoverDelay));
    }
  } catch {}
}

/**
 * Execute CLICK action
 */
async function executeClick(elementHandle, action, options = {}) {
  await ensureInteractable(elementHandle, action);
  const { page, botConfig } = options;

  let clickTarget = elementHandle;

  // 1. Dropdown Trigger Normalization & Idempotency Check:
  // If target element is an inner arrow, path, svg, or icon inside a combobox/select trigger,
  // resolve the interactive trigger or combobox element so framework event listeners receive the click
  try {
    const triggerHandle = await clickTarget.evaluateHandle((el) => {
      const isInsideOpt = Boolean(el.closest('mat-option, [role="option"], .mat-mdc-option'));
      if (isInsideOpt) return el;
      const trigger = el.closest('.mat-mdc-select-trigger, .mat-select-trigger, mat-select, [role="combobox"], [aria-haspopup="listbox"]');
      return trigger || el;
    });
    if (triggerHandle) {
      const asElem = triggerHandle.asElement();
      if (asElem) clickTarget = asElem;
    }
  } catch {}

  // 1b. Button & Interactive Element Normalization:
  // If target element is an inner icon, path, svg, or text span inside a button, link, or role="button",
  // resolve to the interactive host element so click event listeners receive the click
  try {
    const btnHandle = await clickTarget.evaluateHandle((el) => {
      const isInsideOpt = Boolean(el.closest('mat-option, [role="option"], .mat-mdc-option, .mat-option'));
      if (isInsideOpt) return el;
      const isInsideTrigger = Boolean(el.closest('.mat-mdc-select-trigger, .mat-select-trigger, mat-select, [role="combobox"]'));
      if (isInsideTrigger) return el;
      const btn = el.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], input[type="button"], input[type="submit"]');
      return btn || el;
    });
    if (btnHandle) {
      const asElem = btnHandle.asElement();
      if (asElem) clickTarget = asElem;
    }
  } catch {}

  const isAlreadyOpenTrigger = await clickTarget.evaluate((el) => {
    const combobox = el.closest('mat-select, [role="combobox"], [aria-haspopup="listbox"]') || el;
    if (!combobox) return false;
    return combobox.getAttribute('aria-expanded') === 'true';
  }).catch(() => false);

  if (isAlreadyOpenTrigger && options.isNextActionOption) {
    logger.info(`[Replay] Combobox is already open (aria-expanded="true"); skipping redundant trigger click to keep options visible.`);
    return;
  }

  // 2. Checkbox Idempotency & State-Aware Check:
  // If target element is a checkbox (native input, ARIA role="checkbox", or Material/DevExpress checkbox),
  // inspect its current state. If it already matches the desired state, SKIP the click to avoid
  // accidental toggling/inverting on repeat!
  const isTargetCheckbox = Boolean(
    action.isCheckbox === true ||
    action.desiredState !== undefined ||
    action.checked !== undefined ||
    action.target?.isCheckbox === true ||
    action.target?.fingerprint?.isCheckbox === true ||
    action.target?.fingerprint?.type === 'checkbox' ||
    action.target?.fingerprint?.role === 'checkbox' ||
    action.target?.fingerprint?.tagName === 'mat-pseudo-checkbox' ||
    (action.name && action.name.toLowerCase().includes('checkbox')) ||
    (action.elementName && action.elementName.toLowerCase().includes('checkbox'))
  );

  let checkboxStatus = null;
  try {
    checkboxStatus = await elementHandle.evaluate((el) => {
      const hasAttr = (node, name) => Boolean(node && (typeof node.hasAttribute === 'function' ? node.hasAttribute(name) : (typeof node.getAttribute === 'function' && node.getAttribute(name) !== null)));
      const getAttr = (node, name) => (node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null);
      const query = (node, sel) => (node && typeof node.querySelector === 'function' ? node.querySelector(sel) : null);
      const closest = (node, sel) => (node && typeof node.closest === 'function' ? node.closest(sel) : null);
      const hasClass = (node, cls) => Boolean(node && node.classList && typeof node.classList.contains === 'function' && node.classList.contains(cls));

      const isInputCb = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase());
      const role = (getAttr(el, 'role') || '').toLowerCase();
      const isRoleCb = role === 'checkbox' || role === 'switch' || hasAttr(el, 'aria-checked') || hasAttr(el, 'aria-pressed');
      const isMatCb = el.tagName === 'MAT-CHECKBOX' || hasClass(el, 'mat-checkbox') || hasClass(el, 'mat-mdc-checkbox') || hasClass(el, 'dx-checkbox');
      const hasInnerCb = Boolean(query(el, 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"]'));
      const isPseudoCb = hasClass(el, 'mat-pseudo-checkbox') || Boolean(query(el, '.mat-pseudo-checkbox'));
      const isInsideOption = Boolean(closest(el, 'mat-option, [role="option"], .mat-mdc-option'));
      const hasDataCheck = hasAttr(el, 'data-state') || hasAttr(el, 'data-checked');

      if (!isInputCb && !isRoleCb && !isMatCb && !hasInnerCb && !isPseudoCb && !isInsideOption && !hasDataCheck && !isTargetCheckbox) {
        return null;
      }

      const getChecked = () => {
        if (isInsideOption) {
          const opt = closest(el, 'mat-option, [role="option"], .mat-mdc-option');
          if (opt) {
            const ariaSel = getAttr(opt, 'aria-selected');
            if (ariaSel !== null && ariaSel !== undefined) return ariaSel === 'true';
            if (hasClass(opt, 'mat-mdc-option-selected') || hasClass(opt, 'mat-option-selected')) return true;
            if (query(opt, '.mat-pseudo-checkbox-checked')) return true;
          }
        }
        if (isInputCb) return Boolean(el.checked);
        const input = query(el, 'input[type="checkbox"], input[type="radio"]') ||
                      query(closest(el, 'label'), 'input[type="checkbox"], input[type="radio"]') ||
                      query(closest(el, 'mat-checkbox'), 'input[type="checkbox"], input[type="radio"]');
        if (input) return Boolean(input.checked);

        const aria = getAttr(el, 'aria-checked') ??
                     getAttr(query(el, '[aria-checked]'), 'aria-checked') ??
                     getAttr(closest(el, '[aria-checked]'), 'aria-checked');
        if (aria !== null && aria !== undefined) return aria === 'true';

        const pressed = getAttr(el, 'aria-pressed') ??
                        getAttr(query(el, '[aria-pressed]'), 'aria-pressed');
        if (pressed !== null && pressed !== undefined) return pressed === 'true';

        const dataState = getAttr(el, 'data-state') ??
                          getAttr(query(el, '[data-state]'), 'data-state') ??
                          getAttr(closest(el, '[data-state]'), 'data-state');
        if (dataState === 'checked' || dataState === 'on') return true;
        if (dataState === 'unchecked' || dataState === 'off') return false;

        const dataChecked = getAttr(el, 'data-checked') ??
                            getAttr(query(el, '[data-checked]'), 'data-checked') ??
                            getAttr(closest(el, '[data-checked]'), 'data-checked');
        if (dataChecked === 'true' || dataChecked === '') return true;
        if (dataChecked === 'false') return false;

        if (hasClass(el, 'mat-mdc-checkbox-checked') ||
            hasClass(el, 'mat-checkbox-checked') ||
            hasClass(el, 'dx-checkbox-checked') ||
            hasClass(el, 'ant-checkbox-checked') ||
            hasClass(el, 'checked') ||
            hasClass(el, 'is-checked')) return true;

        if (query(el, '.mat-pseudo-checkbox-checked') || hasClass(el, 'mat-pseudo-checkbox-checked')) return true;

        const matParent = closest(el, 'mat-checkbox');
        if (matParent && (hasClass(matParent, 'mat-mdc-checkbox-checked') || hasClass(matParent, 'mat-checkbox-checked'))) return true;

        return false;
      };

      return {
        isCheckbox: true,
        isInsideOption,
        currentChecked: getChecked()
      };
    });
  } catch {}

  let desiredState = undefined;
  if (action.isUncheck === true || action.action === 'UNCHECK') {
    desiredState = false;
  } else if (action.desiredState !== undefined) {
    desiredState = Boolean(action.desiredState);
  } else if (action.checked !== undefined) {
    desiredState = Boolean(action.checked);
  } else if (action.meta?.checked !== undefined) {
    desiredState = Boolean(action.meta.checked);
  } else if (action.target?.fingerprint?.checked === true || action.target?.checked === true) {
    desiredState = false;
  } else if (isTargetCheckbox) {
    // Checkbox click default target state is ON (checked)
    desiredState = true;
  }

  // If this is a standalone checkbox and desiredState is known:
  if (checkboxStatus && checkboxStatus.isCheckbox && !checkboxStatus.isInsideOption && desiredState !== undefined) {
    if (checkboxStatus.currentChecked === desiredState) {
      logger.info(`[Replay] Checkbox "${action.elementName || action.name || 'Checkbox'}" is ALREADY ${desiredState ? 'CHECKED' : 'UNCHECKED'}; skipping click to preserve state on repeat.`);
      return;
    }
    logger.info(`[Replay] Checkbox "${action.elementName || action.name || 'Checkbox'}" current=${checkboxStatus.currentChecked}, desired=${desiredState}; executing click to set state.`);
  }

  // If target is inside a multi-select option (e.g. mat-option, [role="option"]) and desiredState is known:
  if (checkboxStatus && checkboxStatus.isInsideOption && desiredState !== undefined) {
    try {
      const optionAlreadyInDesiredState = await elementHandle.evaluate((el, desired) => {
        const opt = el.closest('mat-option, [role="option"], .mat-mdc-option, .mat-option');
        if (!opt) return false;
        const isSelected = opt.getAttribute('aria-selected') === 'true' ||
                           opt.classList.contains('mat-mdc-option-selected') ||
                           opt.classList.contains('mat-option-selected') ||
                           Boolean(opt.querySelector('.mat-pseudo-checkbox-checked'));
        return isSelected === desired;
      }, desiredState);

      if (optionAlreadyInDesiredState) {
        logger.info(`[Replay] Multi-select option "${action.elementName || action.name || 'Option'}" is ALREADY ${desiredState ? 'SELECTED' : 'DESELECTED'}; skipping click to preserve state.`);
        return;
      }
    } catch {}
  }

  // 3. If target is inside an option (e.g. mat-pseudo-checkbox, span label, or ripple),
  // resolve the parent mat-option / [role="option"] host element for reliable framework event dispatching
  try {
    const optionHandle = await clickTarget.evaluateHandle((el) => {
      const opt = el.closest('mat-option, [role="option"], .mat-mdc-option, .mat-option');
      if (opt && opt.scrollIntoView) {
        opt.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return opt || el;
    });
    if (optionHandle) {
      const asElem = optionHandle.asElement();
      if (asElem) clickTarget = asElem;
    }
  } catch {}

  // 3. If target is a backdrop (clicking outside in blank space to close a dropdown/modal)
  const isBackdropTarget = await clickTarget.evaluate(el => {
    return Boolean(
      (el.classList && (el.classList.contains('cdk-overlay-backdrop') || el.classList.contains('modal-backdrop'))) ||
      (el.className && typeof el.className === 'string' && el.className.includes('backdrop'))
    );
  }).catch(() => false);

  if (isBackdropTarget) {
    try {
      await clickTarget.evaluate(el => {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      logger.info(`[Replay] Dispatched full click sequence on backdrop to dismiss open overlay.`);
      return;
    } catch {}
  }

  // 4. Canvas Target Support:
  // If target is a canvas with recorded normalized relative coordinates (0-1),
  // click at the exact offset within the canvas bounding box
  if (action.target?.canvasCoords && page) {
    const { relX, relY } = action.target.canvasCoords;
    const box = await clickTarget.boundingBox();
    if (box) {
      const clickX = box.x + box.width * relX;
      const clickY = box.y + box.height * relY;
      logger.info(`[Replay] Clicking canvas at normalized (${relX}, ${relY}) -> viewport (${Math.round(clickX)}, ${Math.round(clickY)})`);
      if (botConfig?.mouse?.enabled) {
        try {
          await moveMouseHumanlike(page, { x: page._lastMouseX ?? 100, y: page._lastMouseY ?? 100 }, { x: clickX, y: clickY }, botConfig.mouse);
          page._lastMouseX = clickX;
          page._lastMouseY = clickY;
        } catch {}
      }
      await page.mouse.click(clickX, clickY, { delay: 35 });
      return;
    }
  }

  if (botConfig) {
    await simulateHumanMouseToElement(clickTarget, page, botConfig);
  }

  // 5. Date & Calendar Input Click Handling:
  // - Native HTML5 date/time inputs (type="date", "datetime-local", "month", etc.):
  //   Focus cleanly and dispatch synthetic events. Avoid raw CDP OS-level center mouse clicks
  //   that hit the internal spinbox compartment or the native popup button (::-webkit-calendar-picker-indicator),
  //   which would open an unscriptable OS-level popup or scramble segment cursor position.
  // - Calendar day cells in datepicker popups (td.day, .mat-calendar-body-cell, .flatpickr-day, .dx-calendar-cell, etc.):
  //   Scroll into view and dispatch complete pointer & mouse sequence so the datepicker registers the day selection.
  const dateClickMeta = await clickTarget.evaluate((el) => {
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.type || '').toLowerCase();
    const isNativeDate = tag === 'INPUT' && ['date', 'datetime-local', 'month', 'time', 'week'].includes(type);

    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const isCalendarCell = Boolean(
      (tag === 'TD' && (cls.includes('day') || cls.includes('date') || el.hasAttribute('data-date'))) ||
      cls.includes('mat-calendar-body-cell') ||
      cls.includes('flatpickr-day') ||
      cls.includes('dx-calendar-cell') ||
      cls.includes('ant-picker-cell') ||
      el.closest?.('.flatpickr-calendar, .mat-calendar, .dx-calendar, .ant-picker-dropdown, .datepicker')
    );

    return { isNativeDate, isCalendarCell };
  }).catch(() => null);

  if (dateClickMeta?.isCalendarCell) {
    try {
      await clickTarget.evaluate((el) => {
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const PtrEvt = typeof PointerEvent !== 'undefined' ? PointerEvent : null;
        const MouseEvt = typeof MouseEvent !== 'undefined' ? MouseEvent : null;
        const win = typeof window !== 'undefined' ? window : null;
        if (PtrEvt) el.dispatchEvent(new PtrEvt('pointerdown', { bubbles: true, cancelable: true }));
        if (MouseEvt) el.dispatchEvent(new MouseEvt('mousedown', { bubbles: true, cancelable: true, view: win }));
        if (PtrEvt) el.dispatchEvent(new PtrEvt('pointerup', { bubbles: true, cancelable: true }));
        if (MouseEvt) el.dispatchEvent(new MouseEvt('mouseup', { bubbles: true, cancelable: true, view: win }));
        el.click?.();
      });
      logger.info(`[Replay] Calendar day cell clicked successfully with complete pointer/mouse sequence.`);
      return;
    } catch {}
  }

  if (dateClickMeta?.isNativeDate) {
    try {
      await clickTarget.evaluate((el) => {
        el.focus?.();
        const MouseEvt = typeof MouseEvent !== 'undefined' ? MouseEvent : null;
        const win = typeof window !== 'undefined' ? window : null;
        if (MouseEvt) {
          el.dispatchEvent(new MouseEvt('mousedown', { bubbles: true, cancelable: true, view: win }));
          el.dispatchEvent(new MouseEvt('mouseup', { bubbles: true, cancelable: true, view: win }));
          el.dispatchEvent(new MouseEvt('click', { bubbles: true, cancelable: true, view: win }));
        }
      });
      logger.info(`[Replay] Native date input "${action.name || action.elementName || 'Date Input'}" focused safely without triggering intrusive OS picker popup.`);
      return;
    } catch {}
  }

  const isLikelyDownloadOrExport = Boolean(
    action.isDownload === true ||
    (action.target?.candidates?.some(c => c.value && /save|export|download|print|pdf|file/i.test(c.value))) ||
    (action.target?.fingerprint?.attributes?.title && /save|export|download|print|pdf/i.test(action.target.fingerprint.attributes.title)) ||
    (action.target?.fingerprint?.attributes?.href && /download|export|save|file/i.test(action.target.fingerprint.attributes.href)) ||
    (action.target?.fingerprint?.text && /download|export|save|print|pdf/i.test(action.target.fingerprint.text)) ||
    (action.name && /download|export|save/i.test(action.name)) ||
    (action.elementName && /download|export|save/i.test(action.elementName))
  );

  // Pre-click backdrop stabilization check:
  // If a modal or dropdown backdrop is fading out in the DOM, wait up to 350ms
  // for it to clear so it does not intercept our click coordinates
  if (page && !isBackdropTarget) {
    try {
      await page.waitForFunction(() => {
        const backdrops = document.querySelectorAll('.cdk-overlay-backdrop, .modal-backdrop');
        if (!backdrops || backdrops.length === 0) return true;
        for (const bd of backdrops) {
          const style = window.getComputedStyle(bd);
          if (style.pointerEvents !== 'none' && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05) {
            return false;
          }
        }
        return true;
      }, { timeout: 350 }).catch(() => {});
    } catch {}
  }

  const hitMeta = await clickTarget.evaluate((el) => {
    try {
      const rect = el.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(midX, midY);
      const isDirectHit = Boolean(topEl && (topEl === el || el.contains(topEl) || topEl.contains(el)));
      const isInteractive = Boolean(
        el.tagName === 'BUTTON' ||
        el.tagName === 'A' ||
        el.getAttribute('role') === 'button' ||
        el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'tab' ||
        (el.className && typeof el.className === 'string' && (el.className.includes('btn') || el.className.includes('button'))) ||
        el.type === 'submit' ||
        el.type === 'button'
      );
      return { isDirectHit, isInteractive, topElTag: topEl?.tagName || '' };
    } catch {
      return { isDirectHit: true, isInteractive: false, topElTag: '' };
    }
  }).catch(() => ({ isDirectHit: true, isInteractive: false, topElTag: '' }));

  let clicked = false;
  try {
    // Primary: Trusted Puppeteer CDP click with timeout guard (2500ms) against download hangs.
    // Dispatches authentic OS-level mouse events providing Chrome transient user activation.
    await Promise.race([
      clickTarget.click({ delay: 35 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout (likely download trigger)')), 2500))
    ]);
    clicked = true;
  } catch (err) {
    if (err.message && err.message.includes('Click timeout')) {
      logger.info(`[Replay] Native CDP click initiated download stream on ${action.name || 'element'}.`);
      clicked = true;
    }
  }

  // Supplementary / Hybrid DOM Event Dispatch:
  // If coordinate click was obscured (e.g. by transparent ripple or container),
  // OR if targeting an interactive button/link/export control, dispatch full synthetic DOM sequence
  // directly on the element so framework event listeners (Angular, React, Vue) receive the event reliably.
  // CRITICAL: Do NOT execute secondary clicks if element is a checkbox or a download action and was already clicked!
  const isCheckboxControl = Boolean(checkboxStatus && checkboxStatus.isCheckbox);
  if (!clicked || (!isCheckboxControl && !isLikelyDownloadOrExport && (!hitMeta.isDirectHit || hitMeta.isInteractive))) {
    try {
      await clickTarget.evaluate((el, alreadyClicked) => {
        try { el.focus?.(); } catch {}

        const PtrEvt = typeof PointerEvent !== 'undefined' ? PointerEvent : null;
        const MouseEvt = typeof MouseEvent !== 'undefined' ? MouseEvent : null;
        const win = typeof window !== 'undefined' ? window : null;

        if (PtrEvt) {
          try { el.dispatchEvent(new PtrEvt('pointerdown', { bubbles: true, cancelable: true })); } catch {}
        }
        if (MouseEvt) {
          try { el.dispatchEvent(new MouseEvt('mousedown', { bubbles: true, cancelable: true, view: win })); } catch {}
        }
        if (PtrEvt) {
          try { el.dispatchEvent(new PtrEvt('pointerup', { bubbles: true, cancelable: true })); } catch {}
        }
        if (MouseEvt) {
          try { el.dispatchEvent(new MouseEvt('mouseup', { bubbles: true, cancelable: true, view: win })); } catch {}
          try { el.dispatchEvent(new MouseEvt('click', { bubbles: true, cancelable: true, view: win })); } catch {}
        }

        if (!alreadyClicked || !el.matches?.(':active')) {
          try { el.click?.(); } catch {}
        }

        const parentBtn = el.closest && el.closest('button, a, [role="button"], .x-btn, .dxm-item');
        if (parentBtn && parentBtn !== el) {
          try { parentBtn.focus?.(); } catch {}
          try { parentBtn.click?.(); } catch {}
        }
      }, clicked && hitMeta.isDirectHit);
    } catch (fallbackErr) {
      if (!clicked) {
        throw new ActionExecutionError(`Failed to click element: ${fallbackErr.message}`, {
          actionIndex: action.index,
          actionType: action.type,
          originalError: fallbackErr
        });
      }
    }
  }

  // 3. Option Selection State Verification:
  // In Angular Material / custom multi-selects, verify that the option's selection state actually toggled.
  // Only treat as uncheck if explicitly flagged as isUncheck or if originally checked before click.
  try {
    const isUncheck = action.isUncheck === true || (desiredState === false);
    await clickTarget.evaluate((el, isUncheck) => {
      const opt = el.closest('mat-option, [role="option"], .mat-mdc-option, .mat-option');
      if (!opt) return;
      const isSelected = opt.getAttribute('aria-selected') === 'true' ||
                         opt.classList.contains('mat-mdc-option-selected') ||
                         opt.classList.contains('mat-option-selected') ||
                         !!opt.querySelector('.mat-pseudo-checkbox-checked');

      if (isUncheck && isSelected) {
        // Still selected after click, force click again to uncheck
        opt.click();
      } else if (!isUncheck && !isSelected) {
        // Expected to be selected but still false, force click to select
        opt.click();
      }
    }, isUncheck);
  } catch {}

  // 4. Standalone Checkbox State Verification & Enforcement:
  // If element is a checkbox and desiredState was specified, ensure it actually reached desiredState.
  // If the framework or custom styling prevented the toggle, attempt a direct toggle on inner input or label.
  if (isCheckboxControl && !checkboxStatus?.isInsideOption && desiredState !== undefined) {
    if (page) await new Promise(r => setTimeout(r, 60));
    try {
      const stateAchieved = await clickTarget.evaluate((el, desired) => {
        const hasAttr = (node, name) => Boolean(node && (typeof node.hasAttribute === 'function' ? node.hasAttribute(name) : (typeof node.getAttribute === 'function' && node.getAttribute(name) !== null)));
        const getAttr = (node, name) => (node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null);
        const query = (node, sel) => (node && typeof node.querySelector === 'function' ? node.querySelector(sel) : null);
        const closest = (node, sel) => (node && typeof node.closest === 'function' ? node.closest(sel) : null);
        const hasClass = (node, cls) => Boolean(node && node.classList && typeof node.classList.contains === 'function' && node.classList.contains(cls));
        const isInputCb = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase());

        const getChecked = () => {
          if (isInputCb) return Boolean(el.checked);
          const input = query(el, 'input[type="checkbox"], input[type="radio"]') ||
                        query(closest(el, 'label'), 'input[type="checkbox"], input[type="radio"]') ||
                        query(closest(el, 'mat-checkbox'), 'input[type="checkbox"], input[type="radio"]');
          if (input) return Boolean(input.checked);

          const aria = getAttr(el, 'aria-checked') ??
                       getAttr(query(el, '[aria-checked]'), 'aria-checked') ??
                       getAttr(closest(el, '[aria-checked]'), 'aria-checked');
          if (aria !== null && aria !== undefined) return aria === 'true';

          const pressed = getAttr(el, 'aria-pressed') ?? getAttr(query(el, '[aria-pressed]'), 'aria-pressed');
          if (pressed !== null && pressed !== undefined) return pressed === 'true';

          const dataState = getAttr(el, 'data-state') ?? getAttr(query(el, '[data-state]'), 'data-state') ?? getAttr(closest(el, '[data-state]'), 'data-state');
          if (dataState === 'checked' || dataState === 'on') return true;
          if (dataState === 'unchecked' || dataState === 'off') return false;

          const dataChecked = getAttr(el, 'data-checked') ?? getAttr(query(el, '[data-checked]'), 'data-checked') ?? getAttr(closest(el, '[data-checked]'), 'data-checked');
          if (dataChecked === 'true' || dataChecked === '') return true;
          if (dataChecked === 'false') return false;

          if (hasClass(el, 'mat-mdc-checkbox-checked') ||
              hasClass(el, 'mat-checkbox-checked') ||
              hasClass(el, 'dx-checkbox-checked') ||
              hasClass(el, 'ant-checkbox-checked') ||
              hasClass(el, 'checked') ||
              hasClass(el, 'is-checked')) return true;

          if (query(el, '.mat-pseudo-checkbox-checked') || hasClass(el, 'mat-pseudo-checkbox-checked')) return true;

          const matParent = closest(el, 'mat-checkbox');
          if (matParent && (hasClass(matParent, 'mat-mdc-checkbox-checked') || hasClass(matParent, 'mat-checkbox-checked'))) return true;

          return false;
        };

        let nowChecked = getChecked();
        if (nowChecked !== desired) {
          const recoveryEl = query(el, 'input[type="checkbox"], input[type="radio"]') || closest(el, 'label') || el;
          recoveryEl.click?.();
          nowChecked = getChecked();
        }
        return nowChecked === desired;
      }, desiredState);

      if (!stateAchieved) {
        logger.warn(`[Replay] Checkbox state verification failed: expected ${desiredState ? 'CHECKED' : 'UNCHECKED'}.`);
        throw new ActionExecutionError(`Checkbox state verification failed: expected ${desiredState ? 'CHECKED' : 'UNCHECKED'} but state could not be verified.`, {
          actionIndex: action.index,
          actionType: action.type,
          elementName: action.elementName || action.name
        });
      }
      logger.info(`[Replay] Checkbox "${action.elementName || action.name || 'Checkbox'}" state successfully verified: ${desiredState ? 'CHECKED' : 'UNCHECKED'}.`);
    } catch (verifyErr) {
      if (verifyErr instanceof ActionExecutionError) throw verifyErr;
      throw new ActionExecutionError(`Checkbox state verification failed: ${verifyErr.message}`, {
        actionIndex: action.index,
        actionType: action.type,
        elementName: action.elementName || action.name
      });
    }
  }
}

/**
 * Execute DOUBLE_CLICK action
 */
async function executeDoubleClick(elementHandle, action, options = {}) {
  await ensureInteractable(elementHandle, action);
  const { page, botConfig } = options;

  if (botConfig) {
    await simulateHumanMouseToElement(elementHandle, page, botConfig);
  }

  try {
    await elementHandle.click({ clickCount: 2 });
  } catch (err) {
    throw new ActionExecutionError(`Failed to double-click element: ${err.message}`, {
      actionIndex: action.index,
      actionType: action.type,
      originalError: err
    });
  }
}

/**
 * Universal Date Normalizer
 * Converts arbitrary user or recorded date strings into standard formats:
 * - HTML5 date: YYYY-MM-DD
 * - HTML5 datetime-local: YYYY-MM-DDTHH:mm
 * - HTML5 month: YYYY-MM
 * - Localized masks: MM/DD/YYYY, DD/MM/YYYY, etc.
 */
function normalizeDateValue(rawDate, targetFormat = 'YYYY-MM-DD') {
  if (!rawDate || typeof rawDate !== 'string') return rawDate;
  const trimmed = rawDate.trim();
  if (!trimmed) return trimmed;

  // 1. Standard ISO YYYY-MM-DD (e.g. 2026-01-11, 2026-12-05)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    const hh = (isoMatch[4] || '00').padStart(2, '0');
    const mm = (isoMatch[5] || '00').padStart(2, '0');

    if (targetFormat === 'YYYY-MM-DDTHH:mm') return `${y}-${m}-${d}T${hh}:${mm}`;
    if (targetFormat === 'YYYY-MM') return `${y}-${m}`;
    if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
    if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    return `${y}-${m}-${d}`;
  }

  // 2. Delimited formats with slashes (e.g. 01/11/2026, 11/01/2026, 2026/01/11)
  const slashMatch = trimmed.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})/);
  if (slashMatch) {
    let y, m, d;
    if (slashMatch[1].length === 4) {
      // YYYY/MM/DD
      y = slashMatch[1];
      m = slashMatch[2].padStart(2, '0');
      d = slashMatch[3].padStart(2, '0');
    } else if (slashMatch[3].length === 4) {
      y = slashMatch[3];
      const p1 = parseInt(slashMatch[1], 10);
      const p2 = parseInt(slashMatch[2], 10);
      if (p1 > 12) {
        // First part > 12 must be DD
        d = slashMatch[1].padStart(2, '0');
        m = slashMatch[2].padStart(2, '0');
      } else if (targetFormat === 'DD/MM/YYYY' && p2 <= 12) {
        d = slashMatch[1].padStart(2, '0');
        m = slashMatch[2].padStart(2, '0');
      } else {
        // Default MM/DD/YYYY
        m = slashMatch[1].padStart(2, '0');
        d = slashMatch[2].padStart(2, '0');
      }
    }
    if (y && m && d) {
      if (targetFormat === 'YYYY-MM-DDTHH:mm') return `${y}-${m}-${d}T00:00`;
      if (targetFormat === 'YYYY-MM') return `${y}-${m}`;
      if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
      if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
      return `${y}-${m}-${d}`;
    }
  }

  // 3. Delimited formats with dashes DD-MM-YYYY or MM-DD-YYYY
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dashMatch) {
    const y = dashMatch[3];
    let m = dashMatch[1].padStart(2, '0');
    let d = dashMatch[2].padStart(2, '0');
    if (parseInt(dashMatch[1], 10) > 12) {
      d = dashMatch[1].padStart(2, '0');
      m = dashMatch[2].padStart(2, '0');
    } else if (targetFormat === 'DD/MM/YYYY') {
      d = dashMatch[1].padStart(2, '0');
      m = dashMatch[2].padStart(2, '0');
    }
    if (targetFormat === 'YYYY-MM-DDTHH:mm') return `${y}-${m}-${d}T00:00`;
    if (targetFormat === 'YYYY-MM') return `${y}-${m}`;
    if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
    if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    return `${y}-${m}-${d}`;
  }

  // 4. Delimited formats with dots DD.MM.YYYY
  const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const y = dotMatch[3];
    let d = dotMatch[1].padStart(2, '0');
    let m = dotMatch[2].padStart(2, '0');
    if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
    if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    return `${y}-${m}-${d}`;
  }

  // 5. Fallback Date constructor
  try {
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const d = String(parsed.getDate()).padStart(2, '0');
      if (targetFormat === 'YYYY-MM-DDTHH:mm') return `${y}-${m}-${d}T00:00`;
      if (targetFormat === 'YYYY-MM') return `${y}-${m}`;
      if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
      if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
      return `${y}-${m}-${d}`;
    }
  } catch {}

  return trimmed;
}

/**
 * Execute TYPE action with humanized stochastic typing rhythm
 * and universal framework-aware date/time input support.
 */
async function executeType(elementHandle, action, options = {}) {
  await ensureInteractable(elementHandle, action);
  const { page, botConfig } = options;
  const textToType = action.value || '';

  if (botConfig) {
    await simulateHumanMouseToElement(elementHandle, page, botConfig);
  }

  try {
    const isCheckboxOrRadio = await elementHandle.evaluate(el => {
      const type = (el.type || '').toLowerCase();
      return type === 'checkbox' || type === 'radio';
    }).catch(() => false);
    if (isCheckboxOrRadio) {
      logger.info(`[Replay] Skipping executeType on checkbox/radio input.`);
      return;
    }

    await elementHandle.focus().catch(() => {});

    // Inspect if target element is a date/time field across native HTML5,
    // Angular Material, DevExpress, Flatpickr, jQuery UI, or masked inputs
    const dateMeta = await elementHandle.evaluate((el, { actionValue, actionType }) => {
      const tag = (el.tagName || '').toUpperCase();
      const type = (el.type || '').toLowerCase();
      const isNativeDate = tag === 'INPUT' && ['date', 'datetime-local', 'month', 'time', 'week'].includes(type);

      const ph = (el.placeholder || '').toLowerCase();
      const hasDatePh = /\b(yyyy|mm|dd|yy)[-/. ](mm|dd)[-/. ](yyyy|yy|dd)\b/i.test(ph) ||
                        ph.includes('date') || ph.includes('dob');

      const isFlatpickr = Boolean(el._flatpickr || el.classList?.contains('flatpickr-input'));
      const isJQueryDate = Boolean(el.classList?.contains('hasDatepicker') || el.classList?.contains('datepicker') || el.classList?.contains('date-picker'));
      const isMatDate = Boolean(el.hasAttribute?.('matdatepicker') || el.classList?.contains('mat-datepicker-input') || el.closest?.('mat-datepicker-content, mat-form-field-type-mat-date-range-input'));
      const isDxDate = Boolean(el.closest?.('.dx-datebox') || el.classList?.contains('dx-texteditor-input'));
      const isAntDate = Boolean(el.closest?.('.ant-picker') || el.classList?.contains('ant-picker-input'));

      const idOrName = `${el.id || ''} ${el.name || ''} ${el.getAttribute?.('aria-label') || ''}`.toLowerCase();
      const isNameDate = /(?:start|end|from|to|birth|expiry|due|filter|effective)?_?date/i.test(idOrName) &&
                         !/(?:candidate|update|validate)/i.test(idOrName);

      const isDateVal = Boolean(actionValue && (
        /^\d{4}-\d{2}-\d{2}/.test(actionValue) ||
        /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(actionValue)
      ));

      let expectedFormat = 'YYYY-MM-DD';
      if (isNativeDate) {
        if (type === 'datetime-local') expectedFormat = 'YYYY-MM-DDTHH:mm';
        else if (type === 'month') expectedFormat = 'YYYY-MM';
        else expectedFormat = 'YYYY-MM-DD';
      } else if (hasDatePh) {
        if (/dd[-/.]mm[-/.]yyyy/i.test(ph)) expectedFormat = 'DD/MM/YYYY';
        else if (/mm[-/.]dd[-/.]yyyy/i.test(ph)) expectedFormat = 'MM/DD/YYYY';
      }

      const isDate = Boolean(isNativeDate || isFlatpickr || isJQueryDate || isMatDate || isDxDate || isAntDate || hasDatePh || (isNameDate && isDateVal) || (actionType === 'date'));

      return {
        isDate,
        isNativeDate,
        isFlatpickr,
        isJQueryDate,
        isMatDate,
        isDxDate,
        isAntDate,
        expectedFormat,
        inputType: type
      };
    }, { actionValue: textToType, actionType: action.target?.fingerprint?.type }).catch(() => ({ isDate: false }));

    if (dateMeta.isDate && textToType !== '[REDACTED]') {
      const normalizedValue = normalizeDateValue(textToType, dateMeta.expectedFormat);
      logger.info(`[Replay] Universal Date Setter: Injecting "${normalizedValue}" (raw="${textToType}", targetFormat="${dateMeta.expectedFormat}") into date field "${action.name || action.elementName || 'Date Input'}"`);

      await elementHandle.evaluate((el, { targetVal, rawVal }) => {
        el.focus?.();
        const win = typeof window !== 'undefined' ? window : null;

        // 1. Framework API Hooks
        if (el._flatpickr && typeof el._flatpickr.setDate === 'function') {
          try { el._flatpickr.setDate(targetVal || rawVal, true); } catch {}
        }

        const dxBox = el.closest?.('.dx-datebox');
        if (dxBox && win?.DevExpress?.ui?.dxDateBox) {
          try {
            const instance = win.DevExpress.ui.dxDateBox.getInstance(dxBox);
            instance?.option?.('value', targetVal || rawVal);
          } catch {}
        }

        const $ = win ? (win.jQuery || win.$) : null;
        if ($ && typeof $(el).datepicker === 'function') {
          try {
            $(el).datepicker('setDate', targetVal || rawVal);
            $(el).trigger?.('change');
          } catch {}
        }

        // 2. Universal React 15/16/17/18/19 & Native Prototype Value Injection
        const valToSet = targetVal || rawVal;
        const inputProto = win?.HTMLInputElement?.prototype;
        const prototypeValueSetter = inputProto
          ? Object.getOwnPropertyDescriptor(inputProto, 'value')?.set
          : null;

        if (prototypeValueSetter) {
          prototypeValueSetter.call(el, valToSet);
        } else {
          el.value = valToSet;
        }

        // 3. Dispatch reactive events
        const Evt = typeof Event !== 'undefined' ? Event : null;
        if (Evt) {
          el.dispatchEvent(new Evt('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Evt('change', { bubbles: true, composed: true }));
        } else {
          el.dispatchEvent?.({ type: 'input' });
          el.dispatchEvent?.({ type: 'change' });
        }

        // 4. Fallback for masked inputs where prototype setter was blocked
        if (el.value !== valToSet && el.type === 'text') {
          try {
            el.select?.();
            const doc = typeof document !== 'undefined' ? document : null;
            doc?.execCommand?.('insertText', false, valToSet);
          } catch {}
        }

        if (Evt) {
          el.dispatchEvent(new Evt('blur', { bubbles: true, composed: true }));
        } else {
          el.dispatchEvent?.({ type: 'blur' });
        }
      }, { targetVal: normalizedValue, rawVal: textToType });

      return;
    }

    // If botConfig typing is active and page is available, type character by character
    const typingCfg = botConfig?.typing;
    if (typingCfg && textToType !== '[REDACTED]' && textToType.length > 0 && typeof elementHandle.type === 'function') {
      // Clear existing input value first
      await elementHandle.evaluate(el => { el.value = ''; });

      for (let i = 0; i < textToType.length; i++) {
        const char = textToType[i];
        const delay = calculateTypingDelay(char, typingCfg);
        
        await elementHandle.type(char, { delay: Math.min(delay, 500) });
      }

      await elementHandle.evaluate((el) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      });
    } else {
      // Fast fallback: bulk value injection
      await elementHandle.evaluate((el, text) => {
        el.focus();
        if (text !== '[REDACTED]') {
          const proto = el.tagName === 'TEXTAREA' && window.HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (prototypeValueSetter) {
            prototypeValueSetter.call(el, text);
          } else {
            el.value = text;
          }
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, textToType);
    }
  } catch (err) {
    throw new ActionExecutionError(`Failed to type into element: ${err.message}`, {
      actionIndex: action.index,
      actionType: action.type,
      originalError: err
    });
  }
}

/**
 * Execute SELECT dropdown action
 */
async function executeSelect(elementHandle, action, options = {}) {
  await ensureInteractable(elementHandle, action);
  const { page, botConfig } = options;
  const targetValue = action.value;
  const targetText = (action.meta && action.meta.text) ? action.meta.text : null;

  if (botConfig) {
    await simulateHumanMouseToElement(elementHandle, page, botConfig);
  }

  try {
    let selected = false;

    // Try Puppeteer select method first
    if (targetValue !== undefined && targetValue !== null && typeof elementHandle.select === 'function') {
      try {
        const result = await elementHandle.select(String(targetValue));
        if (result && result.length > 0) {
          selected = true;
        }
      } catch {}
    }

    // In-page fallback: match by value or visible text
    if (!selected) {
      await elementHandle.evaluate((selectEl, val, txt) => {
        let matched = false;
        for (let i = 0; i < selectEl.options.length; i++) {
          const opt = selectEl.options[i];
          if (val !== undefined && opt.value === String(val)) {
            selectEl.selectedIndex = i;
            matched = true;
            break;
          }
          if (txt && opt.textContent.trim() === String(txt).trim()) {
            selectEl.selectedIndex = i;
            matched = true;
            break;
          }
        }
        if (matched) {
          selectEl.dispatchEvent(new Event('input', { bubbles: true }));
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, targetValue, targetText);
    }
  } catch (err) {
    throw new ActionExecutionError(`Failed to select dropdown option: ${err.message}`, {
      actionIndex: action.index,
      actionType: action.type,
      originalError: err
    });
  }
}

/**
 * Execute KEY_PRESS action (e.g. Enter, Tab, Escape)
 */
async function executeKeyPress(elementHandle, action, options = {}) {
  await ensureInteractable(elementHandle, action);
  const { page, botConfig } = options;
  const keyToPress = action.key || action.value || 'Enter';

  if (botConfig) {
    await simulateHumanMouseToElement(elementHandle, page, botConfig);
  }

  try {
    // Focus the target element first
    await elementHandle.focus().catch(() => {});

    // Use Puppeteer keyboard if available on page
    if (page && page.keyboard) {
      let puppeteerKey = keyToPress;
      if (keyToPress === 'Return' || keyToPress === 'enter') puppeteerKey = 'Enter';
      await page.keyboard.press(puppeteerKey);
    } else {
      // Fallback: dispatch synthetic keyboard event inside page context
      await elementHandle.evaluate((el, key) => {
        const keyCode = key === 'Enter' ? 13 : (key === 'Tab' ? 9 : (key === 'Escape' ? 27 : 0));
        const eventOpts = {
          key: key,
          code: key,
          keyCode: keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
          view: window
        };
        el.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
        el.dispatchEvent(new KeyboardEvent('keypress', eventOpts));
        el.dispatchEvent(new KeyboardEvent('keyup', eventOpts));
      }, keyToPress);
    }
  } catch (err) {
    throw new ActionExecutionError(`Failed to press key "${keyToPress}": ${err.message}`, {
      actionIndex: action.index,
      actionType: action.type,
      originalError: err
    });
  }
}

/**
 * Execute SCROLL action
 */
async function executeScroll(elementHandle, action, options = {}) {
  const { page } = options;
  const targetX = Number(action.scrollX ?? action.x ?? 0);
  const targetY = Number(action.scrollY ?? action.y ?? action.scrollTop ?? 0);

  if (elementHandle) {
    try {
      await elementHandle.evaluate((el, x, y) => {
        if (typeof el.scrollTo === 'function') {
          try {
            el.scrollTo({ left: x, top: y, behavior: 'instant' });
          } catch {
            el.scrollTo(x, y);
          }
        } else {
          el.scrollTop = y;
          el.scrollLeft = x;
        }
      }, targetX, targetY);
      await new Promise(r => setTimeout(r, 200));
      return { success: true, type: 'SCROLL', x: targetX, y: targetY };
    } catch {}
  }

  if (page) {
    try {
      await page.evaluate((x, y) => {
        try {
          window.scrollTo({ left: x, top: y, behavior: 'instant' });
        } catch {
          window.scrollTo(x, y);
        }
      }, targetX, targetY);
      await new Promise(r => setTimeout(r, 200));
      return { success: true, type: 'SCROLL', x: targetX, y: targetY };
    } catch {}
  }

  return { success: true, type: 'SCROLL', x: targetX, y: targetY };
}

/**
 * Extracts visible text or input value from element and records into replayEngine
 */
async function executeExtractText(elementHandle, action, page, context = {}) {
  const extractedValue = await elementHandle.evaluate((el) => {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      return (el.value || '').trim();
    }
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  });
  const fieldName =
    action.fieldName ||
    action.columnName ||
    action.label ||
    action.target?.label ||
    action.target?.ariaLabel ||
    action.target?.name ||
    `Extracted_Field_${(context.actionIndex ?? 0) + 1}`;
  if (context.replayEngine) {
    if (!context.replayEngine.extractedRowFields) {
      context.replayEngine.extractedRowFields = {};
    }
    context.replayEngine.extractedRowFields[fieldName] = extractedValue;
  }
  return { fieldName, value: extractedValue };
}

/**
 * Dispatcher to map action types to executor functions
 */
async function dispatchAction(elementHandle, action, options = {}) {
  const type = String(action.type || action.action || '').toUpperCase();
  switch (type) {
    case 'CLICK':
      return executeClick(elementHandle, action, options);
    case 'DOUBLE_CLICK':
      return executeDoubleClick(elementHandle, action, options);
    case 'TYPE':
      return executeType(elementHandle, action, options);
    case 'SELECT':
      return executeSelect(elementHandle, action, options);
    case 'SCROLL':
      return executeScroll(elementHandle, action, options);
    case 'KEY_PRESS':
    case 'PRESS_KEY':
    case 'KEYDOWN':
    case 'KEY_DOWN':
    case 'ENTER':
      return executeKeyPress(elementHandle, action, options);
    case 'EXTRACT_TEXT':
    case 'CAPTURE_FIELD':
      return executeExtractText(elementHandle, action, options.page, options);
    case 'NAVIGATE':
      if (options.page && (action.url || action.targetUrl || action.value)) {
        const navUrl = action.url || action.targetUrl || action.value;
        await options.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { success: true, type: 'NAVIGATE' };
      }
      return { success: true, type: 'NAVIGATE' };
    default:
      throw new ActionExecutionError(`Unsupported action type: ${action.type || action.action}`, {
        actionIndex: action.index,
        actionType: action.type || action.action
      });
  }
}

module.exports = {
  normalizeDateValue,
  executeClick,
  executeDoubleClick,
  executeType,
  executeSelect,
  executeKeyPress,
  executeScroll,
  executeExtractText,
  dispatchAction
};
