/**
 * ReFlow — Universal Exception & Interruption Handler
 * 
 * Objectives:
 * 1. Proactively and reactively handle unexpected browser interruptions
 *    (e.g., native JavaScript alert/confirm/prompt/beforeunload dialogs,
 *    unexpected blocking DOM overlays, error modals, and popups).
 * 2. Prevent Chrome from hanging or timing out when an unhandled dialog appears
 *    (such as "customerportal.usoil.com says: You must select one or more EFT Documents...").
 * 3. Provide resilient single-retry recovery around action executions without altering
 *    existing workflow logic when no interruption occurs.
 */

'use strict';

const logger = require('../utils/logger');

class InterruptionHandler {
  constructor(options = {}) {
    this.attachedPages = new WeakSet();
    this.interruptionHistory = [];
    this.maxHistory = options.maxHistory || 50;
    this.autoAcceptDialogs = options.autoAcceptDialogs !== false;
  }

  /**
   * Attach automatic dialog interception and interruption recovery to a page.
   * Safe to call multiple times (idempotent via WeakSet).
   * 
   * @param {import('puppeteer-core').Page} page
   */
  attachToPage(page) {
    if (!page || typeof page.on !== 'function') return;
    if (this.attachedPages.has(page)) return;

    this.attachedPages.add(page);

    page.on('dialog', async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();
      let pageUrl = '';
      try {
        pageUrl = typeof page.url === 'function' ? page.url() : '';
      } catch {}

      const record = {
        type: 'native_dialog',
        dialogType: type,
        message,
        url: pageUrl,
        timestamp: Date.now()
      };

      this._recordInterruption(record);
      logger.warn(`[InterruptionHandler] Intercepted native browser dialog on "${pageUrl}": [${type}] "${message}". Auto-handling to prevent thread freeze.`);

      try {
        if (type === 'prompt') {
          await dialog.accept(dialog.defaultValue() || '').catch(() => {});
        } else if (this.autoAcceptDialogs) {
          await dialog.accept().catch(() => {});
        } else {
          await dialog.dismiss().catch(() => {});
        }
      } catch (err) {
        // If accept failed, attempt dismiss as fallback
        await dialog.dismiss().catch(() => {});
      }
    });

