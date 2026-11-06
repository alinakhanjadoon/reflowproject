/**
 * ReFlow — Recorded Action Generalizer
 *
 * Converts a recorder target that points at one concrete collection item into
 * an item-relative target that can be replayed for every discovered item.
 */

class ActionGeneralizer {
  static _normalizeTarget(target) {
    if (typeof target === 'string') {
      return {
        selectors: { cssPath: target },
        candidates: [{ strategy: 'css-path', value: target, priority: 5 }]
      };
    }
    if (!target || typeof target !== 'object') {
      throw new Error('Recorded target is required.');
    }
    return target;
  }

  static generalizeAction(action, collection) {
    if (!action || typeof action !== 'object') {
      throw new Error('ActionGeneralizer requires a recorded action.');
    }
    if (!collection || !collection.itemTag) {
      throw new Error('ActionGeneralizer requires discovered collection metadata.');
    }

    if (!this.isItemRelative(action, collection)) {
      return {
        ...action,
        scope: 'page'
      };
    }

    const target = action.target || action;
    const normalizedTarget = this._normalizeTarget(target);
    const generalizedTarget = this.generalizeTarget(normalizedTarget, collection);

    return {
      ...action,
      target: generalizedTarget,
      scope: 'item'
    };
  }

  static generalizeActions(actions, collection, anchorOffset = 0) {
    if (!Array.isArray(actions)) {
      throw new Error('ActionGeneralizer requires an action array.');
    }
    const safeAnchorOffset = typeof anchorOffset === 'number' && anchorOffset >= 0 && anchorOffset < actions.length ? anchorOffset : 0;
    const targetUrl = actions[safeAnchorOffset]?.url || actions[0]?.url;
    return actions.map((action, idx) => {
      // The anchor action in the loop partition is always the item-scoped trigger
      if (idx === safeAnchorOffset) {
        const target = action.target || action;
        const normalizedTarget = this._normalizeTarget(target);
        return {
          ...action,
          target: this.generalizeTarget(normalizedTarget, collection),
          scope: 'item'
        };
      }
      // If subsequent action is recorded on a distinct URL (e.g. details page), it is page-scoped
      if (action.url && targetUrl && action.url !== targetUrl) {
        return {
          ...action,
          scope: 'page'
        };
      }
      return this.generalizeAction(action, collection);
    });
  }

