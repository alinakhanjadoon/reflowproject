/**
 * Shared Selector Resolver (Isomorphic: Browser & Node.js)
 * 
 * Responsible for:
 * 1. Generating ranked selector candidates at capture time
 * 2. Building element semantic fingerprints
 * 3. Resolving elements with weighted confidence scoring at replay time
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js CommonJS
    const constants = require('./constants');
    module.exports = factory(constants);
  } else {
    // Browser global / injected page context
    root.SelectorResolver = factory(root.__WORKFLOW_CONSTANTS__ || null);
  }
})(typeof self !== 'undefined' ? self : this, function (importedConstants) {
  // Fallback defaults if executed in browser without bundle
  const CONSTANTS = importedConstants || {
    ACTION_TYPES: { CLICK: 'CLICK', DOUBLE_CLICK: 'DOUBLE_CLICK', TYPE: 'TYPE', SELECT: 'SELECT', KEY_PRESS: 'KEY_PRESS', SCROLL: 'SCROLL' },
    SELECTOR_STRATEGIES: {
      ID: 'id',
      DATA_ATTR: 'data-attr',
      ATTRIBUTE: 'attribute',
      TEXT: 'text',
      CSS_PATH: 'css-path',
      XPATH: 'xpath'
    },
    STRATEGY_PRIORITIES: { id: 1, 'data-attr': 2, attribute: 3, text: 4, 'css-path': 5, xpath: 6 },
    RESOLVER_WEIGHTS: {
      ID_OR_NAME: 0.30,
      DATA_OR_ARIA: 0.25,
      VISIBLE_TEXT: 0.25,
      OTHER_ATTRS: 0.10,
      CLASSES: 0.10
    },
    MIN_CONFIDENCE_THRESHOLD: 0.70,
    UNSTABLE_ID_PATTERN: /(:r[0-9a-z_-]+:|^ng-|^__|^ember|^\d+$|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|_[0-9a-zA-Z]{5,}|^gridview-\d+|^record-\d+|^tableview-\d+|^ext-gen|^ext-comp|^panel-\d+|^menuitem-\d+|^button-\d+|ext-element-\d+|^toolbar-\d+|^container-\d+|^headercontainer-\d+|^box-\d+|^form-\d+|^tabbar-\d+|^splitbar-\d+|^window-\d+|^field-\d+|^component-\d+|^view-\d+|-[0-9]{3,}(-[a-zA-Z0-9_-]+)?$|^mat-select-value-\d+|^mat-option-\d+|^mat-select-\d+|^mat-checkbox-\d+|^mat-input-\d+|^mat-form-field-|^mat-mdc-|^cdk-overlay-|^cdk-describedby-)/i,
    TRANSIENT_CLASS_PATTERN: /^(active|hover|focus|focus-visible|disabled|selected|open|closed|show|hide|entering|leaving|animate-|transition-|css-[a-z0-9]+$)/i,
    PREFERRED_DATA_ATTRIBUTES: [
      'data-testid',
      'data-test',
      'data-qa',
      'data-cy',
      'data-automation',
      'data-id',
      'data-action',
      'data-component'
    ]
  };

  /**
   * Escape special characters in CSS selector components
   */
  function escapeCss(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(str);
    }
    return str.replace(/([#;&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
  }

  /**
   * Check if ID is likely stable across builds and page loads
   */
  function isStableId(id) {
    if (!id || typeof id !== 'string') return false;
    const trimmed = id.trim();
    if (trimmed.length < 2 || trimmed.length > 50) return false;
    return !CONSTANTS.UNSTABLE_ID_PATTERN.test(trimmed);
  }

  /**
   * Filter out dynamic, transient, or CSS-in-JS utility classes
   */
  function filterStableClasses(classList) {
    if (!classList) return [];
    const classes = Array.from(classList);
    return classes.filter(cls => {
      if (!cls || typeof cls !== 'string') return false;
      const clean = cls.trim();
      if (clean.length < 2) return false;
      return !CONSTANTS.TRANSIENT_CLASS_PATTERN.test(clean);
    });
  }

  /**
   * Safe check for element class presence across standard DOM, mock objects, and array-based classLists
   */
  function hasElementClass(element, cls) {
    if (!element) return false;
    if (element.classList) {
      if (typeof element.classList.contains === 'function') return element.classList.contains(cls);
      if (Array.isArray(element.classList)) return element.classList.includes(cls);
    }
    if (typeof element.className === 'string') {
      return element.className.split(/\s+/).includes(cls);
    }
    return false;
  }

  /**
   * Normalize text content for comparison
   */
  function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Safely format a string literal for XPath 1.0 (handling single and double quotes)
   */
  function toXPathString(str) {
    if (!str || typeof str !== 'string') return "''";
    if (!str.includes("'")) return `'${str}'`;
    if (!str.includes('"')) return `"${str}"`;
    const parts = str.split("'").map(p => `'${p}'`);
    return `concat(${parts.join(', "\'", ')})`;
  }

  /**
   * Safe document querySelectorAll wrapper
   */
  function queryAll(selector, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return [];
    try {
      return Array.from(d.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  /**
   * Evaluate XPath in document
   */
  function queryXPath(xpath, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof XPathResult === 'undefined') return [];
    try {
      const result = d.evaluate(xpath, d, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        nodes.push(result.snapshotItem(i));
      }
      return nodes;
    } catch {
      return [];
    }
  }

  /**
   * Check if element is visible
   */
  function isElementVisible(element) {
    if (!element || element.nodeType !== 1) return false;
    const isBackdrop = Boolean(
      hasElementClass(element, 'cdk-overlay-backdrop') ||
      hasElementClass(element, 'modal-backdrop') ||
      (element.className && typeof element.className === 'string' && element.className.includes('backdrop'))
    );

    if (element.offsetParent === null && element.tagName.toLowerCase() !== 'body') {
      // Check if position is fixed or element is a fixed backdrop
      if (typeof window !== 'undefined') {
        const style = window.getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky' && !isBackdrop) {
          return false;
        }
      } else {
        return false;
      }
    }
    if (typeof window !== 'undefined') {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      if (style.opacity === '0' && !isBackdrop) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    if (rect && (rect.width <= 0 || rect.height <= 0 || rect.top < -5000 || rect.left < -5000)) {
      return false;
    }
    return true;
  }

  /**
   * Check if element is interactable (visible and not disabled)
   */
  function isElementInteractable(element) {
    if (!isElementVisible(element)) return false;
    if (element.disabled === true) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  /**
   * Generate scoped CSS path from element up to a stable ancestor or body
   */
  function generateCssPath(element, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!element || element.nodeType !== 1) return null;

    const path = [];
    let current = element;

    while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== 'html') {
      const tag = current.tagName.toLowerCase();

      if (isStableId(current.id)) {
        path.unshift(`#${escapeCss(current.id)}`);
        break;
      }

      if (current.tagName.toLowerCase() === 'body') {
        path.unshift('body');
        break;
      }

      const parent = current.parentElement;
      if (!parent) {
        path.unshift(tag);
        break;
      }

      const children = parent.children ? Array.from(parent.children) : [];
      const sameTagChildren = children.filter(c => c.tagName === current.tagName);

      if (sameTagChildren.length === 1) {
        path.unshift(tag);
      } else {
        const index = sameTagChildren.indexOf(current) + 1;
        path.unshift(`${tag}:nth-of-type(${index})`);
      }

      current = parent;
    }

    const fullPath = path.join(' > ');
    return fullPath || null;
  }

  /**
   * Generate absolute XPath for element
   */
  function generateXPath(element) {
    if (!element || element.nodeType !== 1) return null;
    if (element.tagName.toLowerCase() === 'html') return '/html[1]';
    if (element.tagName.toLowerCase() === 'body') return '/html[1]/body[1]';

    if (isStableId(element.id)) {
      return `//*[@id='${element.id}']`;
    }

    let index = 1;
    const siblings = (element.parentElement && element.parentElement.children) ? Array.from(element.parentElement.children) : [];
    for (const sib of siblings) {
      if (sib === element) break;
      if (sib.tagName === element.tagName) index++;
    }

    const parentXPath = element.parentElement ? generateXPath(element.parentElement) : '';
    return `${parentXPath}/${element.tagName.toLowerCase()}[${index}]`;
  }

  /**
   * Generate ranked selector candidates for a DOM element
   */
  function generateCandidates(element, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!element || element.nodeType !== 1) return [];

    const candidates = [];
    const seenSelectors = new Set();
    const tag = element.tagName.toLowerCase();

    function addCandidate(strategy, value) {
      if (!value || seenSelectors.has(value)) return;
      seenSelectors.add(value);
      const isXpath = strategy === CONSTANTS.SELECTOR_STRATEGIES.XPATH || value.startsWith('//') || value.startsWith('(');
      const matched = isXpath ? queryXPath(value, d) : queryAll(value, d);
      const uniqueness = matched.length;

      candidates.push({
        strategy,
        value,
        uniqueness,
        priority: CONSTANTS.STRATEGY_PRIORITIES[strategy] || 99
      });
    }

    // 1. Stable ID
    if (isStableId(element.id)) {
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ID, `#${escapeCss(element.id)}`);
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ID, `${tag}#${escapeCss(element.id)}`);
    }

    // 1b. Backdrop / Overlay dismiss elements (clicking outside in blank space to close dropdowns or modals)
    const isBackdropCandidate = Boolean(
      hasElementClass(element, 'cdk-overlay-backdrop') ||
      hasElementClass(element, 'modal-backdrop') ||
      (element.className && typeof element.className === 'string' && element.className.includes('backdrop'))
    );
    if (isBackdropCandidate) {
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, '.cdk-overlay-backdrop');
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, '.cdk-overlay-container .cdk-overlay-backdrop');
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.XPATH, '//*[contains(@class, "cdk-overlay-backdrop")]');
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.XPATH, '//*[contains(@class, "backdrop")]');
    }

    // 2. Preferred Data Attributes (data-testid, data-qa, data-cy, data-id)
    for (const attr of CONSTANTS.PREFERRED_DATA_ATTRIBUTES) {
      if (element.hasAttribute(attr)) {
        const val = element.getAttribute(attr);
        if (val && isStableId(val)) {
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.DATA_ATTR, `[${attr}="${escapeCss(val)}"]`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.DATA_ATTR, `${tag}[${attr}="${escapeCss(val)}"]`);
        }
      }
    }

    // Check any other custom data-* attributes (verifying value is stable and not dynamic like button-1998)
    if (element.attributes) {
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        if (attr.name.startsWith('data-') && !CONSTANTS.PREFERRED_DATA_ATTRIBUTES.includes(attr.name)) {
          if (attr.value && isStableId(attr.value)) {
            addCandidate(CONSTANTS.SELECTOR_STRATEGIES.DATA_ATTR, `[${attr.name}="${escapeCss(attr.value)}"]`);
          }
        }
      }
    }

    // 3. Meaningful Attributes: name, aria-label, role, placeholder, type, title, alt, src
    const meaningfulAttrs = ['name', 'aria-label', 'placeholder', 'role', 'title', 'alt', 'src'];
    for (const attr of meaningfulAttrs) {
      if (element.hasAttribute(attr)) {
        const val = element.getAttribute(attr);
        if (val && val.trim()) {
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${tag}[${attr}="${escapeCss(val)}"]`);
          // If attr is src or href, also add a filename/keyword candidate (e.g. img[src*="save" i])
          if ((attr === 'src' || attr === 'href') && val.length > 5) {
            const lastSegment = val.split(/[/?#]/).filter(Boolean).pop() || '';
            if (lastSegment && lastSegment.length >= 3 && lastSegment.length <= 40) {
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${tag}[${attr}*="${escapeCss(lastSegment)}"]`);
            }
          }
        }
      }
    }

    // Keyword attribute matchers for common action buttons (Save, Export, Print, PDF, Download, Submit, Close)
    for (const attr of ['title', 'alt', 'aria-label', 'data-action']) {
      if (element.hasAttribute(attr)) {
        const val = (element.getAttribute(attr) || '').trim();
        const actionKeywords = ['save', 'export', 'pdf', 'print', 'download', 'close', 'submit', 'search', 'filter'];
        const matchesKeyword = actionKeywords.some(kw => val.toLowerCase().includes(kw));
        if (matchesKeyword && val.length <= 100) {
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${tag}[${attr}="${escapeCss(val)}"]`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `[${attr}="${escapeCss(val)}"]`);
          for (const kw of actionKeywords) {
            if (val.toLowerCase().includes(kw)) {
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${tag}[${attr}*="${kw}" i]`);
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `[${attr}*="${kw}" i]`);
            }
          }
        }
      }
    }

    // Enclosing Option / Dropdown Item / Checkbox List Item (Angular Material mat-option, [role="option"], etc.)
    const optionParent = (typeof element.closest === 'function')
      ? element.closest('mat-option, [role="option"], .mat-mdc-option, [role="menuitem"], [role="treeitem"], label, li')
      : null;
    if (optionParent) {
      const optTag = optionParent.tagName.toLowerCase();
      const optText = normalizeText(optionParent.textContent || '');
      if (optText && optText.length > 0) {
        const xpOpt = toXPathString(optText);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[normalize-space()=${xpOpt}]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[contains(normalize-space(), ${xpOpt})]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//*[@role='option'][contains(normalize-space(), ${xpOpt})]`);

        // If clicked target is a child (e.g. mat-pseudo-checkbox or icon)
        if (optionParent !== element) {
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[contains(., ${xpOpt})]//${tag}`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[contains(., ${xpOpt})]//*[contains(@class, 'checkbox') or contains(@class, 'pseudo-checkbox')]`);
        }

        // Substring / prefix candidate for long formatted items: "105992 - DIXIE HIGHWAY..." -> "105992"
        const prefix = optText.split(/[-–—(:]/)[0].trim();
        if (prefix && prefix.length >= 3 && prefix !== optText) {
          const xpPrefix = toXPathString(prefix);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[contains(., ${xpPrefix})]`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//*[@role='option'][contains(., ${xpPrefix})]`);
          if (optionParent !== element) {
            addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//${optTag}[contains(., ${xpPrefix})]//${tag}`);
          }
        }
      }
    }

    // Form Controls with Associated Labels (e.g. Customer dropdown / combobox)
    const formField = (typeof element.closest === 'function')
      ? element.closest('mat-form-field, .mat-form-field, .mat-mdc-form-field, .form-group, .form-field')
      : null;
    if (formField) {
      const labelEl = formField.querySelector('mat-label, label, .mat-form-field-label, [id*="label"]');
      if (labelEl) {
        const labelText = normalizeText(labelEl.textContent || '').replace(/[*:]/g, '').trim();
        if (labelText.length >= 2) {
          const xpLbl = toXPathString(labelText);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//mat-form-field[.//text()[contains(., ${xpLbl})]]//mat-select`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//mat-form-field[.//text()[contains(., ${xpLbl})]]//*[contains(@class, 'select-value') or contains(@class, 'select-trigger')]`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//label[contains(., ${xpLbl})]/..//mat-select`);
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//label[contains(., ${xpLbl})]/..//div[contains(@class, 'select')]`);
        }
      }
    }

    // Dropdown / Combobox Direct Host Candidates
    const isCombobox = tag === 'mat-select' || (element.getAttribute && element.getAttribute('role') === 'combobox') ||
      hasElementClass(element, 'mat-mdc-select') || hasElementClass(element, 'mat-select');
    if (isCombobox) {
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, 'mat-select');
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, '[role="combobox"]');
      const aria = element.getAttribute ? element.getAttribute('aria-label') : null;
      if (aria) {
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `mat-select[aria-label="${escapeCss(aria)}"]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `[role="combobox"][aria-label="${escapeCss(aria)}"]`);
      }
    }

    // If element is an input button / submit / reset: Extract value attribute for high-precision candidates
    if (tag === 'input' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase())) {
      const btnVal = normalizeText(element.value || element.getAttribute('value') || '');
      if (btnVal) {
        const escapedBtnVal = escapeCss(btnVal);
        const xpBtnVal = toXPathString(btnVal);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `input[value="${escapedBtnVal}"]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `input[type="${element.type}"][value="${escapedBtnVal}"]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//input[@value=${xpBtnVal}]`);
        addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//input[contains(@value, ${xpBtnVal})]`);
      }
    }

    // If element is an icon/image/span inside an interactive parent (button, link, toolbar-item), capture parent candidate
    if (['img', 'i', 'span', 'svg', 'path', 'div', 'td', 'mat-pseudo-checkbox'].includes(tag) && element.parentElement) {
      const interactiveParent = (typeof element.closest === 'function')
        ? element.closest('button, a, [role="button"], [role="menuitem"], [role="option"], mat-option, .dxxr-item, .dxxr-btn, .dx-button, .dxrd-toolbar-item, .dxm-item, .dxm-content, .dxbButton, [id*="Splitter_Toolbar_Menu"], .x-btn, [onclick], input')
        : null;
      if (interactiveParent && interactiveParent !== element) {
        const parentTag = interactiveParent.tagName.toLowerCase();
        for (const pAttr of ['title', 'aria-label', 'data-testid', 'data-action', 'name', 'id']) {
          if (interactiveParent.hasAttribute(pAttr)) {
            const pVal = (interactiveParent.getAttribute(pAttr) || '').trim();
            if (pVal && (pAttr !== 'id' || isStableId(pVal))) {
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${parentTag}[${pAttr}="${escapeCss(pVal)}"] ${tag}`);
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.ATTRIBUTE, `${parentTag}[${pAttr}="${escapeCss(pVal)}"]`);
            }
          }
        }
      }
    }

    // 4. Visible Text (Buttons, Links, Labels, Grid Cells, or interactive elements with short text)
    let textContent = normalizeText(element.textContent || '');
    if (!textContent && tag === 'input' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase())) {
      textContent = normalizeText(element.value || element.getAttribute('value') || '');
    }
    if (textContent && textContent.length > 0 && textContent.length <= 60) {
      if (['button', 'a', 'label', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'td', 'th', 'li', 'mat-option', 'input'].includes(tag)) {
        const xpText = toXPathString(textContent);
        if (tag === 'input') {
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, `//input[@value=${xpText}]`);
        } else {
          // XPath exact text match
          const textXPath = `//${tag}[normalize-space()=${xpText}]`;
          addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, textXPath);

          // If it has stable classes (e.g. ExtJS .x-grid-cell-inner), generate class-scoped text XPath
          if (element.classList && element.classList.length > 0) {
            const stableClasses = filterStableClasses(element.classList);
            if (stableClasses.length > 0) {
              const classTextXPath = `//${tag}[contains(@class, '${escapeCss(stableClasses[0])}') and normalize-space()=${xpText}]`;
              addCandidate(CONSTANTS.SELECTOR_STRATEGIES.TEXT, classTextXPath);
            }
          }
        }
      }
    }

    // 5. Scoped CSS Path
    const cssPath = generateCssPath(element, d);
    if (cssPath) {
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.CSS_PATH, cssPath);
    }

    // 6. Full XPath fallback
    const xpath = generateXPath(element);
    if (xpath) {
      addCandidate(CONSTANTS.SELECTOR_STRATEGIES.XPATH, xpath);
    }

    // Sort: Unique matches (uniqueness === 1) first by priority, then non-unique by priority
    candidates.sort((a, b) => {
      const aUnique = a.uniqueness === 1 ? 0 : 1;
      const bUnique = b.uniqueness === 1 ? 0 : 1;
      if (aUnique !== bUnique) return aUnique - bUnique;
      return a.priority - b.priority;
    });

    return candidates;
  }

  /**
   * Create an element semantic fingerprint
   */
  function createFingerprint(element) {
    if (!element || element.nodeType !== 1) {
      return { tagName: 'unknown' };
    }

    const tag = element.tagName.toLowerCase();
    const isPassword = tag === 'input' && (element.type || '').toLowerCase() === 'password';
    let text = isPassword ? '' : normalizeText(element.textContent || '').slice(0, 120);

    // If element is an input button/submit/reset, use element.value as text
    if (!text && tag === 'input' && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase())) {
      text = normalizeText(element.value || element.getAttribute('value') || '').slice(0, 120);
    }

    // If text is empty (e.g. checkbox or icon inside option/button/label), inherit enclosing text
    if (!text || text.length === 0) {
      const textParent = (typeof element.closest === 'function')
        ? element.closest('mat-option, [role="option"], .mat-mdc-option, button, a, [role="button"], label, li, tr')
        : null;
      if (textParent) {
        text = normalizeText(textParent.textContent || '').slice(0, 120);
      }
    }

    const attributes = {};
    const trackedAttrs = ['name', 'type', 'role', 'placeholder', 'aria-label', 'title', 'href', 'value'];
    for (const attr of trackedAttrs) {
      if (element.hasAttribute(attr)) {
        attributes[attr] = element.getAttribute(attr);
      }
    }

    // If title is missing on element, inherit from inner icon/image (common for toolbar buttons)
    if (!attributes.title && element.querySelector) {
      const innerTitleEl = element.querySelector('[title], img[alt]');
      if (innerTitleEl) {
        const innerTitle = innerTitleEl.getAttribute('title') || innerTitleEl.getAttribute('alt');
        if (innerTitle) attributes.title = innerTitle;
      }
    }

    const dimensions = { width: 0, height: 0 };
    if (element.getBoundingClientRect) {
      const rect = element.getBoundingClientRect();
      dimensions.width = Math.round(rect.width);
      dimensions.height = Math.round(rect.height);
    }

    const isInputCb = tag === 'input' && (element.type || '').toLowerCase() === 'checkbox';
    const isRoleCb = (typeof element.getAttribute === 'function' && (element.getAttribute('role') || '').toLowerCase() === 'checkbox');
    const isPseudoCb = tag === 'mat-pseudo-checkbox' || (element.classList && typeof element.classList.contains === 'function' && element.classList.contains('mat-pseudo-checkbox'));
    const isMatCb = tag === 'mat-checkbox' || (typeof element.closest === 'function' && Boolean(element.closest('mat-checkbox, .mat-mdc-checkbox, dx-check-box')));
    const optContainer = typeof element.closest === 'function' ? element.closest('mat-option, [role="option"], .mat-mdc-option') : null;
    const isOptionCb = Boolean(optContainer && (
      optContainer.querySelector?.('.mat-pseudo-checkbox, [role="checkbox"], input[type="checkbox"]') ||
      optContainer.classList?.contains?.('mat-mdc-option-multiple')
    ));
    const isCheckbox = isInputCb || isRoleCb || isPseudoCb || isMatCb || isOptionCb;

    let checked = null;
    if (isCheckbox) {
      if (tag === 'input' && typeof element.checked === 'boolean') {
        checked = element.checked;
      } else {
        const aria = typeof element.getAttribute === 'function' ? element.getAttribute('aria-checked') : null;
        if (aria !== null && aria !== undefined) {
          checked = aria === 'true';
        } else if (optContainer) {
          const ariaSel = typeof optContainer.getAttribute === 'function' ? optContainer.getAttribute('aria-selected') : null;
          if (ariaSel !== null && ariaSel !== undefined) {
            checked = ariaSel === 'true';
          } else if (optContainer.classList && typeof optContainer.classList.contains === 'function') {
            checked = optContainer.classList.contains('mat-mdc-option-selected') ||
                      optContainer.classList.contains('mat-option-selected') ||
                      Boolean(optContainer.querySelector?.('.mat-pseudo-checkbox-checked'));
          }
        } else if (element.classList && typeof element.classList.contains === 'function') {
          checked = element.classList.contains('mat-mdc-checkbox-checked') ||
                    element.classList.contains('mat-checkbox-checked') ||
                    element.classList.contains('dx-checkbox-checked') ||
                    element.classList.contains('mat-pseudo-checkbox-checked') ||
                    element.classList.contains('is-checked') ||
                    element.classList.contains('checked');
        }
      }
    }

    return {
      tagName: tag,
      id: isStableId(element.id) ? element.id : null,
      name: element.getAttribute('name') || null,
      type: element.getAttribute('type') || null,
      role: element.getAttribute('role') || null,
      placeholder: element.getAttribute('placeholder') || null,
      ariaLabel: element.getAttribute('aria-label') || null,
      text,
      classes: filterStableClasses(element.classList),
      attributes,
      isPassword,
      isCheckbox,
      ...(checked !== null ? { checked } : {}),
      dimensions
    };
  }

  /**
   * Generate a human-friendly, simple name for an element (e.g. "Invoice Button", "Search Field")
   * Works both with live DOM elements and pure fingerprint/target objects.
   */
  function generateFriendlyName(element, fingerprint) {
    const fp = fingerprint || (element && element.nodeType === 1 ? createFingerprint(element) : null) || {};
    const tag = (fp.tagName || (element?.tagName ? element.tagName.toLowerCase() : '') || 'element').toLowerCase();

    // 1. Determine element type suffix
    const hasClass = (cls) => hasElementClass(element, cls);
    const isButton = ['button', 'submit'].includes(fp.type) || tag === 'button' || fp.role === 'button' ||
      hasClass('btn') || hasClass('x-btn') || hasClass('dxbButton');
    const isLink = tag === 'a' || fp.role === 'link';
    const isCheckbox = fp.isCheckbox === true || fp.type === 'checkbox' || fp.role === 'checkbox' || tag === 'mat-pseudo-checkbox';
    const isRadio = fp.type === 'radio' || fp.role === 'radio';
    const isOption = tag === 'mat-option' || tag === 'option' || fp.role === 'option';
    const isSelect = tag === 'select' || tag === 'mat-select' || fp.role === 'combobox' || fp.role === 'listbox';
    const isTab = fp.role === 'tab';
    const isRow = tag === 'tr' || fp.role === 'row';
    const isCell = tag === 'td' || tag === 'th' || fp.role === 'gridcell';
    const isCanvas = tag === 'canvas';
    const isInput = tag === 'input' || tag === 'textarea';

    let typeSuffix = 'Element';
    if (isButton) typeSuffix = 'Button';
    else if (isCheckbox) typeSuffix = 'Checkbox';
    else if (isRadio) typeSuffix = 'Radio Option';
    else if (isOption) typeSuffix = 'Option';
    else if (isSelect) typeSuffix = 'Dropdown';
    else if (isLink) typeSuffix = 'Link';
    else if (isTab) typeSuffix = 'Tab';
    else if (isRow) typeSuffix = 'Row';
    else if (isCell) typeSuffix = 'Cell';
    else if (isCanvas) typeSuffix = 'Canvas Area';
    else if (isInput) {
      if (fp.type === 'password') typeSuffix = 'Password Field';
      else if (fp.type === 'search') typeSuffix = 'Search Field';
      else if (fp.type === 'email') typeSuffix = 'Email Field';
      else typeSuffix = 'Input';
    }

    // 2. Discover best descriptive text
    let label = '';

    // Check associated <label> or mat-label
    if (element && element.nodeType === 1) {
      if (element.labels && element.labels.length > 0 && element.labels[0].textContent) {
        label = normalizeText(element.labels[0].textContent);
      } else {
        const formField = element.closest && element.closest('mat-form-field, .form-group, .form-field, label');
        if (formField) {
          const lbl = formField.querySelector('mat-label, label, .mat-form-field-label');
          if (lbl && lbl !== element) {
            label = normalizeText(lbl.textContent);
          }
        }
      }
    }

    // Check ARIA label
    if (!label && fp.ariaLabel) {
      label = normalizeText(fp.ariaLabel);
    }

    // Check title attribute (standard for icons, toolbars, and export buttons)
    if (!label && fp.attributes && fp.attributes.title) {
      label = normalizeText(fp.attributes.title);
    }

    // Check placeholder
    if (!label && fp.placeholder) {
      label = normalizeText(fp.placeholder);
    }

    // Check visible text content
    if (!label && fp.text) {
      label = normalizeText(fp.text);
    }

    // Check value attribute (e.g. for input buttons like Run Report / Export to Excel)
    if (!label && (fp.attributes?.value || (element && element.value))) {
      const val = normalizeText(fp.attributes?.value || element?.value || '');
      if (val && !['true', 'false', 'on', 'off'].includes(val.toLowerCase()) && !/^\d+$/.test(val)) {
        label = val;
      }
    }

    // Check parent interactive container text if element is an icon or span
    if (!label && element && element.closest) {
      const interactiveParent = element.closest('button, a, [role="button"], mat-option, label, [title]');
      if (interactiveParent && interactiveParent !== element) {
        label = normalizeText(interactiveParent.getAttribute('title') || interactiveParent.getAttribute('aria-label') || interactiveParent.textContent || '');
      }
    }

    // Check name attribute if descriptive (e.g. customer_name -> Customer Name)
    if (!label && fp.name) {
      const cleanName = fp.name.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
      if (cleanName && cleanName.length >= 2 && !/^\d+$/.test(cleanName)) {
        label = cleanName;
      }
    }

    // Check stable ID or testid if descriptive
    if (!label) {
      const testId = (fp.attributes && (fp.attributes['data-testid'] || fp.attributes['data-qa'] || fp.attributes['data-cy'])) || fp.id;
      if (testId && typeof testId === 'string' && !CONSTANTS.UNSTABLE_ID_PATTERN.test(testId)) {
        const words = testId.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b(btn|button|input|txt|lbl|field)\b/gi, '').trim();
        if (words && words.length >= 2) {
          label = words;
        }
      }
    }

    // Clean up label
    if (label) {
      label = label.replace(/[.*:…\-]+$/g, '').trim();
      if (label.length > 40) {
        label = label.slice(0, 37).trim() + '…';
      }
      if (label && /^[a-z]/.test(label)) {
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }
    }

    // Combine label + typeSuffix
    if (!label) {
      return typeSuffix === 'Element' ? 'Page Element' : typeSuffix;
    }

    const lowerLabel = label.toLowerCase();
    let lowerSuffix = typeSuffix.toLowerCase();

    if (lowerSuffix === 'search field' && lowerLabel.includes('search')) {
      typeSuffix = 'Field';
      lowerSuffix = 'field';
    }

    if (lowerLabel.endsWith(lowerSuffix) || (lowerSuffix === 'button' && lowerLabel.endsWith('btn')) || (lowerSuffix === 'field' && lowerLabel.endsWith('input'))) {
      return label;
    }

    return `${label} ${typeSuffix}`;
  }

  /**
   * Capture target: generates candidates, semantic fingerprint, and human-friendly name
   */
  function captureTarget(element, doc) {
    const candidates = generateCandidates(element, doc);
    const fingerprint = createFingerprint(element);
    const friendlyName = generateFriendlyName(element, fingerprint);
    return {
      candidates,
      fingerprint,
      friendlyName,
      elementName: friendlyName,
      isCheckbox: Boolean(fingerprint.isCheckbox),
      ...(fingerprint.checked !== undefined ? { checked: fingerprint.checked } : {})
    };
  }

  /**
   * Score candidate element against recorded fingerprint [0.0 - 1.0]
   */
  function scoreFingerprint(element, fingerprint) {
    if (!element) {
      return { score: 0, matchedTag: false, passed: false };
    }
    if (!fingerprint || !fingerprint.tagName || fingerprint.isSynthetic) {
      return { score: 1.0, matchedTag: true, passed: true };
    }

    const elemTag = element.tagName.toLowerCase();
    const targetTag = (fingerprint.tagName || '').toLowerCase();

    // Check if element and fingerprint represent the same option control
    const isOptionControl = (
      (elemTag === 'mat-option' || (element.getAttribute && element.getAttribute('role') === 'option')) &&
      ['mat-pseudo-checkbox', 'span', 'div'].includes(targetTag)
    ) || (
      (targetTag === 'mat-option' || fingerprint.role === 'option') &&
      ['mat-pseudo-checkbox', 'span', 'div'].includes(elemTag)
    );

    const tagMatchesExact = elemTag === targetTag;
    let tagCompatible = tagMatchesExact || isOptionControl;

    if (!tagCompatible) {
      // Buttons & Interactive controls compatibility
      const interactiveTags = ['button', 'a', 'input'];
      const isElemInteractive = interactiveTags.includes(elemTag) ||
        (element.getAttribute && ['button', 'link'].includes(element.getAttribute('role')));
      const isTargetInteractive = interactiveTags.includes(targetTag) ||
        ['button', 'link'].includes(fingerprint.role);

      const innerLeafTags = ['svg', 'path', 'i', 'span', 'img'];

      if ((isElemInteractive && innerLeafTags.includes(targetTag)) ||
          (isTargetInteractive && innerLeafTags.includes(elemTag)) ||
          (isElemInteractive && isTargetInteractive)) {
        tagCompatible = true;
      }

      // Combobox / Dropdown compatibility
      const isElemCombobox = elemTag === 'mat-select' || (element.getAttribute && element.getAttribute('role') === 'combobox');
      const isTargetCombobox = targetTag === 'mat-select' || fingerprint.role === 'combobox';
      if ((isElemCombobox && (innerLeafTags.includes(targetTag) || targetTag === 'div')) ||
          (isTargetCombobox && (innerLeafTags.includes(elemTag) || elemTag === 'div'))) {
        tagCompatible = true;
      }
    }

    // Mandatory: tag name MUST match or be compatible
    if (!tagCompatible) {
      return { score: 0, matchedTag: false, passed: false };
    }

    let score = 0;
    const weights = CONSTANTS.RESOLVER_WEIGHTS;

    // 1. ID or Name match (weight: 0.30)
    let idNameScore = 0;
    const elemId = element.id;
    const targetId = fingerprint.id;
    const elemName = element.getAttribute ? element.getAttribute('name') : null;
    const targetName = fingerprint.name;

    if (targetId && elemId && targetId === elemId) {
      idNameScore = 1.0;
    } else if (targetName && elemName && targetName === elemName) {
      idNameScore = 0.9;
    } else if (!isStableId(targetId) || (!targetId && !targetName)) {
      // Element originally had an unstable or missing ID/name, neutral full score
      idNameScore = 1.0;
    }
    score += idNameScore * weights.ID_OR_NAME;

    // 2. Data attributes or Aria (weight: 0.25)
    let dataAriaScore = 0;
    const targetAria = fingerprint.ariaLabel;
    const elemAria = element.getAttribute ? element.getAttribute('aria-label') : null;
    if (targetAria) {
      dataAriaScore = (elemAria && targetAria === elemAria) ? 1.0 : 0.0;
    } else {
      // Check data attributes
      let matchedDataCount = 0;
      let totalDataCount = 0;
      for (const attr of CONSTANTS.PREFERRED_DATA_ATTRIBUTES) {
        const targetVal = fingerprint.attributes ? fingerprint.attributes[attr] : null;
        if (targetVal) {
          totalDataCount++;
          if (element.getAttribute && element.getAttribute(attr) === targetVal) {
            matchedDataCount++;
          }
        }
      }
      dataAriaScore = totalDataCount > 0 ? (matchedDataCount / totalDataCount) : 1.0;
    }
    score += dataAriaScore * weights.DATA_OR_ARIA;

    // 3. Visible Text (weight: 0.25)
    let textScore = 0;
    const targetText = normalizeText(fingerprint.text || fingerprint.attributes?.value || '');
    const elemText = normalizeText((element.value !== undefined && element.value !== null ? element.value : '') || element.textContent || '');

    const isCheckboxElement = Boolean(
      fingerprint.isCheckbox ||
      fingerprint.type === 'checkbox' ||
      fingerprint.role === 'checkbox' ||
      (element.tagName === 'INPUT' && (element.type || '').toLowerCase() === 'checkbox') ||
      (element.getAttribute && element.getAttribute('role') === 'checkbox')
    );

    if (!targetText || isCheckboxElement) {
      // Checkboxes do not have their own text nodes; row text from recording must not penalize different records
      textScore = 1.0;
    } else if (targetText === elemText) {
      textScore = 1.0;
    } else if (elemText.includes(targetText) || targetText.includes(elemText)) {
      textScore = 0.85;
    } else {
      // Check normalized token overlap (resilient to whitespace differences)
      const targetTokens = targetText.split(' ').filter(t => t.length > 2);
      const matchedTokens = targetTokens.filter(t => elemText.includes(t));
      if (targetTokens.length > 0 && matchedTokens.length / targetTokens.length >= 0.6) {
        textScore = 0.80;
      } else {
        textScore = 0.0;
      }
    }
    score += textScore * weights.VISIBLE_TEXT;

    // 4. Other Attributes (type, role, placeholder) (weight: 0.10)
    let attrScore = 0;
    let attrChecks = 0;
    ['type', 'role', 'placeholder'].forEach(attr => {
      const targetVal = fingerprint[attr];
      if (targetVal) {
        attrChecks++;
        if (element.getAttribute(attr) === targetVal) {
          attrScore += 1;
        }
      }
    });
    const finalAttrScore = attrChecks > 0 ? (attrScore / attrChecks) : 1.0;
    score += finalAttrScore * weights.OTHER_ATTRS;

    // 5. Classes Jaccard Similarity (weight: 0.10)
    let classScore = 0;
    const targetClasses = new Set(fingerprint.classes || []);
    const elemClasses = new Set(filterStableClasses(element.classList));

    if (targetClasses.size === 0 && elemClasses.size === 0) {
      classScore = 1.0;
    } else {
      const intersection = new Set([...targetClasses].filter(x => elemClasses.has(x)));
      const union = new Set([...targetClasses, ...elemClasses]);
      classScore = union.size > 0 ? (intersection.size / union.size) : 1.0;
    }
    score += classScore * weights.CLASSES;

    if (!tagMatchesExact) {
      score *= 0.95;
    }

    // Strict action element text mismatch penalty:
    // If an action element (button, link, menu item, or inner span/icon) has an explicit recorded text label (e.g. "Close", "Save"),
    // an element with completely conflicting text (e.g. "Archive") must not be accepted under any circumstances!
    const isActionOrInteractive = Boolean(
      elemTag === 'button' ||
      elemTag === 'a' ||
      targetTag === 'button' ||
      targetTag === 'a' ||
      (element.getAttribute && (element.getAttribute('role') === 'button' || element.getAttribute('role') === 'menuitem' || element.getAttribute('role') === 'tab')) ||
      (fingerprint.role === 'button' || fingerprint.role === 'menuitem' || fingerprint.role === 'tab') ||
      hasElementClass(element, 'x-btn') ||
      hasElementClass(element, 'x-btn-inner') ||
      hasElementClass(element, 'btn') ||
      (typeof element.closest === 'function' && element.closest('button, a, [role="button"], [role="menuitem"], .x-btn, .btn')) ||
      /^(close|save|archive|submit|export|download|cancel|ok|yes|no|delete|search|filter|print|run|open|edit|view|add|refresh)$/i.test(targetText)
    );
    if (isActionOrInteractive && targetText && elemText && targetText.length >= 2 && elemText.length >= 2 && textScore === 0.0) {
      score *= 0.10; // Drastically reduce score (e.g. 0.73 -> 0.07) so conflicting button text is completely rejected
    }

    const roundedScore = Math.round(score * 100) / 100;
    const passed = roundedScore >= CONSTANTS.MIN_CONFIDENCE_THRESHOLD;

    return {
      score: roundedScore,
      matchedTag: true,
      passed
    };
  }

  /**
   * Find the topmost visible active dialog / modal / window / overlay in the document.
   * Supports standard HTML5 dialogs, ARIA dialogs, ExtJS windows, Bootstrap modals,
   * Angular CDK overlays, and generic fixed/absolute high z-index containers.
   */
  function getTopmostActiveModal(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof d.querySelectorAll !== 'function') return null;

    const modalSelectors = [
      '[role="dialog"]:not([aria-hidden="true"])',
      '[role="alertdialog"]:not([aria-hidden="true"])',
      'dialog[open]',
      '[aria-modal="true"]',
      '.modal.show',
      '.modal.in',
      '.modal:not([aria-hidden="true"])',
      '.overlay',
      '.x-window:not(.x-hidden):not(.x-hidden-offsets)',
      '.cdk-overlay-pane:not([aria-hidden="true"])',
      '.mat-mdc-dialog-container',
      '.ant-modal:not(.ant-modal-hidden)'
    ];

    try {
      const candidates = Array.from(d.querySelectorAll(modalSelectors.join(', '))).filter(el => {
        if (!isElementVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 40 && rect.height > 40;
      });

      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];

      candidates.sort((a, b) => {
        const getZ = (elem) => {
          const cs = (typeof window !== 'undefined' && window.getComputedStyle)
            ? window.getComputedStyle(elem)
            : (typeof getComputedStyle === 'function' ? getComputedStyle(elem) : null);
          const z = cs ? cs.zIndex : 0;
          const parsed = parseInt(z, 10);
          return isNaN(parsed) ? 0 : parsed;
        };
        const za = getZ(a);
        const zb = getZ(b);
        if (za !== zb) return zb - za;
        if (typeof a.compareDocumentPosition === 'function') {
          const followingMask = typeof Node !== 'undefined' ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
          return (a.compareDocumentPosition(b) & followingMask) ? -1 : 1;
        }
        return 0;
      });

      return candidates[0];
    } catch {
      return null;
    }
  }

  /**
   * Resolve an element target using candidate priority and weighted fingerprint scoring
   */
  function resolveElement(target, options, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!target) {
      return {
        element: null,
        resolvedCandidate: null,
        confidenceScore: 0,
        success: false,
        attempts: [{ error: 'Invalid target object: target is required' }]
      };
    }

    // Auto-normalize target if passed as a string, flat array of candidate strings, or missing fingerprint
    let normalizedTarget = target;
    if (typeof target === 'string') {
      const trimmed = target.trim();
      const isXpath = trimmed.startsWith('//') || trimmed.startsWith('(') || trimmed.startsWith('/html');
      normalizedTarget = {
        candidates: [{
          strategy: isXpath ? CONSTANTS.SELECTOR_STRATEGIES.XPATH : CONSTANTS.SELECTOR_STRATEGIES.CSS_PATH,
          value: trimmed,
          priority: 1,
          uniqueness: 1
        }],
        fingerprint: { tagName: null, isSynthetic: true }
      };
    } else if (target && typeof target === 'object') {
      let rawCandidates = target.candidates;
      if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
        if (typeof target.selector === 'string' && target.selector.trim()) {
          rawCandidates = [target.selector.trim()];
        } else if (typeof target.target === 'string' && target.target.trim()) {
          rawCandidates = [target.target.trim()];
        }
      }

      if (Array.isArray(rawCandidates) && rawCandidates.length > 0) {
        const normalizedCandidates = rawCandidates.map((c, idx) => {
          if (typeof c === 'string') {
            const trimmed = c.trim();
            const isXpath = trimmed.startsWith('//') || trimmed.startsWith('(') || trimmed.startsWith('/html');
            return {
              strategy: isXpath ? CONSTANTS.SELECTOR_STRATEGIES.XPATH : CONSTANTS.SELECTOR_STRATEGIES.CSS_PATH,
              value: trimmed,
              priority: idx + 1,
              uniqueness: 1
            };
          }
          return c;
        });

        normalizedTarget = {
          ...target,
          candidates: normalizedCandidates,
          fingerprint: (target.fingerprint && target.fingerprint.tagName) ? target.fingerprint : { tagName: null, isSynthetic: true }
        };
      }
    }

    target = normalizedTarget;

    if (!target || !target.candidates || target.candidates.length === 0) {
      return {
        element: null,
        resolvedCandidate: null,
        confidenceScore: 0,
        success: false,
        attempts: [{ error: 'Invalid target object: candidates are required' }]
      };
    }

    const minScore = (options && typeof options.minScore === 'number')
      ? options.minScore
      : CONSTANTS.MIN_CONFIDENCE_THRESHOLD;

    const topModal = (options && options.activeModal) || getTopmostActiveModal(d);
    const attempts = [];

    // Evaluate candidates in ranked order
    for (const candidate of target.candidates) {
      const isXpath = candidate.strategy === CONSTANTS.SELECTOR_STRATEGIES.XPATH ||
        candidate.value.startsWith('//') || candidate.value.startsWith('(');

      let matchedNodes = [];
      try {
        matchedNodes = isXpath ? queryXPath(candidate.value, d) : queryAll(candidate.value, d);
      } catch (err) {
        attempts.push({
          candidate,
          matchCount: 0,
          score: 0,
          reason: `Syntax or execution error: ${err.message}`
        });
        continue;
      }

      if (matchedNodes.length === 0 && candidate.value) {
        // Table cell / column relaxation:
        // If candidate contains a specific column index (td:nth-of-type(N) or td[N]),
        // table columns often shift dynamically when optional fields are present across records.
        const isTableCol = /td:nth-of-type\(\d+\)|td\[\d+\]/i.test(candidate.value);
        if (isTableCol) {
          const relaxedValue = candidate.value
            .replace(/td:nth-of-type\(\d+\)/gi, 'td')
            .replace(/td\[\d+\]/gi, 'td');
          try {
            const relaxedMatches = isXpath ? queryXPath(relaxedValue, d) : queryAll(relaxedValue, d);
            if (relaxedMatches.length > 0) {
              matchedNodes = relaxedMatches;
            }
          } catch {}
        }

        // If still 0 matches and target is a table checkbox, find checkboxes in table rows
        if (matchedNodes.length === 0 && (target.isCheckbox || target.fingerprint?.isCheckbox || target.fingerprint?.type === 'checkbox')) {
          const isTableTarget = /table|tbody|tr|td/i.test(candidate.value);
          if (isTableTarget) {
            try {
              const tableCbs = queryAll('table tbody tr td input[type="checkbox"], table tbody tr input[type="checkbox"], [role="row"] [role="checkbox"]', d);
              if (tableCbs.length > 0) {
                matchedNodes = tableCbs;
              }
            } catch {}
          }
        }
      }

      if (matchedNodes.length === 0) {
        attempts.push({
          candidate,
          matchCount: 0,
          score: 0,
          reason: 'No elements matched selector'
        });
        continue;
      }

      const requireVisible = !options || options.requireVisible !== false;

      // When multiple nodes match and an active modal exists:
      // Prioritize matches that are inside the topmost active modal
      if (matchedNodes.length > 1 && topModal) {
        const inModalNodes = matchedNodes.filter(n => topModal.contains(n));
        if (inModalNodes.length === 1) {
          const candidateElem = inModalNodes[0];
          const { score, passed } = scoreFingerprint(candidateElem, target.fingerprint);
          if (passed && score >= minScore) {
            if (!requireVisible || isElementVisible(candidateElem)) {
              return {
                element: candidateElem,
                resolvedCandidate: candidate,
                confidenceScore: score,
                success: true,
                attempts
              };
            }
          }
        } else if (inModalNodes.length > 1) {
          // Disambiguate among nodes within the top modal
          let bestInModal = null;
          let highestInModalScore = 0;
          let inModalPassing = 0;
          for (const elem of inModalNodes) {
            const { score, passed } = scoreFingerprint(elem, target.fingerprint);
            if (passed && score >= 0.85) {
              if (!requireVisible || isElementVisible(elem)) {
                inModalPassing++;
                if (score > highestInModalScore) {
                  highestInModalScore = score;
                  bestInModal = elem;
                }
              }
            }
          }
          if (inModalPassing === 1 && bestInModal) {
            return {
              element: bestInModal,
              resolvedCandidate: candidate,
              confidenceScore: highestInModalScore,
              success: true,
              attempts
            };
          }
        }
      }

      // Case 1: Exactly one element matched
      if (matchedNodes.length === 1) {
        const candidateElem = matchedNodes[0];
        const { score, passed } = scoreFingerprint(candidateElem, target.fingerprint);

        if (passed && score >= minScore) {
          if (requireVisible && !isElementVisible(candidateElem)) {
            attempts.push({
              candidate,
              matchCount: 1,
              score,
              reason: 'Element matched but is not yet visible in DOM (0 dimensions or display:none)'
            });
            continue;
          }

          return {
            element: candidateElem,
            resolvedCandidate: candidate,
            confidenceScore: score,
            success: true,
            attempts
          };
        }

        attempts.push({
          candidate,
          matchCount: 1,
          score,
          reason: `Single element matched but fingerprint confidence score (${score}) fell below threshold (${minScore})`
        });
        continue;
      }

      // Case 2: Multiple elements matched - score all of them and disambiguate
      const scoredPassing = [];

      for (const elem of matchedNodes) {
        const { score, passed } = scoreFingerprint(elem, target.fingerprint);
        if (passed && score >= 0.85) {
          if (!requireVisible || isElementVisible(elem)) {
            const insideModal = Boolean(topModal && topModal.contains(elem));
            let z = 0;
            if (typeof window !== 'undefined') {
              const modalParent = (typeof elem.closest === 'function')
                ? elem.closest('.x-window, [role="dialog"], .modal, .cdk-overlay-pane')
                : null;
              const zStr = window.getComputedStyle(modalParent || elem).zIndex;
              z = parseInt(zStr, 10) || 0;
            }
            scoredPassing.push({ elem, score, insideModal, z });
          }
        }
      }

      // If exactly ONE element scored highly (>= 0.85), resolve it
      if (scoredPassing.length === 1) {
        return {
          element: scoredPassing[0].elem,
          resolvedCandidate: candidate,
          confidenceScore: scoredPassing[0].score,
          success: true,
          attempts
        };
      }

      // If multiple passed, disambiguate by modal containment, z-index, and score
      if (scoredPassing.length > 1) {
        scoredPassing.sort((a, b) => {
          if (a.insideModal !== b.insideModal) return a.insideModal ? -1 : 1;
          if (a.z !== b.z) return b.z - a.z;
          return b.score - a.score;
        });

        const topRanked = scoredPassing[0];
        const runnerUp = scoredPassing[1];

        if ((topRanked.insideModal && !runnerUp.insideModal) || topRanked.z > runnerUp.z || topRanked.score > runnerUp.score) {
          return {
            element: topRanked.elem,
            resolvedCandidate: candidate,
            confidenceScore: topRanked.score,
            success: true,
            attempts
          };
        }
      }

      attempts.push({
        candidate,
        matchCount: matchedNodes.length,
        score: scoredPassing.length ? scoredPassing[0].score : 0,
        reason: `Ambiguous match: ${matchedNodes.length} elements matched selector and ${scoredPassing.length} passed fingerprint validation`
      });
    }

    // Heuristic Fallback: If all candidates failed, attempt Semantic Fingerprint Recovery
    const fingerprint = target.fingerprint;
    const requireVisible = !options || options.requireVisible !== false;

    if (fingerprint && fingerprint.tagName && fingerprint.tagName !== 'unknown') {
      const tag = fingerprint.tagName.toLowerCase();
      let fallbackNodes = [];

      // 1. Try finding elements by visible text or value if text was captured
      const targetText = normalizeText(fingerprint.text || fingerprint.attributes?.value || '');
      if (targetText && targetText.length > 0) {
        const xpTarget = toXPathString(targetText);
        try {
          fallbackNodes = queryXPath(`//${tag}[normalize-space()=${xpTarget}]`, d);
        } catch {}

        if (fallbackNodes.length === 0 && tag === 'input') {
          try {
            fallbackNodes = queryXPath(`//input[@value=${xpTarget}]`, d);
          } catch {}
        }

        if (fallbackNodes.length === 0 && targetText.length > 2) {
          try {
            fallbackNodes = queryXPath(`//${tag}[contains(normalize-space(), ${xpTarget})]`, d);
          } catch {}
        }

        // Generic interactive fallback query across buttons, links, inputs, options
        if (fallbackNodes.length === 0 && targetText.length > 0) {
          try {
            fallbackNodes = queryXPath(
              `//*[(self::button or self::a or self::input or @role='button' or self::mat-option or @role='option') and (normalize-space()=${xpTarget} or @value=${xpTarget} or contains(normalize-space(), ${xpTarget}))]`,
              d
            );
          } catch {}
        }
      }

      // 2. If no text match, try stable classes or backdrop selector
      if (fallbackNodes.length === 0 && Array.isArray(fingerprint.classes) && fingerprint.classes.length > 0) {
        if (fingerprint.classes.some(c => c && c.includes('backdrop'))) {
          try {
            fallbackNodes = queryAll('.cdk-overlay-backdrop, [class*="backdrop"]', d);
          } catch {}
        }
        if (fallbackNodes.length === 0) {
          try {
            const classSelector = `${tag}.${fingerprint.classes.map(c => escapeCss(c)).join('.')}`;
            fallbackNodes = queryAll(classSelector, d);
          } catch {}
        }
      }

      // 3. Score fallback candidate elements against fingerprint
      const scoredFallbackPassing = [];
      for (const elem of fallbackNodes) {
        const { score, passed } = scoreFingerprint(elem, fingerprint);
        if (passed && score >= minScore) {
          if (!requireVisible || isElementVisible(elem)) {
            const insideModal = Boolean(topModal && topModal.contains(elem));
            let z = 0;
            if (typeof window !== 'undefined') {
              const modalParent = (typeof elem.closest === 'function')
                ? elem.closest('.x-window, [role="dialog"], .modal, .cdk-overlay-pane')
                : null;
              const zStr = window.getComputedStyle(modalParent || elem).zIndex;
              z = parseInt(zStr, 10) || 0;
            }
            scoredFallbackPassing.push({ elem, score, insideModal, z });
          }
        }
      }

      if (scoredFallbackPassing.length === 1) {
        return {
          element: scoredFallbackPassing[0].elem,
          resolvedCandidate: {
            strategy: 'fingerprint-fallback',
            value: targetText ? `fallback:text="${targetText}"` : `fallback:tag=${tag}`,
            uniqueness: 1,
            priority: 99
          },
          confidenceScore: scoredFallbackPassing[0].score,
          success: true,
          attempts
        };
      }

      if (scoredFallbackPassing.length > 1) {
        scoredFallbackPassing.sort((a, b) => {
          if (a.insideModal !== b.insideModal) return a.insideModal ? -1 : 1;
          if (a.z !== b.z) return b.z - a.z;
          return b.score - a.score;
        });
        const topFallback = scoredFallbackPassing[0];
        return {
          element: topFallback.elem,
          resolvedCandidate: {
            strategy: 'fingerprint-fallback',
            value: targetText ? `fallback:text="${targetText}"` : `fallback:tag=${tag}`,
            uniqueness: scoredFallbackPassing.length,
            priority: 99
          },
          confidenceScore: topFallback.score,
          success: true,
          attempts
        };
      }
    }

    return {
      element: null,
      resolvedCandidate: null,
      confidenceScore: 0,
      success: false,
      attempts
    };
  }

  return {
    CONSTANTS,
    escapeCss,
    isStableId,
    filterStableClasses,
    normalizeText,
    isElementVisible,
    isElementInteractable,
    generateCssPath,
    generateXPath,
    generateCandidates,
    createFingerprint,
    generateFriendlyName,
    captureTarget,
    scoreFingerprint,
    getTopmostActiveModal,
    resolveElement
  };
});