    // Proactively clear any dialog that may have been triggered before handler attached
    this.clearLingeringDialogs(page).catch(() => {});
  }

  /**
   * Use CDP protocol to dismiss/accept any lingering native JavaScript dialog on the page.
   * Crucial when a click or alert fired synchronously before Puppeteer event loop processed it.
   * 
   * @param {import('puppeteer-core').Page} page
   */
  async clearLingeringDialogs(page) {
    if (!page || typeof page.isClosed === 'function' && page.isClosed()) return false;
    try {
      const target = typeof page.target === 'function' ? page.target() : null;
      if (!target || typeof target.createCDPSession !== 'function') return false;

      const client = await target.createCDPSession().catch(() => null);
      if (!client) return false;

      let cleared = false;
      try {
        await client.send('Page.handleJavaScriptDialog', { accept: true }).then(() => {
          cleared = true;
          logger.info('[InterruptionHandler] Cleared lingering JavaScript dialog via CDP.');
        }).catch(() => {});
      } finally {
        await client.detach().catch(() => {});
      }
      return cleared;
    } catch {
      return false;
    }
  }

  /**
   * Determine if the action intentionally targets a dropdown option, select combobox,
   * option checkbox, or overlay backdrop.
   * 
   * @param {object} [action]
   * @returns {boolean}
   */
  isOptionOrDropdownAction(action) {
    if (!action) return false;
    const target = action.target || (action.candidates ? action : null);
    const fp = target?.fingerprint || action.fingerprint;
    const candidates = target?.candidates || action.candidates || [];

    return Boolean(
      action.isCheckbox === true ||
      action.desiredState !== undefined ||
      action.checked !== undefined ||
      target?.isCheckbox === true ||
      fp?.isCheckbox === true ||
      fp?.role === 'option' ||
      fp?.tagName === 'mat-option' ||
      fp?.tagName === 'mat-pseudo-checkbox' ||
      (action.name && /option|checkbox|backdrop/i.test(action.name)) ||
      (action.elementName && /option|checkbox|backdrop/i.test(action.elementName)) ||
      (target?.friendlyName && /option|checkbox|backdrop/i.test(target.friendlyName)) ||
      (target?.elementName && /option|checkbox|backdrop/i.test(target.elementName)) ||
      candidates.some(c => c && c.value && (
        c.value.includes('option') ||
        c.value.includes('mat-option') ||
        c.value.includes('pseudo-checkbox') ||
        c.value.includes('backdrop') ||
        c.value.includes('cdk-overlay')
      ))
    );
  }

  /**
   * Extract CSS selector candidates, XPaths, and semantic keywords from an action target
   * to protect intentional workflow modals.
   * 
   * @private
   * @param {object} [action]
   * @returns {{ selectors: string[], xpaths: string[], keywords: string[] }}
   */
  _extractActionTargetData(action) {
    if (!action) return { selectors: [], xpaths: [], keywords: [] };
    const selectors = [];
    const xpaths = [];
    const keywords = [];

    const targetObj = action.target || (action.candidates ? action : null);
    if (targetObj) {
      if (typeof targetObj === 'string') {
        if (targetObj.startsWith('//') || targetObj.startsWith('(') || targetObj.startsWith('/html')) {
          xpaths.push(targetObj);
        } else {
          selectors.push(targetObj);
        }
      } else {
        if (targetObj.candidates && Array.isArray(targetObj.candidates)) {
          for (const c of targetObj.candidates) {
            const val = typeof c === 'string' ? c : c?.value;
            if (val && typeof val === 'string') {
              if (val.startsWith('//') || val.startsWith('(') || val.startsWith('/html')) {
                xpaths.push(val);
              } else {
                selectors.push(val);
              }
            }
          }
        }
        if (targetObj.selector && typeof targetObj.selector === 'string') {
          if (targetObj.selector.startsWith('//') || targetObj.selector.startsWith('(')) {
            xpaths.push(targetObj.selector);
          } else {
            selectors.push(targetObj.selector);
          }
        }
        if (targetObj.selectors?.cssPath && typeof targetObj.selectors.cssPath === 'string') {
          selectors.push(targetObj.selectors.cssPath);
        }
        if (targetObj.id && typeof targetObj.id === 'string') {
          selectors.push(`#${targetObj.id}`);
        }
        if (targetObj.fingerprint?.id && typeof targetObj.fingerprint.id === 'string') {
          selectors.push(`#${targetObj.fingerprint.id}`);
        }
        if (targetObj.fingerprint?.placeholder && typeof targetObj.fingerprint.placeholder === 'string') {
          selectors.push(`[placeholder="${targetObj.fingerprint.placeholder.replace(/"/g, '\\"')}"]`);
          keywords.push(targetObj.fingerprint.placeholder);
        }
        if (targetObj.fingerprint?.name && typeof targetObj.fingerprint.name === 'string') {
          selectors.push(`[name="${targetObj.fingerprint.name.replace(/"/g, '\\"')}"]`);
        }
        if (targetObj.fingerprint?.attributes?.placeholder) {
          selectors.push(`[placeholder="${targetObj.fingerprint.attributes.placeholder.replace(/"/g, '\\"')}"]`);
          keywords.push(targetObj.fingerprint.attributes.placeholder);
        }
        if (targetObj.fingerprint?.attributes?.name) {
          selectors.push(`[name="${targetObj.fingerprint.attributes.name.replace(/"/g, '\\"')}"]`);
        }
        if (targetObj.fingerprint?.text) {
          keywords.push(targetObj.fingerprint.text);
        }
        if (targetObj.friendlyName) {
          const baseLabel = targetObj.friendlyName.replace(/\s+(Input|Button|Field|Link|Select|Checkbox|Radio|Dropdown)$/i, '').trim();
          if (baseLabel.length >= 2) keywords.push(baseLabel);
        }
        if (targetObj.elementName) {
          const baseLabel = targetObj.elementName.replace(/\s+(Input|Button|Field|Link|Select|Checkbox|Radio|Dropdown)$/i, '').trim();
          if (baseLabel.length >= 2) keywords.push(baseLabel);
        }
      }
    }

    if (action.selector && typeof action.selector === 'string') {
      if (action.selector.startsWith('//') || action.selector.startsWith('(')) {
        xpaths.push(action.selector);
      } else {
        selectors.push(action.selector);
      }
    }
    if (action.elementName) {
      const baseLabel = action.elementName.replace(/\s+(Input|Button|Field|Link|Select|Checkbox|Radio|Dropdown)$/i, '').trim();
      if (baseLabel.length >= 2) keywords.push(baseLabel);
    }
    if (action.name) {
      const baseLabel = action.name.replace(/\s+(Input|Button|Field|Link|Select|Checkbox|Radio|Dropdown)$/i, '').trim();
      if (baseLabel.length >= 2) keywords.push(baseLabel);
    }

    return {
      selectors: Array.from(new Set(selectors.filter(Boolean))),
      xpaths: Array.from(new Set(xpaths.filter(Boolean))),
      keywords: Array.from(new Set(keywords.filter(k => typeof k === 'string' && k.trim().length >= 2).map(k => k.trim())))
    };
  }

  /**
   * Extract CSS selector candidates from an action target to protect intentional workflow modals.
   * 
   * @private
   * @param {object} [action]
   * @returns {string[]}
   */
  _extractActionTargetSelectors(action) {
    return this._extractActionTargetData(action).selectors;
  }

  /**
   * Detect and dismiss unexpected blocking DOM modals, alert banners, popups, and overlays across any site.
   * Proactively checks for close cross buttons ('×', '✕', '✖', '.x', '[aria-label="close"]', SVG icons),
   * dismissive actions ('Skip', 'No thanks', 'Decline', 'Stay signed in', 'Dismiss', 'Close'),
   * and unexpected overlays.
   * Intended workflow modals containing the action's target are protected and never dismissed.
   * 
   * @param {import('puppeteer-core').Page} page
   * @param {object} [action] Optional current workflow action to ensure target protection
   * @returns {Promise<boolean>} True if an unexpected popup or overlay was detected and dismissed
   */
  async dismissBlockingOverlays(page, action = null) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;

    // Never dismiss or press Escape if the active action targets a dropdown option, select combobox, or backdrop
    if (this.isOptionOrDropdownAction(action)) {
      return false;
    }

    const targetData = this._extractActionTargetData(action);
    let totalDismissed = 0;

    try {
      // Loop up to 3 passes to handle cascading popups (e.g. cookie banner + survey modal + promo toast)
      for (let pass = 0; pass < 3; pass++) {
        const dismissResult = await page.evaluate((targetData) => {
          const isVisible = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const nodeContains = (parent, child) => {
            if (!parent || !child) return false;
            if (typeof parent.contains === 'function') {
              try { return parent.contains(child); } catch {}
            }
            let curr = child.parentElement || child.parent;
            while (curr) {
              if (curr === parent) return true;
              curr = curr.parentElement || curr.parent;
            }
            return false;
          };

          const queryXPath = (xpath) => {
            try {
              const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              return res.singleNodeValue;
            } catch { return null; }
          };

          // 1. Identify any elements matching the action's target on the page
          const targetElements = [];
          if (targetData && Array.isArray(targetData.selectors)) {
            for (const sel of targetData.selectors) {
              try {
                const els = document.querySelectorAll(sel);
                for (const el of els) targetElements.push(el);
              } catch {}
            }
          }
          if (targetData && Array.isArray(targetData.xpaths)) {
            for (const xp of targetData.xpaths) {
              try {
                const el = queryXPath(xp);
                if (el) targetElements.push(el);
              } catch {}
            }
          }

          // Build Set of protected ancestor elements (all containers enclosing the target)
          const protectedAncestors = new Set();
          for (const el of targetElements) {
            let curr = el;
            while (curr && curr !== document.body && curr !== document.documentElement) {
              protectedAncestors.add(curr);
              curr = curr.parentElement || curr.parent;
            }
          }

          // 2. Semantic and Framework Modal Selectors
          const semanticSelectors = [
            // Standard ARIA dialogs & HTML5 dialog
            '[role="alertdialog"]',
            '[role="dialog"]',
            'dialog[open]',
            '[aria-modal="true"]',
            
            // Common component libraries & frameworks
            '.swal2-container.swal2-shown',
            '.swal2-popup',
            '.cdk-overlay-pane:has([role="dialog"], [role="alertdialog"], .mat-mdc-dialog-container, .mat-dialog-container)',
            '.mat-mdc-dialog-container',
            '.dx-dialog',
            '.dx-overlay-content',
            '.ant-modal',
            '.ant-modal-wrap',
            '.MuiDialog-root',
            '.ReactModal__Content',
            '.chakra-modal__content',
            
            // Generic modal & overlay classes/attributes
            '.modal.show',
            '.modal.in',
            '.modal',
            '.overlay',
            '.overlay-backdrop',
            '[class*="overlay" i]',
            '[id*="overlay" i]',
            '[class*="modal" i]',
            '[id*="modal" i]',
            '[class*="popup" i]',
            '[id*="popup" i]',
            '[class*="dialog" i]',
            '[id*="dialog" i]',
            '[data-testid*="modal" i]',
            '[data-testid*="dialog" i]',
            '[data-testid*="popup" i]',
            '[data-testid*="survey" i]',
            '[data-testid*="prompt" i]',
            '[data-testid*="alert" i]',
            
            // Cookie / consent banners
            '#cookie',
            '[id*="cookie" i]',
            '[class*="cookie" i]',
            '[class*="consent" i]',
            '[id*="consent" i]',
            '[class*="privacy" i]',
            '[id*="privacy" i]',
            '[aria-label*="cookie" i]',
            '#onetrust-banner-sdk',
            '#sp_message_container',
            
            // Toasts & floating announcement banners
            '.toast',
            '[class*="toast" i]',
            '[class*="announcement" i]',
            '[class*="notification" i]',
            '[class*="banner" i]',
            '.alert-dismissible'
          ];

          let rawCandidates = [];
          for (const sel of semanticSelectors) {
            try {
              const els = Array.from(document.querySelectorAll(sel));
              for (const el of els) {
                if (isVisible(el) && !rawCandidates.includes(el)) {
                  rawCandidates.push(el);
                }
              }
            } catch {}
          }

          // 3. Generic Geometry & Layout Scan for custom popups on ANY site
          try {
            const fixedElements = Array.from(document.querySelectorAll(
              'div, section, aside, article, form, [style*="fixed"], [style*="z-index"], .fixed'
            ));
            for (const el of fixedElements) {
              if (!isVisible(el) || rawCandidates.includes(el)) continue;
              const style = window.getComputedStyle(el);
              if (style.position !== 'fixed' && style.position !== 'sticky') continue;
              
              const rect = el.getBoundingClientRect();
              const z = parseInt(style.zIndex, 10);
              const isHighZ = !isNaN(z) && z >= 10;
              const isLargeOverlay = (rect.width >= window.innerWidth * 0.35 && rect.height >= window.innerHeight * 0.25);
              const isBanner = (rect.width >= window.innerWidth * 0.6 && (rect.top <= 80 || rect.bottom >= window.innerHeight - 80));
              
              const hasClickable = Boolean(el.querySelector('button, a, [role="button"], .close, .x, svg'));
              if ((isHighZ || isLargeOverlay || isBanner) && hasClickable) {
                rawCandidates.push(el);
              }
            }
          } catch {}

          if (rawCandidates.length === 0) {
            return { dismissed: false, isTargetInModal: protectedAncestors.size > 0 };
          }

          // CRUCIAL: Filter candidates to outermost containers ONLY!
          // Sub-elements like .modal-header, .modal-body, .modal-dialog are components of a modal,
          // never independent modals to be dismissed on their own!
          const candidates = rawCandidates.filter(candidate => {
            return !rawCandidates.some(other => other !== candidate && nodeContains(other, candidate));
          });

          const dispatchFullClick = (btn) => {
            btn.focus?.();
            if (typeof PointerEvent !== 'undefined') {
              btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
            }
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            btn.click?.();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          };

          // Target Protection: If action target is inside the container or container is ancestor of target, do NOT dismiss it
          for (const container of candidates) {
            let containsTarget = protectedAncestors.has(container);

            if (!containsTarget && targetData) {
              if (Array.isArray(targetData.selectors)) {
                for (const tSel of targetData.selectors) {
                  try {
                    if (tSel && container.querySelector(tSel)) {
                      containsTarget = true;
                      break;
                    }
                  } catch {}
                }
              }
              if (!containsTarget && Array.isArray(targetData.xpaths)) {
                for (const xp of targetData.xpaths) {
                  try {
                    const el = queryXPath(xp);
                    if (el && nodeContains(container, el)) {
                      containsTarget = true;
                      break;
                    }
                  } catch {}
                }
              }
              if (!containsTarget && Array.isArray(targetData.keywords)) {
                for (const kw of targetData.keywords) {
                  try {
                    if (kw && kw.length >= 2 && container.textContent && container.textContent.includes(kw)) {
                      containsTarget = true;
                      break;
                    }
                  } catch {}
                }
              }
            }

            if (containsTarget) {
              // Target is inside container, skip to next candidate
              continue;
            }

            // Protect Application Windows & Data Grids:
            // Do NOT dismiss application workspace windows (e.g. ExtJS .x-window), full application screens,
            // or containers containing enterprise data tables, forms, or grids.
            // These are destination application screens, NEVER spam popups or cookie banners!
            const isAppWindow = Boolean(
              (container.classList && (container.classList.contains('x-window') || container.classList.contains('x-panel'))) ||
              (container.closest && container.closest('.x-window')) ||
              (container.querySelector && container.querySelector('.x-grid, .x-grid-view, .x-panel-body, .x-window-header, .x-tab-bar, table thead, [role="grid"], [role="treegrid"]'))
            );
            if (isAppWindow) {
              continue;
            }

            // Collect all clickable elements inside the container
            const clickables = Array.from(container.querySelectorAll(
              'button, a, input[type="button"], input[type="submit"], [role="button"], .close, .btn-close, .modal-close, .popup-close, .overlay-close, .x, [data-testid*="close" i], [aria-label*="close" i], [title*="close" i], [data-dismiss], [data-bs-dismiss], span, div, i, svg'
            )).filter(isVisible);

            // Priority 1: Cross / Close button ("just cross it")
            const isCrossBtn = (b) => {
              if (!isVisible(b)) return false;
              const text = (b.textContent || b.value || '').trim();
              const aria = (b.getAttribute('aria-label') || '').trim();
              const title = (b.getAttribute('title') || '').trim();
              const testId = (b.getAttribute('data-testid') || '').trim();
              const cls = (typeof b.className === 'string' ? b.className : '').trim();
              const id = (b.id || '').trim();

              // Exact cross / times character or 'x' / 'X' / '+'
              if (/^([×✕✖✗✘⨯xX+]|\u00d7|\u2715|\u2716|\u2717|\u2718|\u2a2f|&times;)$/i.test(text)) return true;
              if (/^(close|dismiss|exit|cancel)$/i.test(text)) return true;
              if (/^[×✕✖✗✘xX]\s*(close|dismiss)?$/i.test(text)) return true;

              // Class name hints
              if (b.classList.contains('close') ||
                  b.classList.contains('btn-close') ||
                  b.classList.contains('modal-close') ||
                  b.classList.contains('popup-close') ||
                  b.classList.contains('overlay-close') ||
                  b.classList.contains('x') ||
                  b.classList.contains('swal2-close') ||
                  b.classList.contains('icon-close')) return true;
              if (/close|dismiss|modal-close|btn-close/i.test(cls)) return true;

              // Attribute hints
              if (/close|dismiss|exit|cancel/i.test(aria) ||
                  /close|dismiss|exit|cancel/i.test(title) ||
                  /close|dismiss/i.test(testId) ||
                  /close|dismiss/i.test(id)) return true;
              if (b.hasAttribute('data-dismiss') || b.hasAttribute('data-bs-dismiss')) return true;

              // SVG close icon inside button
              const svg = b.tagName === 'SVG' ? b : b.querySelector('svg');
              if (svg) {
                const sAria = (svg.getAttribute('aria-label') || '').trim();
                const sClass = (svg.getAttribute('class') || '').trim();
                if (/close|dismiss|x|cross|times/i.test(sAria) || /close|dismiss|x|cross|times/i.test(sClass)) return true;
                
                const rect = b.getBoundingClientRect();
                const isSmall = (rect.width <= 60 && rect.height <= 60);
                if (isSmall && (!text || /^([×✕✖xX+]|\s*)$/.test(text))) {
                  const cRect = container.getBoundingClientRect();
                  const inUpperSection = (rect.top - cRect.top) <= Math.max(80, cRect.height * 0.35);
                  if (inUpperSection) return true;
                }
              }

              // Child <i> or <span> icon classes
              const icon = b.querySelector('i, span');
              if (icon) {
                const iClass = (typeof icon.className === 'string' ? icon.className : '').trim();
                if (/fa-times|fa-xmark|bi-x|bi-x-lg|feather-x|lucide-x/i.test(iClass)) return true;
              }

              return false;
            };

            const crossButton = clickables.find(isCrossBtn);
            if (crossButton) {
              try {
                dispatchFullClick(crossButton);
                return {
                  dismissed: true,
                  isTargetInModal: protectedAncestors.size > 0,
                  method: 'cross_click',
                  detail: crossButton.getAttribute('aria-label') || crossButton.textContent?.trim() || 'cross'
                };
              } catch {}
            }

            // Priority 2: Dismissive / neutral / bypass action buttons ("or deal with it")
            const DISMISS_BUTTON_REGEX = /^(skip|no thanks|no, thanks|not now|later|maybe later|remind me later|never|don't ask again|don't show again|decline all|decline|reject all|reject|disagree|continue without accepting|close|cancel|dismiss|stay signed in|extend session|keep me logged in|keep signed in|keep working|continue session|refresh session|accept all|accept cookies|accept all cookies|accept recommended|accept|allow all|allow|agree|got it|ok|okay|i understand|continue|proceed|understood|confirm|exit|hide)$/i;

            const actionButton = clickables.find(b => {
              if (!isVisible(b)) return false;
              const text = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim();
              if (DISMISS_BUTTON_REGEX.test(text)) return true;
              if (b.classList.contains('swal2-confirm') || b.classList.contains('swal2-cancel')) return true;
              const bId = (b.id || '').toLowerCase();
              if (bId.includes('decline') || bId.includes('reject') || bId.includes('accept') ||
                  bId.includes('dismiss') || bId.includes('stay') || bId.includes('skip')) return true;
              return false;
            });

            if (actionButton) {
              try {
                dispatchFullClick(actionButton);
                return {
                  dismissed: true,
                  isTargetInModal: protectedAncestors.size > 0,
                  method: 'button_click',
                  detail: (actionButton.textContent || actionButton.value || '').trim()
                };
              } catch {}
            }
          }

          return { dismissed: false, isTargetInModal: protectedAncestors.size > 0 };
        }, targetData);

        if (dismissResult && dismissResult.dismissed) {
          totalDismissed++;
          logger.info(`[InterruptionHandler] Successfully dismissed unexpected popup via ${dismissResult.method} (${dismissResult.detail}).`);
          this._recordInterruption({
            type: 'blocking_overlay',
            method: dismissResult.method,
            detail: dismissResult.detail,
            timestamp: Date.now()
          });
          await new Promise(r => setTimeout(r, 150));
        } else {
          // If no unexpected popup was dismissed and target is inside an active modal, exit immediately!
          if (dismissResult && dismissResult.isTargetInModal) {
            return false;
          }
          break;
        }
      }

      if (totalDismissed > 0) {
        return true;
      }

      // Priority 3: If an unexpected dark modal backdrop is still present, attempt Escape key
      // ONLY if the target element is NOT inside an active modal!
      const backdropCheck = await page.evaluate((targetData) => {
        const backdrops = Array.from(document.querySelectorAll(
          '.cdk-overlay-dark-backdrop, .modal-backdrop, .swal2-backdrop, .overlay-backdrop'
        ));
        const hasVisible = backdrops.some(b => {
          const style = window.getComputedStyle(b);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!hasVisible) return { hasBackdrop: false, targetInModal: false };

        // Check if any target element exists inside a modal
        let targetInModal = false;
        if (targetData && Array.isArray(targetData.selectors)) {
          for (const sel of targetData.selectors) {
            try {
              const matched = document.querySelectorAll(sel);
              for (const m of matched) {
                if (m.closest('.modal, [role="dialog"], [aria-modal="true"], dialog, .swal2-container, .cdk-overlay-pane, .dx-dialog, .ant-modal, .MuiDialog-root')) {
                  targetInModal = true;
                  break;
                }
              }
            } catch {}
          }
        }
        return { hasBackdrop: true, targetInModal };
      }, targetData).catch(() => ({ hasBackdrop: false, targetInModal: false }));

      if (backdropCheck.hasBackdrop && !backdropCheck.targetInModal && page.keyboard) {
        await page.keyboard.press('Escape').catch(() => {});
        logger.info('[InterruptionHandler] Dispatched Escape key to dismiss blocking overlay backdrop.');
        await new Promise(r => setTimeout(r, 200));

        // Priority 4: If an empty/stuck blocking backdrop persists with no interactive children, disable pointer events
        await page.evaluate(() => {
          const backdrops = Array.from(document.querySelectorAll(
            '.cdk-overlay-dark-backdrop, .modal-backdrop, .swal2-backdrop, .overlay-backdrop:not(:has(button)):not(:has(input))'
          ));
          let count = 0;
          for (const b of backdrops) {
            const style = window.getComputedStyle(b);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              b.style.pointerEvents = 'none';
              b.style.display = 'none';
              count++;
            }
          }
          return count > 0;
        }).catch(() => false);

        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Action Execution Wrapper with Interruption Recovery.
   * 
   * When NO interruption occurs:
   *   Runs executionFn() directly with zero alteration.
   * 
   * ONLY when an unexpected interruption occurs (e.g. dialog blocked click,
   * modal backdrop obscured target, or lingering alert paused runtime):
   *   Clears the interruption and retries the action once.
   * 
   * @param {import('puppeteer-core').Page} page
   * @param {object} action
   * @param {() => Promise<any>} executionFn
   * @returns {Promise<any>}
   */
  async executeWithRecovery(page, action, executionFn) {
    // Proactive checks: clear any dialog or unexpected overlay sitting unhandled before running action
    if (page && (typeof page.isClosed !== 'function' || !page.isClosed())) {
      await this.clearLingeringDialogs(page).catch(() => {});
      await this.dismissBlockingOverlays(page, action).catch(() => {});
    }

    try {
      return await executionFn();
    } catch (err) {
      const errMsg = err ? (err.message || String(err)) : '';
      const isInterruptionError = (
        errMsg.includes('Click timeout') ||
        errMsg.includes('Target closed') ||
        errMsg.includes('Protocol error') ||
        errMsg.includes('Node is detached') ||
        errMsg.includes('not clickable') ||
        errMsg.includes('obscure') ||
        errMsg.includes('intercepts pointer events') ||
        errMsg.includes('Execution context was destroyed') ||
        errMsg.includes('waiting for dialog') ||
        errMsg.includes('Dialog is already open') ||
        errMsg.includes('not visible in DOM') ||
        errMsg.includes('not interactable') ||
        errMsg.includes('Element not found') ||
        errMsg.includes('Failed to click')
      );

      if (!isInterruptionError || !page || (typeof page.isClosed === 'function' && page.isClosed())) {
        throw err;
      }

      logger.warn(`[InterruptionHandler] Interruption detected during action #${action?.index || 0} (${action?.type}): ${errMsg}. Attempting recovery...`);

      // Attempt recovery:
      // 1. Clear any native dialog that may have appeared during the click
      const clearedDialog = await this.clearLingeringDialogs(page);

      // 2. Clear any blocking DOM modal or overlay
      const clearedOverlay = await this.dismissBlockingOverlays(page, action);

      if (clearedDialog || clearedOverlay) {
        // Prevent duplicate clicks: If a CLICK action was already dispatched to the browser,
        // re-dispatching it can cause double/triple window openings on legacy portals!
        if (action?.type === 'CLICK' && action._clickDispatched) {
          logger.info(`[InterruptionHandler] Click was already dispatched for action #${action?.index || 0}; skipping re-click to prevent duplicate window openings.`);
          return;
        }
        logger.info(`[InterruptionHandler] Interruption cleared (dialog=${clearedDialog}, overlay=${clearedOverlay}). Retrying action #${action?.index || 0}...`);
        await new Promise(r => setTimeout(r, 600));
        return await executionFn();
      }

      // If no specific dialog/overlay was found, propagate original error cleanly
      throw err;
    }
  }

  /**
   * Detect and close duplicate floating / modal windows on the page,
   * keeping only the single topmost active window.
   * If an ERP / legacy portal opened 3-4 identical windows, this closes the background
   * duplicates so the user and the loop system only have the single active window.
   *
   * @param {import('puppeteer-core').Page} page
   * @returns {Promise<{ closedCount: number, keptTitle: string | null }>}
   */
  async closeDuplicateWindows(page) {
    if (!page || typeof page.evaluate !== 'function') return { closedCount: 0, keptTitle: null };

    try {
      const result = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          if (typeof Element !== 'undefined' && !(el instanceof Element)) return false;
          const style = (window.getComputedStyle ? window.getComputedStyle(el) : el.style) || {};
          const rect = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : { width: 500, height: 400 };
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity || '1') > 0.05 &&
            rect.width > 80 &&
            rect.height > 60;
        };

        const getZIndex = (el) => {
          const cs = window.getComputedStyle(el);
          const z = parseInt(cs.zIndex, 10);
          return isNaN(z) ? 0 : z;
        };

        const windowSelectors = [
          '.x-window:not(.x-hidden):not(.x-hidden-offsets):not(.x-window-minimized)',
          '[role="dialog"]:not([aria-hidden="true"])',
          '[role="alertdialog"]:not([aria-hidden="true"])',
          'dialog[open]',
          '.modal.show',
          '.modal.in',
          '.modal:not([aria-hidden="true"])',
          '.ui-dialog:not([style*="display: none"])',
          '.dx-dialog',
          '.ant-modal:not(.ant-modal-hidden)',
          '.MuiDialog-root',
          '.chakra-modal__content'
        ];

        const allWindows = [];
        for (const sel of windowSelectors) {
          try {
            const found = Array.from(document.querySelectorAll(sel)).filter(isVisible);
            for (const w of found) {
              if (!allWindows.some(existing => existing === w || (w.id && existing.id === w.id))) {
                allWindows.push(w);
              }
            }
          } catch {}
        }

        // Check for custom fixed/absolute floating containers with header/title controls
        try {
          const floaters = Array.from(document.querySelectorAll('div, section, aside')).filter(el => {
            if (!isVisible(el) || allWindows.includes(el)) return false;
            const cs = window.getComputedStyle(el);
            if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
            const z = parseInt(cs.zIndex, 10);
            if (isNaN(z) || z < 10) return false;
            const rect = el.getBoundingClientRect();
            return rect.width >= 280 && rect.height >= 180 &&
              Boolean(el.querySelector('[class*="header" i], [class*="title" i], [class*="close" i], button, .x-tool'));
          });
          for (const f of floaters) {
            if (!allWindows.some(existing => existing === f || (f.id && existing.id === f.id))) {
              allWindows.push(f);
            }
          }
        } catch {}

        const nodeContains = (parent, child) => {
          if (!parent || !child) return false;
          if (typeof parent.contains === 'function') return parent.contains(child);
          return false;
        };

        // Deduplicate nested elements: keep ONLY the outermost window containers!
        // An inner container or panel inside an .x-window is part of that window, NOT an independent duplicate window!
        const topWindows = allWindows.filter(w => {
          return !allWindows.some(other => other !== w && nodeContains(other, w));
        });

        if (topWindows.length <= 1) return { closedCount: 0, keptTitle: null };

        const getWindowTitle = (w) => {
          const titleEl = w.querySelector(
            '.x-window-header-text, .x-title-text, .x-header-text, .modal-title, .ui-dialog-title, [class*="title" i], h1, h2, h3, h4, [role="heading"]'
          ) || w.querySelector('.x-window-header, [class*="header" i]');
          let text = (titleEl ? titleEl.textContent : '') || '';
          text = text.toLowerCase().replace(/\b(close|dismiss|minimize|maximize|restore)\b/gi, '').replace(/\s+/g, ' ').trim();
          if (text.length >= 4) return text;

          // Fallback: check inner grid header, tab panel, or table headers
          const header = w.querySelector('.x-grid-header, .x-grid3-header, .x-tab-bar, thead, th, .x-panel-header');
          if (header) {
            const hText = (header.textContent || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ').trim();
            if (hText.length >= 4) return hText;
          }

          return null; // Do NOT group windows if title is absent or generic
        };

        const groups = new Map();
        for (const w of topWindows) {
          const title = getWindowTitle(w);
          if (!title) continue;
          if (!groups.has(title)) groups.set(title, []);
          groups.get(title).push(w);
        }

        let closedCount = 0;
        let keptTitle = null;

        for (const [title, wins] of groups.entries()) {
          if (wins.length <= 1) continue;

          // Highest z-index is the active front-most window
          wins.sort((a, b) => {
            const za = getZIndex(a);
            const zb = getZIndex(b);
            if (za !== zb) return zb - za;
            if (typeof a.compareDocumentPosition === 'function') {
              return (a.compareDocumentPosition(b) & 4) ? -1 : 1;
            }
            return 0;
          });

          keptTitle = title;
          const keptWindow = wins[0];
          const duplicatesToClose = wins.slice(1);

          for (const dup of duplicatesToClose) {
            // Absolute safety check: Never touch the kept window or any element inside it!
            if (dup === keptWindow || nodeContains(keptWindow, dup) || nodeContains(dup, keptWindow)) continue;
            let dismissed = false;

            // 1. ExtJS native component destroy/close (strictly for the duplicate window itself)
            try {
              if (typeof window.Ext !== 'undefined' && window.Ext.getCmp && dup.id) {
                if (dup.id !== keptWindow.id) {
                  const cmp = window.Ext.getCmp(dup.id);
                  if (cmp && typeof cmp.close === 'function') {
                    cmp.close();
                    dismissed = true;
                  } else if (cmp && typeof cmp.destroy === 'function') {
                    cmp.destroy();
                    dismissed = true;
                  } else if (cmp && typeof cmp.hide === 'function') {
                    cmp.hide();
                    dismissed = true;
                  }
                }
              }
            } catch {}

            // 2. Click close button inside duplicate window (verifying button is NOT in kept window)
            try {
              const candidateButtons = Array.from(dup.querySelectorAll(
                'button, a, [role="button"], .x-tool, .x-tool-close, .close, .btn-close, .modal-close, span, div'
              )).filter(btn => {
                if (nodeContains(keptWindow, btn)) return false;
                const text = (btn.textContent || btn.value || '').trim();
                const aria = (btn.getAttribute('aria-label') || '').trim();
                const bTitle = (btn.getAttribute('title') || '').trim();
                const cls = (typeof btn.className === 'string' ? btn.className : '').trim();
                return /^(close|dismiss|exit|cancel|[×✕✖✗✘⨯xX+])$/i.test(text) ||
                  /close|dismiss/i.test(aria) ||
                  /close|dismiss/i.test(bTitle) ||
                  /x-tool-close|btn-close|modal-close|close/i.test(cls);
              });

              if (candidateButtons.length > 0) {
                const btn = candidateButtons[0];
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                btn.click?.();
                dismissed = true;
              }
            } catch {}

            // 3. Guarantee DOM removal and hiding ONLY for duplicate
            try {
              if (dup !== keptWindow && !nodeContains(dup, keptWindow)) {
                if (dup.style) {
                  dup.style.display = 'none';
                  dup.style.visibility = 'hidden';
                  dup.style.left = '-10000px';
                  dup.style.top = '-10000px';
                }
                if (typeof dup.setAttribute === 'function') {
                  dup.setAttribute('aria-hidden', 'true');
                }
                if (dup.classList && typeof dup.classList.add === 'function') {
                  dup.classList.add('x-hidden', 'x-hidden-offsets');
                }
                if (typeof dup.remove === 'function') {
                  dup.remove();
                }
                dismissed = true;
              }
            } catch {}

            if (dismissed) closedCount++;
          }
        }

        return { closedCount, keptTitle };
      });

      if (result && result.closedCount > 0) {
        logger.info(`[InterruptionHandler] Closed ${result.closedCount} duplicate "${result.keptTitle}" background window(s), keeping single active front-most window.`);
      }

      return result || { closedCount: 0, keptTitle: null };
    } catch (err) {
      logger.warn(`[InterruptionHandler] closeDuplicateWindows notice: ${err.message}`);
      return { closedCount: 0, keptTitle: null };
    }
  }

  _recordInterruption(record) {
    this.interruptionHistory.unshift(record);
    if (this.interruptionHistory.length > this.maxHistory) {
      this.interruptionHistory.length = this.maxHistory;
    }
  }

  getInterruptionLog() {
    return [...this.interruptionHistory];
  }
}

module.exports = InterruptionHandler;