  static isItemRelative(action, collection) {
    if (!action || !collection || !collection.itemTag) return false;
    let target = action.target || action;
    if (typeof target === 'string') {
      target = { selectors: { cssPath: target }, candidates: [{ strategy: 'css-path', value: target }] };
    }

    // Explicit scope hints take precedence
    if (action.scope === 'item' || target.scope === 'item' || action.inRow === true || target.inRow === true) {
      return true;
    }
    if (action.scope === 'page' || target.scope === 'page') {
      return false;
    }

    // Exclude genuinely shared toolbar, navigation, and header chrome
    const fp = target.fingerprint || {};
    const fpRole = String(fp.role || '').toLowerCase();
    if (['toolbar', 'navigation', 'banner', 'menubar'].includes(fpRole)) {
      return false;
    }
    const fpClasses = Array.isArray(fp.classes) ? fp.classes.join(' ') : String(fp.classes || '');
    if (/\b(toolbar|top-bar|app-bar|site-header|navbar|pager|pagination)\b/i.test(fpClasses)) {
      return false;
    }

    const candidates = Array.isArray(target?.candidates) ? [...target.candidates] : [];
    const cssPath = target.selectors?.cssPath || target.cssPath || action.selectors?.cssPath || (typeof target === 'string' ? target : null);
    if (cssPath && !candidates.some(c => c && c.value === cssPath)) {
      candidates.push({ strategy: 'css-path', value: cssPath });
    }

    // If any candidate explicitly references a page toolbar or actions-bar, keep it page-scoped
    if (candidates.some(c => c?.value && /\b(toolbar|actions-bar|top-bar|navbar)\b/i.test(c.value))) {
      return false;
    }

    // Exclude table headers (thead, th): header checkboxes, header download buttons, and columnheader actions
    // are shared page-level controls, not inside individual data rows (tbody > tr).
    const fpParentTag = String(fp.parentTag || '').toLowerCase();
    const fpTag = String(fp.tagName || '').toLowerCase();
    if (fpTag === 'th' || fpParentTag === 'th' || fpParentTag === 'thead' || fpRole === 'columnheader') {
      return false;
    }
    if (candidates.some(c => c?.value && /\b(thead\b|th\b|th[:.\[\s]|role=["']columnheader["'])/i.test(c.value))) {
      return false;
    }

    const tag = String(collection.itemTag).toLowerCase();

    // Check if fingerprint directly matches the item or known child elements
    if (fpTag === tag) return true;
    if (tag === 'mat-option' && (fpTag === 'mat-pseudo-checkbox' || fp.role === 'option')) return true;
    if (tag === 'tr' && fpTag === 'td') return true;

    // Check parent tag evidence in fingerprint
    if (tag === 'tr' && (fpParentTag === 'td' || fpParentTag === 'tr')) {
      return true;
    }

    // Check enclosing row context from recorder sniffing
    if (action.context?.table?.activeRowValues || action.context?.activeRowValues || action.table?.activeRowValues) {
      return true;
    }

    // Check candidates for item-relative CSS paths or XPath ancestry
    for (const candidate of candidates) {
      if (!candidate || !candidate.value) continue;
      if (/\bthead\b|\bth\b|\[@role=['"]columnheader['"]\]/i.test(candidate.value)) continue;
      if (this.toRelativeCss(candidate.value, tag)) return true;
      if (this.toRelativeXPath(candidate.value, tag)) return true;
      const val = String(candidate.value).trim().toLowerCase();
      if (candidate.strategy === 'xpath' || val.startsWith('/') || val.startsWith('(')) {
        if ((val.includes(`//${tag}`) || val.includes(`/${tag}/`) || val.includes(`/${tag}[`)) && !val.includes('thead')) {
          return true;
        }
      }
    }

    // Check standalone ID selector with row/item index pattern (e.g. #download-btn-row-1)
    for (const candidate of candidates) {
      if (!candidate || !candidate.value) continue;
      const val = String(candidate.value).trim();
      if (/(?:^|[#._-])(?:row|item|record|tr|entry|card|col)[-_]?\d+/i.test(val)) {
        return true;
      }
    }
    if (fp.id && /(?:^|[#._-])(?:row|item|record|tr|entry|card)[-_]?\d+/i.test(fp.id)) {
      return true;
    }

    // In-record interactive elements (buttons, links, inputs, checkboxes)
    // inside the repeating range with parent cell or inRow context
    if (action.inRow) {
      return true;
    }

    return false;
  }

  static generalizeTarget(rawTarget, collection) {
    const target = this._normalizeTarget(rawTarget);

    const candidates = Array.isArray(target.candidates) ? [...target.candidates] : [];
    const cssPath = target.selectors?.cssPath || target.cssPath;
    if (cssPath && !candidates.some(c => c && c.value === cssPath)) {
      candidates.push({ strategy: 'css-path', value: cssPath, priority: 5 });
    }

    const generalizedCandidates = [];

    for (const candidate of candidates) {
      if (!candidate || !candidate.value) continue;

      const relative = this.toRelativeCss(candidate.value, collection.itemTag);
      if (relative) {
        generalizedCandidates.push({
          ...candidate,
          strategy: 'css-path',
          value: relative,
          uniqueness: undefined,
          priority: Math.max(Number(candidate.priority) || 0, 6),
          scope: 'item'
        });
        continue;
      }

      // Check relative XPath
      const relativeXp = this.toRelativeXPath(candidate.value, collection.itemTag);
      if (relativeXp) {
        generalizedCandidates.push({
          ...candidate,
          strategy: 'xpath',
          value: relativeXp,
          priority: Math.max(Number(candidate.priority) || 0, 6),
          scope: 'item'
        });
        continue;
      }

      // Generalize standalone ID selectors (e.g. #download-btn-row-1 -> [id*="download-btn"], or in-row #btn-dl)
      const val = String(candidate.value).trim();
      const idMatch = val.match(/^#([a-zA-Z0-9_-]+)/);
      if (idMatch) {
        const fullId = idMatch[1];
        const baseId = fullId.replace(/(?:[-_]?(?:row|item|record|tr))?[-_]?\d+.*$/i, '');
        if (baseId && baseId.length >= 3 && baseId !== fullId) {
          generalizedCandidates.push({
            strategy: 'css-path',
            value: `[id*="${baseId}"]`,
            priority: Math.max(Number(candidate.priority) || 0, 5),
            scope: 'item'
          });
        } else {
          generalizedCandidates.push({
            strategy: 'css-path',
            value: `[id="${fullId}"]`,
            priority: Math.max(Number(candidate.priority) || 0, 5),
            scope: 'item'
          });
        }
        continue;
      }
    }

    if (generalizedCandidates.length === 0) {
      // Check if target represents the item itself or lacks specific relative segment
      const fpTag = String(target.fingerprint?.tagName || '').toLowerCase();
      const colTag = String(collection.itemTag || '').toLowerCase();
      if (fpTag === colTag || !candidates.length || candidates.some(c => c.value && c.value.toLowerCase().includes(colTag))) {
        generalizedCandidates.push({
          strategy: 'relative-scope',
          value: ':scope',
          priority: 6,
          scope: 'item'
        });
      }
    }

    // For row checkboxes: add resilient fallback candidate within the item
    // in case column indices shifted (e.g. optional date columns)
    const isCb = Boolean(
      target.isCheckbox ||
      target.fingerprint?.isCheckbox ||
      target.fingerprint?.type === 'checkbox' ||
      target.fingerprint?.role === 'checkbox'
    );
    if (isCb && !generalizedCandidates.some(c => c.value === 'input[type="checkbox"]')) {
      generalizedCandidates.push({
        strategy: 'css-path',
        value: 'input[type="checkbox"], [role="checkbox"]',
        priority: 4,
        scope: 'item'
      });
    }

    return {
      ...target,
      candidates: generalizedCandidates,
      scope: 'item',
      collection: {
        itemTag: collection.itemTag,
        itemSignature: collection.itemSignature || null
      }
    };
  }

  /**
   * Converts an absolute XPath referencing a table row or card into an item-relative XPath.
   * Example: //table[@id="invoices"]//tr[1]//button[@title="Download"]
   * becomes: .//button[@title="Download"]
   */
  static toRelativeXPath(xpath, itemTag) {
    if (typeof xpath !== 'string' || !xpath.trim()) return null;
    if (/\/thead\b|\/th\b|\[@role=['"]columnheader['"]\]/i.test(xpath)) return null;
    const tag = String(itemTag || 'tr').toLowerCase().trim();
    if (!tag) return null;

    // Pattern: match /<tag>[...] or /<tag>/ and take everything after it
    const tagPattern = tag.replace(/[^a-z0-9_-]/gi, '');
    const regex = new RegExp(`/(?:${tagPattern}|\\[@role=['"](?:row|gridcell|listitem|option)['"]\\])(?:\\[[^\\]]*\\])?(/.*)$`, 'i');
    const match = xpath.match(regex);
    if (match && match[1]) {
      return '.' + match[1];
    }
    return null;
  }

  /**
   * Strip the collection-item prefix from a recorder CSS path.
   * Example: table#invoices tbody > tr:nth-child(1) > td:nth-child(5) > a.btn-download
   * becomes: td:nth-child(5) > a.btn-download
   */
  static toRelativeCss(cssPath, itemTag) {
    if (typeof cssPath !== 'string' || !cssPath.trim()) return null;
    if (/\bthead\b|\bth\b/i.test(cssPath)) return null;

    const rawTag = String(itemTag || '').toLowerCase().trim();
    if (!rawTag) return null;

    const cleanTag = rawTag.replace(/:(?:nth-child|nth-of-type)\([^)]*\)/gi, '').trim();
    const tagBase = cleanTag.match(/^([a-z][a-z0-9-]*)/i)?.[1] || '';
    const extractClasses = (s) => (s.match(/\.[a-z0-9_-]+/gi) || []).map(c => c.slice(1).toLowerCase());
    const tagClassList = extractClasses(cleanTag);

    const isSegmentMatch = (seg) => {
      if (!seg) return false;
      const cleanSeg = seg.replace(/:(?:nth-child|nth-of-type)\([^)]*\)/gi, '').trim().toLowerCase();
      if (cleanSeg === cleanTag) return true;
      const segClasses = extractClasses(cleanSeg);
      const segTag = cleanSeg.match(/^([a-z][a-z0-9-]*)/i)?.[1] || '';

      if (tagBase && segTag === tagBase) {
        if (tagClassList.length > 0) {
          return tagClassList.every(cls => segClasses.includes(cls));
        }
        return cleanSeg === tagBase || cleanSeg.startsWith(`${tagBase}:`) || cleanSeg.startsWith(`${tagBase}[`);
      }
      if (tagClassList.length > 0 && tagClassList.every(cls => segClasses.includes(cls))) {
        return true;
      }
      return false;
    };

    const cleanPath = cssPath.trim();

    // Check if path splits by '>'
    const segments = cleanPath
      .split(/\s*>\s*/)
      .map(segment => segment.trim())
      .filter(Boolean);

    let itemIndex = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (isSegmentMatch(segments[i])) {
        itemIndex = i;
        break;
      }
    }

    if (itemIndex >= 0) {
      const remainder = segments.slice(itemIndex + 1);
      return remainder.length ? remainder.join(' > ') : ':scope';
    }

    // Check if path uses descendant spaces: "table.data-table tr td a"
    const spaceTokens = cleanPath.split(/\s+/);
    let tokenIdx = -1;
    for (let i = spaceTokens.length - 1; i >= 0; i--) {
      if (isSegmentMatch(spaceTokens[i])) {
        tokenIdx = i;
        break;
      }
    }

    if (tokenIdx >= 0) {
      const remainder = spaceTokens.slice(tokenIdx + 1);
      return remainder.length ? remainder.join(' ') : ':scope';
    }

    return null;
  }

  static isGeneralized(action) {
    return Boolean(action && action.scope === 'item' && action.target?.scope === 'item');
  }

  /**
   * Classify action safety and destructive potential (Part 28: Security / Safety).
   *
   * @param {object} action
   * @returns {{ category: string, isDestructive: boolean, requiresConfirmation: boolean }}
   */
  static classifySafety(action) {
    if (!action) return { category: 'read', isDestructive: false, requiresConfirmation: false };
    const type = (action.type || action.action || '').toUpperCase();
    const text = (action.target?.fingerprint?.text || action.text || action.target?.fingerprint?.title || '').toLowerCase();

    if (/\b(delete|remove|erase|destroy|drop|terminate)\b/i.test(text)) {
      return { category: 'delete', isDestructive: true, requiresConfirmation: true };
    }
    if (/\b(pay|purchase|buy|checkout|charge|transfer)\b/i.test(text)) {
      return { category: 'purchase', isDestructive: true, requiresConfirmation: true };
    }
    if (/\b(submit|send|publish|post)\b/i.test(text)) {
      return { category: 'submit', isDestructive: false, requiresConfirmation: false };
    }
    if (/\b(download|export|save|print)\b/i.test(text) || action.isDownload) {
      return { category: 'download', isDestructive: false, requiresConfirmation: false };
    }
    if (type === 'TYPE' || type === 'SELECT') {
      return { category: 'edit', isDestructive: false, requiresConfirmation: false };
    }
    if (type === 'NAVIGATE') {
      return { category: 'navigate', isDestructive: false, requiresConfirmation: false };
    }
    return { category: 'read', isDestructive: false, requiresConfirmation: false };
  }
}

module.exports = ActionGeneralizer;
