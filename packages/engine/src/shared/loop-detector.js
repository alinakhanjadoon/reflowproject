/**
 * ReFlow — Intelligent Loop & Repeating Pattern Detector
 * 
 * Inspects recorded element fingerprints, tag hierarchies, ARIA roles, and CSS selector paths
 * to detect if an action was performed on a repeating collection item (e.g. table row <tr>,
 * list item <li>, repeating card item, or grid element). Generalizes single element targets into
 * iterative loop execution blueprints with multi-signal confidence evaluation.
 */

'use strict';

const LoopConfidenceEngine = require('./loop-confidence-engine');

class LoopDetector {
  /**
   * Analyzes an action step or element fingerprint for loop generalization candidacy.
   * @param {object} step - The recorded action step with fingerprint metadata
   * @returns {object} Analysis result with isLoopCandidate, containerSelector, and itemSelector
   */
  static analyzeStep(step) {
    if (!step) return { isLoopCandidate: false, role: 'SETUP' };

    const fingerprint = step.fingerprint || step.target?.fingerprint || step.target || {};
    const selectors = fingerprint.selectors || step.selectors || step.target?.selectors || {};
    let cssPath = selectors.cssPath || selectors.hierarchical || '';

    if (!cssPath && step.target && Array.isArray(step.target.candidates)) {
      const cssCand = step.target.candidates.find(c => c && c.strategy === 'css-path' && c.value);
      if (cssCand) cssPath = cssCand.value;
    }

    const tagName = (fingerprint.tagName || '').toLowerCase();
    const parentTag = (fingerprint.parentTag || '').toLowerCase();
    const role = (fingerprint.role || '').toLowerCase();

    // 0a. Exclude Navigation and Scroll actions (never a repeating data record anchor)
    const actionType = String(step.type || step.action || '').toUpperCase();
    if (actionType === 'SCROLL' || actionType === 'NAVIGATE') {
      return {
        isLoopCandidate: false,
        patternType: 'single-element',
        role: 'SETUP',
        originalCssPath: cssPath,
        fingerprint,
        description: 'Page scroll or navigation (executed once as setup)'
      };
    }

    // 0. Exclude Site Chrome, Navigation Toolbars, Tabs, Headers, Footers, and Form Inputs
    if (this.isNavigationOrChrome(cssPath, fingerprint)) {
      return {
        isLoopCandidate: false,
        patternType: 'single-element',
        role: 'SETUP',
        isNavigationOrChrome: true,
        originalCssPath: cssPath,
        fingerprint,
        description: 'Navigation, toolbar, or header control (executed once as setup)'
      };
    }

    // 0b. Exclude standalone dropdowns and form filter inputs (executed once as page setup)
    if ((tagName === 'select' || step.type === 'SELECT') && role !== 'option' && tagName !== 'option') {
      return {
        isLoopCandidate: false,
        patternType: 'single-element',
        role: 'SETUP',
        originalCssPath: cssPath,
        fingerprint,
        description: 'Dropdown filter / selection control (executed once as setup)'
      };
    }

    // 1. Table Row & Data Grid Detection (<tr>, <td>, <th>, [role="row"], [role="gridcell"], .row, .grid-row)
    if (
      /(tr:nth-(?:child|of-type)|tbody\s*>\s*tr|\btr\b|\[role=["']row["']\]|\[role=["']gridcell["']\]|\b(data-row|table-row|grid-row)\b)/i.test(cssPath) ||
      parentTag === 'tr' || parentTag === 'td' || tagName === 'tr' || tagName === 'td' ||
      role === 'row' || role === 'gridcell'
    ) {
      const tableMatch = cssPath.match(/(.*?(?:tr|\[role=["']row["']\]|\.data-row|\.grid-row))(?::(?:nth-child|nth-of-type)\(\d+\))?(.*)/i);
      if (tableMatch) {
        const containerSelector = tableMatch[1].replace(/:(?:nth-child|nth-of-type)\(\d+\)/g, '').trim();
        const relativeSelector = tableMatch[2].replace(/^(\s*>\s*)+/, '').trim() || null;
        return {
          isLoopCandidate: true,
          patternType: 'table-row',
          role: 'LOOP',
          containerSelector: containerSelector || 'table tbody tr, [role="row"]',
          relativeSelector: relativeSelector || '*',
          originalCssPath: cssPath,
          fingerprint,
          description: 'Repeated action across table rows or data grid records'
        };
      }

      return {
        isLoopCandidate: true,
        patternType: 'table-row',
        role: 'LOOP',
        containerSelector: 'table tbody tr, [role="grid"] [role="row"], [role="row"]',
        relativeSelector: '*',
        originalCssPath: cssPath,
        fingerprint,
        description: 'Repeated action across table rows'
      };
    }

    // 2. Dropdown Option Detection (mat-option, [role="option"], select > option, mat-pseudo-checkbox)
    if (
      tagName === 'mat-option' ||
      parentTag === 'mat-option' ||
      tagName === 'mat-pseudo-checkbox' ||
      tagName === 'option' ||
      role === 'option' ||
      /(mat-option|\[role=["']option["']\]|select\s*>\s*option|\.mat-mdc-option)/i.test(cssPath)
    ) {
      return {
        isLoopCandidate: true,
        patternType: 'dropdown-option',
        role: 'LOOP',
        containerSelector: 'div[role="listbox"], mat-select, select, .cdk-overlay-pane',
        relativeSelector: 'mat-option, [role="option"], option',
        originalCssPath: cssPath,
        fingerprint,
        description: 'Repeated action across dropdown option items'
      };
    }

    // 3. Checkbox & Radio Repeating List Detection
    const isCheckbox = tagName === 'input' && (fingerprint.type === 'checkbox' || fingerprint.attributes?.type === 'checkbox') ||
      role === 'checkbox' || (/\bcheckbox\b/i.test(cssPath) && !/\bmat-option\b/i.test(cssPath));
    const isRadio = tagName === 'input' && (fingerprint.type === 'radio' || fingerprint.attributes?.type === 'radio') ||
      role === 'radio';

    if (isCheckbox || isRadio) {
      const pType = isCheckbox ? 'checkbox-list' : 'radio-group';
      const parts = cssPath.split(/:(?:nth-child|nth-of-type)\(\d+\)/i);
      const containerSelector = parts.length >= 2 ? parts[0].trim() : 'form, fieldset, div, ul';
      return {
        isLoopCandidate: true,
        patternType: pType,
        role: 'LOOP',
        containerSelector,
        relativeSelector: isCheckbox ? 'input[type="checkbox"], [role="checkbox"]' : 'input[type="radio"], [role="radio"]',
        originalCssPath: cssPath,
        fingerprint,
        description: `Repeated action across ${isCheckbox ? 'checkbox items' : 'radio options'}`
      };
    }

    // 4. Ordered/Unordered List Items (<ul> / <ol> -> <li>, [role="listitem"])
    if (
      /(li:nth-(?:child|of-type)|[uo]l\s*>\s*li)/i.test(cssPath) ||
      parentTag === 'li' || tagName === 'li' || role === 'listitem'
    ) {
      const listMatch = cssPath.match(/(.*?li)(?::(?:nth-child|nth-of-type)\(\d+\))?(.*)/i);
      if (listMatch) {
        const containerSelector = listMatch[1].replace(/:(?:nth-child|nth-of-type)\(\d+\)/g, '').trim();
        const relativeSelector = listMatch[2].replace(/^(\s*>\s*)+/, '').trim() || null;
        return {
          isLoopCandidate: true,
          patternType: 'list-item',
          role: 'LOOP',
          containerSelector: containerSelector || 'ul > li',
          relativeSelector: relativeSelector || '*',
          originalCssPath: cssPath,
          fingerprint,
          description: 'Repeated action across list items'
        };
      }

      return {
        isLoopCandidate: true,
        patternType: 'list-item',
        role: 'LOOP',
        containerSelector: 'ul > li, [role="list"] > [role="listitem"]',
        relativeSelector: '*',
        originalCssPath: cssPath,
        fingerprint,
        description: 'Repeated action across list items'
      };
    }

    // 5. Repeating Card, Tile, or Flex/Grid Containers (.item, .card, [data-item-id], [data-testid*="item"])
    if (
      /:(?:nth-child|nth-of-type)\(\d+\)/i.test(cssPath) ||
      /\b(card|grid-item|card-item|product-item|document-card|data-card|item-row)\b/i.test(cssPath) ||
      role === 'article'
    ) {
      const parts = cssPath.split(/:(?:nth-child|nth-of-type)\(\d+\)/i);
      if (parts.length >= 2) {
        const containerSelector = parts[0].trim();
        const relativeSelector = parts.slice(1).join('').replace(/^(\s*>\s*)+/, '').trim() || null;
        return {
          isLoopCandidate: true,
          patternType: 'card-grid',
          role: 'LOOP',
          containerSelector,
          relativeSelector: relativeSelector || '*',
          originalCssPath: cssPath,
          fingerprint,
          description: 'Repeated action across nth-child grid or card elements'
        };
      }

      if (/\b(card|grid-item|item)\b/i.test(cssPath) || role === 'article') {
        return {
          isLoopCandidate: true,
          patternType: 'card-grid',
          role: 'LOOP',
          containerSelector: '.card, .grid-item, [role="article"]',
          relativeSelector: '*',
          originalCssPath: cssPath,
          fingerprint,
          description: 'Repeated action across card or grid items'
        };
      }
    }

    return {
      isLoopCandidate: false,
      patternType: 'single-element',
      role: 'SETUP',
      originalCssPath: cssPath,
      fingerprint
    };
  }

  /**
   * Identifies if a selector or element belongs to navigation chrome (tabs, toolbars, headers)
   */
  static isNavigationOrChrome(cssPath = '', fingerprint = {}) {
    const combined = [
      cssPath,
      fingerprint.id,
      fingerprint.tagName,
      fingerprint.parentTag,
      fingerprint.role,
      fingerprint.ariaLabel,
      Array.isArray(fingerprint.classes) ? fingerprint.classes.join(' ') : ''
    ].join(' ').toLowerCase();

    // 1. Navigation tags & component patterns
    if (/\b(mat-toolbar|mat-toolbar-row|mat-tab-header|mat-tab-group|mat-tab-nav-bar|mat-tab-link|mat-sidenav|mat-sidenav-container|app-header|app-nav|navbar)\b/i.test(combined) ||
        /(^|>|\s)(nav|header|footer|mat-toolbar|mat-toolbar-row)(\s|>|$)/i.test(cssPath)) {
      return true;
    }

    // 2. Navigation roles
    if (/\b(navigation|menubar|tablist|tab|banner|contentinfo|toolbar|breadcrumb|pagination)\b/i.test(combined)) {
      return true;
    }

    // 3. Navigation class names & UI patterns
    if (/\b(navbar|nav-tabs|nav-item|nav-link|top-bar|app-bar|sidebar-nav|sidebar|site-header|main-nav|page-header|pager|header-nav|menu-item|menu-link|mat-list-item)\b/i.test(combined) ||
        /(#menu-|\.menu\b|nav\s*>\s*ul|sidebar\s*>\s*ul|\/menu-|\bmenu-\d+)/i.test(cssPath) ||
        /(^|#|\b)menu-\d+/i.test(fingerprint.id || '')) {
      return true;
    }

    // 4. Form inputs that are not repetitive data records (e.g. login username/password fields)
    if (/(form\s*>\s*div.*input|input\[type=(?:password|email)\])/i.test(combined)) {
      return true;
    }

    // 5. Authentication and login controls
    if (/\b(login|signin|sign-in|auth|password|username|credential)\b/i.test(combined)) {
      return true;
    }

    return false;
  }

  /**
   * Automatically finds the best starting loopStepIndex from a workflow's steps.
   * Skips all navigation, header, and toolbar controls.
   * Prioritizes data table rows and dropdown options over generic list items.
   * 
   * @param {Array<object>} steps
   * @returns {number} Index of the first repeating loop candidate step, or -1 if none found.
   */
  static findLoopCandidateIndex(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return -1;

    // 1. First, check if any step was explicitly marked as LOOP or sequential iteration by user
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] && (steps[i].role === 'LOOP' || steps[i].isLoopCandidate === true || steps[i].isLoop === true || steps[i].loopMode === 'sequential_iteration')) {
        return i;
      }
    }

    // 2. Prioritize Data Table Rows, Checkbox Lists, Radio Groups, and Dropdown Options
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || step.role === 'SETUP') continue;

      const analysis = this.analyzeStep(step);
      if (analysis && analysis.isLoopCandidate && !analysis.isNavigationOrChrome) {
        if (['table-row', 'checkbox-list', 'radio-group', 'dropdown-option'].includes(analysis.patternType)) {
          return i;
        }
      }
    }

    // 3. Fallback to generic card-grid or content list items
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || step.role === 'SETUP') continue;

      const analysis = this.analyzeStep(step);
      if (analysis && analysis.isLoopCandidate && !analysis.isNavigationOrChrome) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Comprehensive workflow analysis that automatically discovers repeated structures,
   * performs dynamic setup/loop separation, and calculates multi-signal loop confidence.
   *
   * @param {Array<object>} steps - The recorded sequence of workflow actions
   * @param {object} context - Optional runtime / DOM context
   * @returns {{
   *   isLoop: boolean,
   *   loopStepIndex: number,
   *   confidence: number,
   *   confidenceCategory: 'HIGH' | 'MEDIUM' | 'LOW',
   *   patternType: string,
   *   reasons: string[],
   *   signals: object,
   *   setupSteps: Array<object>,
   *   loopSteps: Array<object>,
   *   teardownSteps: Array<object>
   * }}
   */
  static analyzeWorkflow(steps = [], context = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return {
        isLoop: false,
        loopStepIndex: -1,
        confidence: 0,
        confidenceCategory: 'LOW',
        patternType: 'none',
        reasons: ['No workflow steps to analyze.'],
        signals: {},
        setupSteps: [],
        loopSteps: [],
        teardownSteps: []
      };
    }

    const loopStepIndex = this.findLoopCandidateIndex(steps);
    if (loopStepIndex < 0) {
      return {
        isLoop: false,
        loopStepIndex: -1,
        confidence: 0,
        confidenceCategory: 'LOW',
        patternType: 'single-element',
        reasons: ['No repeating structure detected in workflow actions.'],
        signals: {},
        setupSteps: steps,
        loopSteps: [],
        teardownSteps: []
      };
    }

    const candidateStep = steps[loopStepIndex];
    const stepAnalysis = this.analyzeStep(candidateStep);

    // Run multi-signal confidence engine
    const confidenceResult = LoopConfidenceEngine.evaluate(stepAnalysis, {
      allSteps: steps,
      loopStepIndex,
      fingerprint: candidateStep?.target?.fingerprint || candidateStep?.fingerprint,
      ...context
    });

    const isLoop = confidenceResult.autoLoop || confidenceResult.score >= 50;
    const partition = this.partitionWorkflow(steps, loopStepIndex);

    return {
      isLoop,
      loopStepIndex,
      confidence: confidenceResult.score,
      confidenceCategory: confidenceResult.category,
      patternType: stepAnalysis.patternType || 'table-row',
      reasons: confidenceResult.reasons,
      signals: confidenceResult.signals,
      setupSteps: partition.setupSteps,
      loopSteps: partition.loopSteps,
      teardownSteps: partition.teardownSteps
    };
  }

  /**
   * Validates a loop configuration against the workflow's step count.
   * Enforces: one loop, inclusive range, anchor in range, valid bounds, no nested loops.
   *
   * @param {object} loopConfig - { enabled, anchorStepIndex, startStepIndex, endStepIndex, maxItems }
   * @param {number} stepCount - Total number of steps in the workflow
   * @returns {{ valid: boolean, error: string|null }}
   */
  static validateLoopConfig(loopConfig, stepCount = 0) {
    if (!loopConfig || typeof loopConfig !== 'object') {
      return { valid: false, error: 'Loop configuration must be an object' };
    }

    if (loopConfig.enabled === false) {
      return { valid: true, error: null };
    }

    if (loopConfig.nestedLoops && Array.isArray(loopConfig.nestedLoops) && loopConfig.nestedLoops.length > 0) {
      return { valid: false, error: 'Nested loops and multiple loop ranges are unsupported in v1.0' };
    }

    if (typeof stepCount !== 'number' || stepCount <= 0) {
      return { valid: false, error: 'Workflow must have at least one step for loop configuration' };
    }

    const { startStepIndex, endStepIndex, anchorStepIndex, maxItems } = loopConfig;

    if (!Number.isInteger(startStepIndex) || startStepIndex < 0 || startStepIndex >= stepCount) {
      return { valid: false, error: `Invalid startStepIndex ${startStepIndex}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
    }

    if (!Number.isInteger(endStepIndex) || endStepIndex < 0 || endStepIndex >= stepCount) {
      return { valid: false, error: `Invalid endStepIndex ${endStepIndex}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
    }

    if (startStepIndex > endStepIndex) {
      return { valid: false, error: `startStepIndex (${startStepIndex}) cannot be greater than endStepIndex (${endStepIndex})` };
    }

    if (!Number.isInteger(anchorStepIndex) || anchorStepIndex < 0 || anchorStepIndex >= stepCount) {
      return { valid: false, error: `Invalid anchorStepIndex ${anchorStepIndex}: out of bounds (must be a valid step between 0 and ${stepCount - 1})` };
    }

    if (anchorStepIndex < startStepIndex || anchorStepIndex > endStepIndex) {
      return { valid: false, error: `anchorStepIndex (${anchorStepIndex}) must lie within the selected loop range [${startStepIndex}..${endStepIndex}] in v1.0` };
    }

    if (maxItems !== undefined && maxItems !== null) {
      if (!Number.isInteger(maxItems) || maxItems <= 0) {
        return { valid: false, error: 'maxItems must be a positive integer or null' };
      }
    }

    return { valid: true, error: null };
  }

  /**
   * Derives a unified LoopConfig { enabled, anchorStepIndex, startStepIndex, endStepIndex, maxItems }
   * from any workflow definition, preserving backward compatibility.
   *
   * @param {object} definition - Stored workflow or workflow_definition
   * @param {Array<object>} stepsInput - Optional steps array
   * @returns {{ enabled: boolean, anchorStepIndex: number|null, startStepIndex: number|null, endStepIndex: number|null, maxItems: number|null }}
   */
  static deriveLoopConfig(definition = {}, stepsInput) {
    const def = (definition && typeof definition === 'object') ? definition : {};
    const metadata = (def.metadata && typeof def.metadata === 'object') ? def.metadata : {};
    const settings = (def.settings && typeof def.settings === 'object') ? def.settings : {};

    const steps = Array.isArray(stepsInput)
      ? stepsInput
      : Array.isArray(def.steps)
        ? def.steps
        : Array.isArray(def.actions)
          ? def.actions
          : [];

    const stepCount = steps.length;

    // Check explicit loop disabled or single/standard mode first
    // Priority: def-level explicit setting takes precedence over stored workflow defaults
    const isExplicitlyDisabled = def.isLoop === false || def.mode === 'single' || def.mode === 'standard' ||
      (def.isLoop === undefined && def.mode === undefined && (metadata.isLoop === false || metadata.mode === 'single' || metadata.mode === 'standard')) ||
      (def.loop && def.loop.enabled === false);
    if (isExplicitlyDisabled) {
      return {
        enabled: false,
        anchorStepIndex: null,
        startStepIndex: null,
        endStepIndex: null,
        maxItems: null
      };
    }

    // Check if explicitly configured via unified `loop` object
    const explicitLoop = (def.loop && typeof def.loop === 'object') ? def.loop : (metadata.loop && typeof metadata.loop === 'object' ? metadata.loop : null);
    if (explicitLoop) {
      if (explicitLoop.enabled === false) {
        return {
          enabled: false,
          anchorStepIndex: null,
          startStepIndex: null,
          endStepIndex: null,
          maxItems: null
        };
      }
      const anchorIdx = Number.isInteger(explicitLoop.anchorStepIndex)
        ? explicitLoop.anchorStepIndex
        : (Number.isInteger(explicitLoop.loopStepIndex) ? explicitLoop.loopStepIndex : null);
      const startIdx = Number.isInteger(explicitLoop.startStepIndex)
        ? explicitLoop.startStepIndex
        : anchorIdx;
      const endIdx = Number.isInteger(explicitLoop.endStepIndex)
        ? explicitLoop.endStepIndex
        : (stepCount > 0 ? stepCount - 1 : null);
      const maxItems = Number.isInteger(explicitLoop.maxItems) && explicitLoop.maxItems > 0
        ? explicitLoop.maxItems
        : (Number.isInteger(explicitLoop.loopLimit) && explicitLoop.loopLimit > 0 ? explicitLoop.loopLimit : null);

      if (anchorIdx !== null && startIdx !== null && endIdx !== null) {
        return {
          enabled: explicitLoop.enabled !== false,
          anchorStepIndex: anchorIdx,
          startStepIndex: startIdx,
          endStepIndex: endIdx,
          maxItems
        };
      }
    }

    // Derive from legacy or step signals
    const flaggedIdx = steps.findIndex(s => s && (s.role === 'LOOP' || s.isLoop === true || s.isLoopCandidate === true || s.loopMode === 'sequential_iteration'));
    const extractionIdx = steps.findIndex(s => s && ['EXTRACT_TABLE', 'EXTRACT_TEXT', 'LOOP_START', 'EXTRACT'].includes(String(s.type || s.action || '').toUpperCase()));

    const isLoop = Boolean(
      def.isLoop === true ||
      metadata.isLoop === true ||
      String(def.mode || '').toLowerCase() === 'loop' ||
      String(metadata.mode || '').toLowerCase() === 'loop' ||
      flaggedIdx >= 0 ||
      extractionIdx >= 0
    );

    if (!isLoop || stepCount === 0) {
      return {
        enabled: false,
        anchorStepIndex: null,
        startStepIndex: null,
        endStepIndex: null,
        maxItems: null
      };
    }

    let anchorIdx = Number.isInteger(def.loopStepIndex)
      ? def.loopStepIndex
      : (Number.isInteger(metadata.loopStepIndex)
          ? metadata.loopStepIndex
          : (Number.isInteger(settings.loopStepIndex)
              ? settings.loopStepIndex
              : (flaggedIdx >= 0 ? flaggedIdx : (extractionIdx >= 0 ? extractionIdx : 0))));

    if (anchorIdx < 0 || anchorIdx >= stepCount) {
      anchorIdx = flaggedIdx >= 0 ? flaggedIdx : (extractionIdx >= 0 ? extractionIdx : 0);
    }

    const startIdx = Number.isInteger(def.startStepIndex) && def.startStepIndex >= 0 && def.startStepIndex < stepCount
      ? def.startStepIndex
      : anchorIdx;

    let endIdx = Number.isInteger(def.endStepIndex) && def.endStepIndex >= startIdx && def.endStepIndex < stepCount
      ? def.endStepIndex
      : stepCount - 1;

    // Check for explicit teardown steps if endStepIndex was not explicitly set
    if (!Number.isInteger(def.endStepIndex)) {
      for (let i = stepCount - 1; i > startIdx; i--) {
        const s = steps[i];
        if (s && (s.role === 'TEARDOWN' || s.isTeardown === true)) {
          endIdx = i - 1;
        } else {
          break;
        }
      }
    }

    const maxItems = Number.isInteger(def.loopLimit) && def.loopLimit > 0
      ? def.loopLimit
      : (Number.isInteger(metadata.loopLimit) && metadata.loopLimit > 0 ? metadata.loopLimit : null);

    return {
      enabled: true,
      anchorStepIndex: anchorIdx,
      startStepIndex: startIdx,
      endStepIndex: Math.max(startIdx, endIdx),
      maxItems
    };
  }

  /**
   * Partitions a recording's step sequence into:
   * 1. setupSteps: steps before the repeating range (e.g. login, navigate, open tab)
   * 2. loopSteps: steps to be repeated per collection item (from startIndex to endIndex inclusive)
   * 3. teardownSteps: steps after the repeating range, executed once upon normal completion
   *
   * @param {Array<object>} steps - Workflow steps array
   * @param {number} startIndex - Start index of the loop range (or anchor index for legacy callers)
   * @param {number|null} endIndex - Optional end index of the loop range (inclusive)
   */
  static partitionWorkflow(steps, startIndex, endIndex = null) {
    if (!Array.isArray(steps) || startIndex < 0 || startIndex >= steps.length) {
      return {
        setupSteps: steps || [],
        loopSteps: [],
        teardownSteps: []
      };
    }

    const setupSteps = steps.slice(0, startIndex);

    if (Number.isInteger(endIndex) && endIndex >= startIndex) {
      const clampedEnd = Math.min(steps.length - 1, endIndex);
      const loopSteps = steps.slice(startIndex, clampedEnd + 1);
      const teardownSteps = steps.slice(clampedEnd + 1);
      return {
        setupSteps,
        loopSteps,
        teardownSteps
      };
    }

    // Legacy fallback when endIndex is not provided
    const loopCandidateSteps = steps.slice(startIndex);
    let teardownIdx = -1;
    for (let i = loopCandidateSteps.length - 1; i > 0; i--) {
      const s = loopCandidateSteps[i];
      if (s && (s.role === 'TEARDOWN' || s.isTeardown === true)) {
        teardownIdx = i;
        break;
      }
    }

    let loopSteps = loopCandidateSteps;
    let teardownSteps = [];
    if (teardownIdx > 0) {
      loopSteps = loopCandidateSteps.slice(0, teardownIdx);
      teardownSteps = loopCandidateSteps.slice(teardownIdx);
    }

    return {
      setupSteps,
      loopSteps,
      teardownSteps
    };
  }

  /**
   * Derives a structured two-level (nested) loop configuration:
   * Level 1: Outer (Company / Department / Customer) anchor and range
   * Level 2: Inner (Record / Invoice / Order) anchor and range
   *
   * @param {object} definition - Workflow definition or run config
   * @param {Array<object>} stepsInput - Workflow steps sequence
   * @returns {object|null} Standardized nested loop configuration or null if not a two-level loop
   */
  static deriveNestedLoopConfig(definition = {}, stepsInput) {
    const def = (definition && typeof definition === 'object') ? definition : {};
    const metadata = (def.metadata && typeof def.metadata === 'object') ? def.metadata : {};
    const settings = (def.settings && typeof def.settings === 'object') ? def.settings : {};
    const steps = Array.isArray(stepsInput)
      ? stepsInput
      : (Array.isArray(def.steps) ? def.steps : (Array.isArray(def.actions) ? def.actions : []));
    const stepCount = steps.length;

    // 1. Check for explicit nestedLoop configuration in various standard containers
    const raw = def.nestedLoop ||
      def.twoLevelLoop ||
      def.nested_loop ||
      def.two_level_loop ||
      (def.loop && (def.loop.nested || def.loop.two_level || (def.loop.mode === 'two_level' ? def.loop : null))) ||
      (metadata.loop && (metadata.loop.nested || (metadata.loop.mode === 'two_level' ? metadata.loop : null))) ||
      metadata.nestedLoop ||
      metadata.twoLevelLoop ||
      settings.nestedLoop;

    if (!raw || raw.enabled === false) {
      // 2. Also check if definition explicitly flags two anchors
      const outerAnchor = Number.isInteger(def.outerAnchorStepIndex) ? def.outerAnchorStepIndex : (Number.isInteger(def.companyAnchorStepIndex) ? def.companyAnchorStepIndex : null);
      const innerAnchor = Number.isInteger(def.innerAnchorStepIndex) ? def.innerAnchorStepIndex : (Number.isInteger(def.recordAnchorStepIndex) ? def.recordAnchorStepIndex : null);

      if (outerAnchor === null || innerAnchor === null || outerAnchor === innerAnchor) {
        return null;
      }

      // Build structured nested loop from flat anchors
      const outerStart = Number.isInteger(def.outerStartStepIndex) ? def.outerStartStepIndex : outerAnchor;
      const outerEnd = Number.isInteger(def.outerEndStepIndex) ? def.outerEndStepIndex : (stepCount > 0 ? stepCount - 1 : 0);
      const innerStart = Number.isInteger(def.innerStartStepIndex) ? def.innerStartStepIndex : innerAnchor;
      const innerEnd = Number.isInteger(def.innerEndStepIndex) ? def.innerEndStepIndex : Math.max(innerStart, outerEnd - 1);

      return {
        enabled: true,
        mode: 'two_level',
        outer: {
          name: def.outerName || 'company',
          anchorStepIndex: outerAnchor,
          startStepIndex: outerStart,
          endStepIndex: outerEnd,
          maxItems: Number.isInteger(def.outerMaxItems) && def.outerMaxItems > 0 ? def.outerMaxItems : null,
          filter: def.outerFilter || null
        },
        inner: {
          name: def.innerName || 'record',
          anchorStepIndex: innerAnchor,
          startStepIndex: innerStart,
          endStepIndex: innerEnd,
          maxItems: Number.isInteger(def.innerMaxItems) && def.innerMaxItems > 0 ? def.innerMaxItems : (Number.isInteger(def.loopLimit) ? def.loopLimit : null),
          filter: def.innerFilter || def.itemFilter || def.rowFilter || null
        }
      };
    }

    const outer = raw.outer || {};
    const inner = raw.inner || {};

    const outerAnchor = Number.isInteger(outer.anchorStepIndex)
      ? outer.anchorStepIndex
      : (Number.isInteger(outer.loopStepIndex) ? outer.loopStepIndex : 0);
    const outerStart = Number.isInteger(outer.startStepIndex) ? outer.startStepIndex : outerAnchor;
    const outerEnd = Number.isInteger(outer.endStepIndex) ? outer.endStepIndex : (stepCount > 0 ? stepCount - 1 : 0);

    const innerAnchor = Number.isInteger(inner.anchorStepIndex)
      ? inner.anchorStepIndex
      : (Number.isInteger(inner.loopStepIndex) ? inner.loopStepIndex : Math.min(outerAnchor + 2, Math.max(0, stepCount - 1)));
    const innerStart = Number.isInteger(inner.startStepIndex) ? inner.startStepIndex : innerAnchor;
    const innerEnd = Number.isInteger(inner.endStepIndex) ? inner.endStepIndex : Math.max(innerStart, outerEnd - 1);

    return {
      enabled: raw.enabled !== false,
      mode: 'two_level',
      outer: {
        name: outer.name || 'company',
        anchorStepIndex: outerAnchor,
        startStepIndex: outerStart,
        endStepIndex: outerEnd,
        maxItems: Number.isInteger(outer.maxItems) && outer.maxItems > 0 ? outer.maxItems : null,
        filter: outer.filter || null
      },
      inner: {
        name: inner.name || 'record',
        anchorStepIndex: innerAnchor,
        startStepIndex: innerStart,
        endStepIndex: innerEnd,
        maxItems: Number.isInteger(inner.maxItems) && inner.maxItems > 0 ? inner.maxItems : (Number.isInteger(raw.maxItems) ? raw.maxItems : null),
        filter: inner.filter || raw.filter || def.itemFilter || def.rowFilter || null
      }
    };
  }

  /**
   * Validates a two-level (nested) loop configuration against workflow bounds.
   */
  static validateNestedLoopConfig(config, stepCount = 0) {
    if (!config || !config.enabled) {
      return { valid: false, error: 'Nested loop configuration is disabled or missing' };
    }
    const { outer, inner } = config;
    if (!outer || typeof outer !== 'object' || !inner || typeof inner !== 'object') {
      return { valid: false, error: 'Both outer and inner loop levels must be defined objects' };
    }
    if (stepCount <= 0) {
      return { valid: false, error: 'Workflow contains no steps to loop over' };
    }

    if (outer.startStepIndex < 0 || outer.startStepIndex >= stepCount) {
      return { valid: false, error: `Outer start index (${outer.startStepIndex}) is out of bounds (0..${stepCount - 1})` };
    }
    if (outer.anchorStepIndex < outer.startStepIndex || outer.anchorStepIndex > outer.endStepIndex) {
      return { valid: false, error: `Outer anchor index (${outer.anchorStepIndex}) must be within outer range [${outer.startStepIndex}..${outer.endStepIndex}]` };
    }
    if (outer.endStepIndex < outer.startStepIndex || outer.endStepIndex >= stepCount) {
      return { valid: false, error: `Outer end index (${outer.endStepIndex}) must be >= outer start (${outer.startStepIndex}) and < step count (${stepCount})` };
    }

    if (inner.startStepIndex < outer.startStepIndex || inner.endStepIndex > outer.endStepIndex) {
      return { valid: false, error: `Inner loop range [${inner.startStepIndex}..${inner.endStepIndex}] must be enclosed within outer loop range [${outer.startStepIndex}..${outer.endStepIndex}]` };
    }
    if (inner.anchorStepIndex < inner.startStepIndex || inner.anchorStepIndex > inner.endStepIndex) {
      return { valid: false, error: `Inner anchor index (${inner.anchorStepIndex}) must be within inner range [${inner.startStepIndex}..${inner.endStepIndex}]` };
    }

    return { valid: true, error: null };
  }

  /**
   * Partitions workflow steps into 5 discrete phases for controlled two-level iteration:
   * 1. initialSetupSteps: steps executed ONCE before any company/outer iteration (e.g. Login)
   * 2. outerPreSteps: steps to select current company and navigate to its record page
   * 3. innerLoopSteps: repeated steps executed per record/invoice for the current company
   * 4. outerPostSteps: steps to exit record view and return to company selection context
   * 5. finalTeardownSteps: steps executed ONCE after all companies complete (e.g. Logout)
   */
  static partitionNestedWorkflow(steps, nestedConfig) {
    if (!Array.isArray(steps) || !nestedConfig || !nestedConfig.enabled) {
      return {
        initialSetupSteps: steps || [],
        outerPreSteps: [],
        innerLoopSteps: [],
        outerPostSteps: [],
        finalTeardownSteps: [],
        outerAnchorOffset: 0,
        innerAnchorOffset: 0
      };
    }

    const { outer, inner } = nestedConfig;

    const initialSetupSteps = steps.slice(0, outer.startStepIndex);
    const outerPreSteps = steps.slice(outer.startStepIndex, inner.startStepIndex);
    const innerLoopSteps = steps.slice(inner.startStepIndex, inner.endStepIndex + 1);
    const outerPostSteps = steps.slice(inner.endStepIndex + 1, outer.endStepIndex + 1);
    const finalTeardownSteps = steps.slice(outer.endStepIndex + 1);

    const outerAnchorOffset = outer.anchorStepIndex - outer.startStepIndex;
    const innerAnchorOffset = inner.anchorStepIndex - inner.startStepIndex;

    return {
      initialSetupSteps,
      outerPreSteps,
      innerLoopSteps,
      outerPostSteps,
      finalTeardownSteps,
      outerAnchorOffset,
      innerAnchorOffset
    };
  }
}

module.exports = LoopDetector;
