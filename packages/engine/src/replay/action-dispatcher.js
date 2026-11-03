/**
 * src/replay/action-dispatcher.js
 * Unified Action Dispatcher for browser action execution, wait heuristics,
 * secret injection, delay calculation, and CDP dispatching.
 */

const fs = require('fs');
const path = require('path');
const { calculateDelay } = require('./human-mouse');
const { DEFAULT_TIMEOUTS } = require('../shared/constants');
const { resolveTargetUrl } = require('../utils/url-helper');
const logger = require('../utils/logger');

const RESOLVER_PATH = path.resolve(__dirname, '../shared/selector-resolver.js');
let cachedResolverCode = null;
try {
  cachedResolverCode = fs.readFileSync(RESOLVER_PATH, 'utf8');
} catch (err) {
  logger.warn(`[ActionDispatcher] Failed to load selector-resolver at module init: ${err.message}`);
}

class ActionDispatcher {
  constructor(options = {}) {
    this.botConfig = options.botConfig || null;
    this.secretResolver = options.secretResolver || null;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUTS.RESOLUTION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_TIMEOUTS.POLL_INTERVAL_MS;
  }

  /**
   * Evaluates if a given action is likely to trigger a file download or export.
   * Checks explicit flags, action/element names, candidate selectors, and fingerprint attributes.
   * @param {Object} action
   * @returns {boolean}
   */
  static isDownloadAction(action) {
    if (!action) return false;
    if (action.isDownload === true) return true;
    const PATTERN = /download|export|save|pdf|print|file/i;
    if (action.name && PATTERN.test(action.name)) return true;
    if (action.elementName && PATTERN.test(action.elementName)) return true;
    if (action.target?.candidates?.some(c => c.value && PATTERN.test(c.value))) return true;

    const fp = action.target?.fingerprint || action.fingerprint;
    if (fp?.attributes?.title && PATTERN.test(fp.attributes.title)) return true;
    if (fp?.attributes?.href && PATTERN.test(fp.attributes.href)) return true;
    if (fp?.text && PATTERN.test(fp.text)) return true;

    if (action.text && PATTERN.test(action.text)) return true;

    return false;
  }

  /**
   * Calculates standardized humanized pacing delay from action timeDeltaMs.
   * @param {Object} step
   * @param {number} speed
   * @param {Object} botConfig
   * @returns {number} Delay in milliseconds
   */
  static calculatePacingDelay(step, speed = 1.0, botConfig = {}) {
    if (!step || !step.timeDeltaMs || speed <= 0) return 0;
    const maxPacing = (botConfig?.timing?.maxActionDelayMs && botConfig.timing.maxActionDelayMs > 1000)
      ? Math.max(botConfig.timing.maxActionDelayMs * 3, 15000)
      : 15000;
    return Math.min(Math.round(step.timeDeltaMs / speed), maxPacing);
  }

  /**
   * Calculates pre-action delay based on botConfig.
   * @param {Object} botConfig
   * @returns {number} Delay in milliseconds
   */
  static calculatePreActionDelay(botConfig = {}) {
    if (botConfig?.timing?.preActionDelayMs > 0) {
      return calculateDelay(
        Math.round(botConfig.timing.preActionDelayMs * 0.7),
        Math.round(botConfig.timing.preActionDelayMs * 1.3)
      );
    }
    return 0;
  }

  /**
   * Calculates post-action delay based on botConfig or default constants.
   * @param {Object} botConfig
   * @returns {number} Delay in milliseconds
   */
  static calculatePostActionDelay(botConfig = {}) {
    let postDelay = DEFAULT_TIMEOUTS.POST_ACTION_DELAY_MS;
    if (botConfig?.timing) {
      const minD = botConfig.timing.minActionDelayMs || 200;
      const maxD = botConfig.timing.maxActionDelayMs || 600;
      postDelay = calculateDelay(minD, maxD, 'gaussian');
    }
    return postDelay;
  }

  /**
   * Evaluates if a given action targets an option or pseudo-checkbox inside a combobox/dropdown.
   * @param {Object} action
   * @returns {boolean}
   */
  static isOptionAction(action) {
    if (!action) return false;
    const candidates = action.target?.candidates || action.candidates || [];
    const fp = action.target?.fingerprint || action.fingerprint || {};

    return Boolean(
      candidates.some(c => c.value && (c.value.includes('option') || c.value.includes('pseudo-checkbox'))) ||
      fp.tagName === 'mat-option' ||
      fp.tagName === 'mat-pseudo-checkbox' ||
      fp.role === 'option'
    );
  }

