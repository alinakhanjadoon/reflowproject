/**
 * Shared constants for ReFlow & Replay Engine
 */

const ACTION_TYPES = Object.freeze({
  CLICK: 'CLICK',
  DOUBLE_CLICK: 'DOUBLE_CLICK',
  TYPE: 'TYPE',
  SELECT: 'SELECT',
  KEY_PRESS: 'KEY_PRESS',
  SCROLL: 'SCROLL'
});

const SELECTOR_STRATEGIES = Object.freeze({
  ID: 'id',
  DATA_ATTR: 'data-attr',
  ATTRIBUTE: 'attribute',
  TEXT: 'text',
  CSS_PATH: 'css-path',
  XPATH: 'xpath'
});

const STRATEGY_PRIORITIES = Object.freeze({
  [SELECTOR_STRATEGIES.ID]: 1,
  [SELECTOR_STRATEGIES.DATA_ATTR]: 2,
  [SELECTOR_STRATEGIES.ATTRIBUTE]: 3,
  [SELECTOR_STRATEGIES.TEXT]: 4,
  [SELECTOR_STRATEGIES.CSS_PATH]: 5,
  [SELECTOR_STRATEGIES.XPATH]: 6
});

const RESOLVER_WEIGHTS = Object.freeze({
  ID_OR_NAME: 0.30,
  DATA_OR_ARIA: 0.25,
  VISIBLE_TEXT: 0.25,
  OTHER_ATTRS: 0.10,
  CLASSES: 0.10
});

const MIN_CONFIDENCE_THRESHOLD = 0.70;

const DEFAULT_TIMEOUTS = Object.freeze({
  RESOLUTION_TIMEOUT_MS: 5000,
  POLL_INTERVAL_MS: 100,
  ERP_RESOLUTION_TIMEOUT_MS: 15000,
  ERP_POLL_INTERVAL_MS: 150,
  TYPE_KEYSTROKE_DELAY_MS: 20,
  POST_ACTION_DELAY_MS: 300
});

// Patterns to detect unstable / dynamic IDs (e.g. React 18 useId `:r1:`, Angular Material `mat-select-`, `mat-option-`, `cdk-overlay-`, `ng-`, Sencha/ExtJS `gridview-`, `record-`, `tableview-`, `toolbar-`, `container-`, long hashes, UUIDs)
const UNSTABLE_ID_PATTERN = /(:r[0-9a-z_-]+:|^ng-|^__|^ember|^\d+$|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|_[0-9a-zA-Z]{5,}|^gridview-\d+|^record-\d+|^tableview-\d+|^ext-gen|^ext-comp|^panel-\d+|^menuitem-\d+|^button-\d+|ext-element-\d+|^toolbar-\d+|^container-\d+|^headercontainer-\d+|^box-\d+|^form-\d+|^tabbar-\d+|^splitbar-\d+|^window-\d+|^field-\d+|^component-\d+|^view-\d+|-[0-9]{3,}(-[a-zA-Z0-9_-]+)?$|^mat-select-value-\d+|^mat-option-\d+|^mat-select-\d+|^mat-checkbox-\d+|^mat-input-\d+|^mat-form-field-|^mat-mdc-|^cdk-overlay-|^cdk-describedby-)/i;

// Classes to ignore when computing fingerprint similarity (state/transient styles)
const TRANSIENT_CLASS_PATTERN = /^(active|hover|focus|focus-visible|disabled|selected|open|closed|show|hide|entering|leaving|animate-|transition-|css-[a-z0-9]+$)/i;

// Preferred data attributes for testing / automation
const PREFERRED_DATA_ATTRIBUTES = Object.freeze([
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-automation',
  'data-id',
  'data-action',
  'data-component'
]);

module.exports = {
  ACTION_TYPES,
  SELECTOR_STRATEGIES,
  STRATEGY_PRIORITIES,
  RESOLVER_WEIGHTS,
  MIN_CONFIDENCE_THRESHOLD,
  DEFAULT_TIMEOUTS,
  UNSTABLE_ID_PATTERN,
  TRANSIENT_CLASS_PATTERN,
  PREFERRED_DATA_ATTRIBUTES
};