  /**
   * Looks ahead to check if the subsequent action targets a dropdown option.
   * @param {Object} recording
   * @param {number} nextIndex
   * @returns {boolean}
   */
  static isNextActionOption(recording, nextIndex) {
    const actions = recording?.actions || (Array.isArray(recording) ? recording : null);
    if (!actions || nextIndex >= actions.length) return false;
    return ActionDispatcher.isOptionAction(actions[nextIndex]);
  }

  /**
   * Resolves secrets inside action parameters (e.g. {{secret:secretId}}).
   * Returns a deep clone of the action with resolved values.
   * @param {Object} action
   * @param {Function} secretResolver
   * @param {number} actionIndex
   * @returns {Promise<Object>}
   */
  static async resolveActionSecrets(action, secretResolver = null, actionIndex = 0) {
    const actionToDispatch = { ...action };
    if (actionToDispatch.type === 'TYPE' && typeof actionToDispatch.value === 'string') {
      const match = actionToDispatch.value.match(/^{{secret:([^}]+)}}$/);
      if (match && typeof secretResolver === 'function') {
        logger.info(`Injecting secret [${match[1]}] for action #${actionIndex + 1}...`);
        actionToDispatch.value = await secretResolver(match[1]);
      }
    }
    return actionToDispatch;
  }

  /**
   * Resolves target element inside an already-discovered collection item container.
   * Avoids globally resolving the selector to prevent matching the first item repeatedly.
   * @param {Object} itemHandle Puppeteer JSHandle for the collection item container
   * @param {Object} target Target object containing candidates and/or fingerprint
   * @returns {Promise<Object>} JSHandle for resolved element, or null
   */
  static async resolveTargetWithinItem(itemHandle, target) {
    if (!itemHandle) return null;
    return itemHandle.evaluateHandle((item, tgt) => {
      if (!item) return null;

      const visible = (el) => {
        if (!el) return false;
        if (typeof Element !== 'undefined' && !(el instanceof Element)) return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        if (typeof el.getBoundingClientRect === 'function') {
          const rect = el.getBoundingClientRect();
          if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
        }
        return true;
      };

      const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const fingerprint = tgt?.fingerprint || {};
      const candidates = Array.isArray(tgt?.candidates) ? tgt.candidates : [];

      const score = (el) => {
        if (!visible(el)) return -1;
        let value = 0;
        if (fingerprint.tagName && el.tagName.toLowerCase() === String(fingerprint.tagName).toLowerCase()) value += 0.25;
        if (fingerprint.role && el.getAttribute('role') === fingerprint.role) value += 0.2;
        if (fingerprint.ariaLabel && el.getAttribute('aria-label') === fingerprint.ariaLabel) value += 0.2;
        const targetText = normalize(fingerprint.text);
        const elementText = normalize(el.textContent);
        if (targetText && elementText === targetText) value += 0.35;
        else if (targetText && elementText.includes(targetText)) value += 0.25;
        if (fingerprint.id && el.id === fingerprint.id) value += 0.2;
        return value;
      };

      // Prefer recorded CSS selectors or relative XPath, but only within this item.
      for (const candidate of candidates) {
        if (!candidate?.value) continue;
        const value = candidate.value;

        // :scope represents the discovered item itself.
        if (value === ':scope') return visible(item) ? item : null;

        // Support relative XPath starting with '.'
        if (value.startsWith('.')) {
          try {
            const res = document.evaluate(value, item, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < res.snapshotLength; i++) {
              const node = res.snapshotItem(i);
              if (visible(node)) return node;
            }
          } catch {}
          continue;
        }

        const looksXPath = value.startsWith('//') || value.startsWith('(');
        if (looksXPath) continue;

        try {
          const matches = Array.from(item.querySelectorAll(value)).filter(visible);
          if (matches.length === 1) return matches[0];
          if (matches.length > 1) {
            return matches.sort((a, b) => score(b) - score(a))[0];
          }
        } catch {}
      }

      // Fingerprint fallback scoped to the item.
      const tag = fingerprint.tagName && fingerprint.tagName !== 'unknown'
        ? fingerprint.tagName.toLowerCase()
        : '*';
      let pool = Array.from(item.querySelectorAll(tag)).filter(visible);
      if (!pool.length) pool = Array.from(item.querySelectorAll('*')).filter(visible);

      // A generalized target may intentionally point at the item itself.
      if (tag === '*' || item.tagName.toLowerCase() === tag) {
        if (visible(item) && score(item) >= 0) pool.unshift(item);
      }

      if (fingerprint.ariaLabel) {
        const ariaMatches = pool.filter(el => el.getAttribute('aria-label') === fingerprint.ariaLabel);
        if (ariaMatches.length) pool = ariaMatches;
      }

      const targetText = normalize(fingerprint.text);
      if (targetText && !tgt?.scope) {
        const textMatches = pool.filter(el => normalize(el.textContent) === targetText);
        if (textMatches.length) pool = textMatches;
      }

      pool.sort((a, b) => score(b) - score(a));
      if (pool[0]) return pool[0];

      // Check if target is a checkbox/switch control
      const isCbTarget = Boolean(
        tgt?.isCheckbox ||
        fingerprint.isCheckbox ||
        fingerprint.type === 'checkbox' ||
        fingerprint.role === 'checkbox' ||
        fingerprint.tagName === 'mat-pseudo-checkbox' ||
        (typeof tgt?.name === 'string' && /checkbox/i.test(tgt.name)) ||
        (typeof tgt?.elementName === 'string' && /checkbox/i.test(tgt.elementName))
      );
      if (isCbTarget) {
        const cbPool = Array.from(item.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], .mat-pseudo-checkbox, .dx-checkbox, mat-checkbox')).filter(visible);
        if (cbPool.length > 0) {
          cbPool.sort((a, b) => score(b) - score(a));
          return cbPool[0];
        }
        return null; // Never click an unrelated button or link when targeting a checkbox!
      }

      // If target was an interactive button or link control
      const isClickable = Boolean(
        ['a', 'button'].includes(tag) ||
        fingerprint.role === 'button' ||
        fingerprint.role === 'link'
      );
      if (isClickable) {
        const fallbackClickable = Array.from(item.querySelectorAll('a[href], button, [role="button"]')).filter(visible);
        if (fallbackClickable.length > 0) {
          fallbackClickable.sort((a, b) => score(b) - score(a));
          return fallbackClickable[0];
        }
      }

      return (tag === '*' || tag === item.tagName.toLowerCase()) && visible(item) && score(item) >= 0 ? item : null;
    }, target);
  }

  /**
   * Ensures SelectorResolver script is injected into the frame context.
   * @param {Object} frame Puppeteer Frame
   * @param {Object} fallbackPage Fallback page if frame is null
   */
  static async ensureSelectorResolverInFrame(frame, fallbackPage = null) {
    try {
      const targetFrame = frame || fallbackPage;
      if (!targetFrame || (typeof targetFrame.isDetached === 'function' && targetFrame.isDetached())) return;
      const isResolverLoaded = await targetFrame.evaluate(() => typeof window.SelectorResolver !== 'undefined').catch(() => false);

      if (!isResolverLoaded) {
        if (typeof targetFrame.isDetached === 'function' && targetFrame.isDetached()) return;
        if (!cachedResolverCode) {
          cachedResolverCode = fs.readFileSync(RESOLVER_PATH, 'utf8');
        }
        await targetFrame.evaluate(cachedResolverCode).catch(() => {});
      }
    } catch {
      // Ignore transient detached frame errors
    }
  }

  /**
   * Executes a NAVIGATE action to target URL with stealth evasion.
   * @param {Object} page Puppeteer Page
   * @param {Object} action
   * @param {Object} options
   */
  static async executeNavigation(page, action, options = {}) {
    const navUrl = resolveTargetUrl(action.url) || action.url;
    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout || 30000 });
    if (typeof options.applyStealthEvasion === 'function') {
      await options.applyStealthEvasion();
    }
    await new Promise(r => setTimeout(r, options.delayMs || 500));
    return { success: true, type: 'NAVIGATE', url: navUrl };
  }
}

module.exports = ActionDispatcher;
