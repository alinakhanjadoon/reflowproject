/**
 * Shared Item Filter Evaluator
 *
 * Implements the frozen Shared Filter Contract from docs/LOOP-FILTER-REQUIREMENTS.md
 * and docs/MULTI-AGENT-WORK-PLAN.md (Tasks 4 and 12):
 * - Compound conditions with matchMode: 'all' (AND) or 'any' (OR). Default: 'all'.
 * - Operators: 'contains', 'equals', 'dateBetween'.
 * - Text comparisons trim whitespace and ignore letter case.
 * - 'dateBetween': strict YYYY-MM-DD date-only inclusive calendar comparisons.
 *   Ambiguous or unparseable source dates do not match and return a skip reason (Case B).
 * - Omitting `itemFilter` means process all discovered items (match all).
 * - Legacy `rowFilter: { column: "Type", value: "Invoice" }` and `filterColumn` / `filterValue`
 *   and single-condition `{ field, operator, value }` inputs are accepted and normalized.
 * - A configured field that cannot be read from the item's schema is an evaluation/configuration error (Case A).
 *   Never fall back to matching the entire row or accept an item when evaluation fails.
 * - Preview and loopLimit evaluation: filter first, then select first N matching items.
 *   Reports totalCount, matchingCount, selectedCount, skippedFilterCount, skippedLimitCount,
 *   and representative preview items with reasons.
 * - Pure evaluation over a normalized map of field names to values.
 * - Independent of browser, database, dashboard, and API code.
 */

'use strict';

const SUPPORTED_OPERATORS = Object.freeze(['contains', 'equals', 'dateBetween']);
const SUPPORTED_MATCH_MODES = Object.freeze(['all', 'any']);

/**
 * Validates whether a value is a strict YYYY-MM-DD date and represents a valid calendar day.
 * Deterministic and locale-independent.
 *
 * @param {any} val
 * @returns {{ valid: boolean, dateStr: string|null, error: string|null }}
 */
function validateStrictIsoDate(val) {
  if (typeof val !== 'string') {
    return { valid: false, dateStr: null, error: 'Date must be a string' };
  }
  const trimmed = val.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return { valid: false, dateStr: null, error: 'Date must be in strict YYYY-MM-DD format' };
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12) {
    return { valid: false, dateStr: null, error: `Invalid month "${match[2]}": must be between 01 and 12` };
  }

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (day < 1 || day > daysInMonth[month - 1]) {
    return { valid: false, dateStr: null, error: `Invalid day "${match[3]}" for month "${match[2]}"` };
  }

  return { valid: true, dateStr: trimmed, error: null };
}

/**
 * Parses an item's date value deterministically without locale dependence.
 * Returns { valid: boolean, missing: boolean, unparseable: boolean, dateStr: string|null }.
 *
 * @param {any} val
 * @returns {{ valid: boolean, missing: boolean, unparseable: boolean, dateStr: string|null }}
 */
function parseSourceDate(val) {
  if (val === null || val === undefined) {
    return { valid: false, missing: true, unparseable: false, dateStr: null };
  }

  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      return { valid: false, missing: false, unparseable: true, dateStr: null };
    }
    const iso = val.toISOString().slice(0, 10);
    return { valid: true, missing: false, unparseable: false, dateStr: iso };
  }

  const str = String(val).trim();
  if (!str) {
    return { valid: false, missing: true, unparseable: false, dateStr: null };
  }

  // Accept strict YYYY-MM-DD or standard ISO timestamp beginning with YYYY-MM-DD
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(str);
  if (isoMatch) {
    const yStr = isoMatch[1];
    const mStr = isoMatch[2];
    const dStr = isoMatch[3];
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    const d = parseInt(dStr, 10);

    if (m >= 1 && m <= 12) {
      const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
      const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (d >= 1 && d <= daysInMonth[m - 1]) {
        return { valid: true, missing: false, unparseable: false, dateStr: `${yStr}-${mStr}-${dStr}` };
      }
    }
    return { valid: false, missing: false, unparseable: true, dateStr: null };
  }

  // Accept YYYY/MM/DD
  const slashMatch = /^(\d{4})\/(\d{2})\/(\d{2})(?:[T\s].*)?$/.exec(str);
  if (slashMatch) {
    const yStr = slashMatch[1];
    const mStr = slashMatch[2];
    const dStr = slashMatch[3];
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    const d = parseInt(dStr, 10);

    if (m >= 1 && m <= 12) {
      const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
      const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (d >= 1 && d <= daysInMonth[m - 1]) {
        return { valid: true, missing: false, unparseable: false, dateStr: `${yStr}-${mStr}-${dStr}` };
      }
    }
    return { valid: false, missing: false, unparseable: true, dateStr: null };
  }

  // All other formats (e.g. MM/DD/YYYY, DD/MM/YYYY, or textual dates) are ambiguous without locale
  return { valid: false, missing: false, unparseable: true, dateStr: null };
}

/**
 * Normalizes operator strings to standard casing or lowercase for unknown operators.
 *
 * @param {any} op
 * @returns {string}
 */
function canonicalizeOperator(op) {
  if (!op || typeof op !== 'string') return '';
  const lower = op.trim().toLowerCase();
  if (lower === 'contains') return 'contains';
  if (lower === 'equals') return 'equals';
  if (lower === 'datebetween') return 'dateBetween';
  return lower;
}

/**
 * Normalizes any supported filter shape into a standard itemFilter object, or null for match-all.
 *
 * Compound shape:
 * {
 *   matchMode: 'all' | 'any',
 *   conditions: [
 *     { field: string, operator: 'contains' | 'equals' | 'dateBetween', value: any }
 *   ]
 * }
 *
 * @param {any} filterInput - Raw filter input from request body, workflow options, or query.
 * @returns {object|null} - Normalized filter object, null if no filter configured (match all),
 *                          or an object marked with `__invalid: true` if shape is malformed.
 */
function normalizeItemFilter(filterInput) {
  if (filterInput === undefined || filterInput === null) {
    return null;
  }

  // Reject primitive types or arrays
  if (typeof filterInput !== 'object' || Array.isArray(filterInput)) {
    return {
      __invalid: true,
      error: 'Filter must be an object',
      raw: filterInput
    };
  }

  let candidate = filterInput;

  // 1. Unwrap if wrapped in { itemFilter: ... } envelope
  if ('itemFilter' in candidate) {
    if (candidate.itemFilter === undefined || candidate.itemFilter === null) {
      return null;
    }
    candidate = candidate.itemFilter;
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
      return {
        __invalid: true,
        error: 'Filter must be an object',
        raw: candidate
      };
    }
  }

  // 2. Unwrap if wrapped in legacy { rowFilter: ... } envelope
  if ('rowFilter' in candidate) {
    if (candidate.rowFilter === undefined || candidate.rowFilter === null) {
      return null;
    }
    candidate = candidate.rowFilter;
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
      return {
        __invalid: true,
        error: 'Filter must be an object',
        raw: candidate
      };
    }
  }

  // 3. Legacy filterColumn / filterValue pair
  if ('filterValue' in candidate) {
    const rawVal = candidate.filterValue;
    if (rawVal === undefined || rawVal === null) return null;
    const strVal = String(rawVal).trim();
    if (!strVal || strVal === '__any__' || strVal === 'all') {
      return null;
    }
    const rawCol = candidate.filterColumn !== undefined && candidate.filterColumn !== null
      ? candidate.filterColumn
      : 'Type';
    const fieldStr = String(rawCol).trim();
    const cond = {
      field: fieldStr || 'Type',
      operator: 'contains',
      value: strVal,
      _hasField: true,
      _hasOperator: true,
      _hasValue: true
    };
    return {
      matchMode: 'all',
      conditions: [cond],
      field: cond.field,
      operator: cond.operator,
      value: cond.value,
      _hasField: true,
      _hasOperator: true,
      _hasValue: true
    };
  }

  // 4. Legacy rowFilter shape: { column: "...", value: "..." }
  if ('column' in candidate) {
    const rawVal = candidate.value !== undefined ? candidate.value : candidate.text;
    if (rawVal === undefined || rawVal === null) return null;
    const strVal = String(rawVal).trim();
    if (!strVal || strVal === '__any__' || strVal === 'all') {
      return null;
    }
    const rawCol = candidate.column;
    const fieldStr = String(rawCol !== undefined && rawCol !== null ? rawCol : 'Type').trim();
    const rawOp = candidate.operator !== undefined && candidate.operator !== null
      ? canonicalizeOperator(candidate.operator)
      : 'contains';
    const cond = {
      field: fieldStr,
      operator: rawOp,
      value: strVal,
      _hasField: true,
      _hasOperator: true,
      _hasValue: true
    };
    return {
      matchMode: 'all',
      conditions: [cond],
      field: cond.field,
      operator: cond.operator,
      value: cond.value,
      _hasField: true,
      _hasOperator: true,
      _hasValue: true
    };
  }

  // 5. Empty object means match-all
  const keys = Object.keys(candidate);
  if (keys.length === 0) {
    return null;
  }

  // 6. Compound conditions shape: { matchMode?: "all"|"any", conditions: [...] }
  if ('conditions' in candidate) {
    if (!Array.isArray(candidate.conditions)) {
      return {
        __invalid: true,
        error: 'Filter conditions must be an array',
        raw: candidate
      };
    }
    if (candidate.conditions.length === 0) {
      return {
        __invalid: true,
        error: 'Filter conditions cannot be empty',
        raw: candidate
      };
    }

    let matchMode = 'all';
    if (candidate.matchMode !== undefined && candidate.matchMode !== null) {
      if (typeof candidate.matchMode !== 'string') {
        return {
          __invalid: true,
          error: 'Filter matchMode must be a string',
          raw: candidate
        };
      }
      const rawMode = candidate.matchMode.trim().toLowerCase();
      if (!SUPPORTED_MATCH_MODES.includes(rawMode)) {
        return {
          __invalid: true,
          error: `Unsupported matchMode "${candidate.matchMode}". Supported modes: ${SUPPORTED_MATCH_MODES.join(', ')}`,
          raw: candidate
        };
      }
      matchMode = rawMode;
    }

    const normalizedConditions = [];
    for (let i = 0; i < candidate.conditions.length; i++) {
      const cond = candidate.conditions[i];
      if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
        return {
          __invalid: true,
          error: `Condition entry at index ${i} must be an object`,
          raw: cond
        };
      }

      const hasField = 'field' in cond && cond.field !== null && cond.field !== undefined;
      const hasOperator = 'operator' in cond && cond.operator !== null && cond.operator !== undefined;
      const hasValue = 'value' in cond && cond.value !== null && cond.value !== undefined;

      const rawField = hasField ? String(cond.field).trim() : '';
      const rawOp = hasOperator ? canonicalizeOperator(cond.operator) : '';

      let rawVal = undefined;
      if (hasValue) {
        if (rawOp === 'dateBetween' && typeof cond.value === 'object' && cond.value !== null && !Array.isArray(cond.value)) {
          rawVal = {
            from: cond.value.from !== undefined && cond.value.from !== null ? String(cond.value.from).trim() : '',
            to: cond.value.to !== undefined && cond.value.to !== null ? String(cond.value.to).trim() : ''
          };
        } else if (typeof cond.value === 'string') {
          rawVal = cond.value.trim();
        } else {
          rawVal = cond.value;
        }
      }

      normalizedConditions.push({
        field: rawField,
        operator: rawOp,
        value: rawVal,
        _hasField: hasField,
        _hasOperator: hasOperator,
        _hasValue: hasValue
      });
    }

    const norm = {
      matchMode,
      conditions: normalizedConditions
    };

    if (normalizedConditions.length === 1) {
      norm.field = normalizedConditions[0].field;
      norm.operator = normalizedConditions[0].operator;
      norm.value = normalizedConditions[0].value;
      norm._hasField = normalizedConditions[0]._hasField;
      norm._hasOperator = normalizedConditions[0]._hasOperator;
      norm._hasValue = normalizedConditions[0]._hasValue;
    }

    return norm;
  }

  // 7. Modern single condition shape: { field: "...", operator: "...", value: "...", matchMode?: "..." }
  let matchMode = 'all';
  if (candidate.matchMode !== undefined && candidate.matchMode !== null) {
    if (typeof candidate.matchMode !== 'string') {
      return {
        __invalid: true,
        error: 'Filter matchMode must be a string',
        raw: candidate
      };
    }
    const rawMode = candidate.matchMode.trim().toLowerCase();
    if (!SUPPORTED_MATCH_MODES.includes(rawMode)) {
      return {
        __invalid: true,
        error: `Unsupported matchMode "${candidate.matchMode}". Supported modes: ${SUPPORTED_MATCH_MODES.join(', ')}`,
        raw: candidate
      };
    }
    matchMode = rawMode;
  }

  const hasField = 'field' in candidate && candidate.field !== null && candidate.field !== undefined;
  const hasOperator = 'operator' in candidate && candidate.operator !== null && candidate.operator !== undefined;
  const hasValue = 'value' in candidate && candidate.value !== null && candidate.value !== undefined;

  const rawField = hasField ? String(candidate.field).trim() : '';
  const rawOp = hasOperator ? canonicalizeOperator(candidate.operator) : '';

  let rawVal = undefined;
  if (hasValue) {
    if (rawOp === 'dateBetween' && typeof candidate.value === 'object' && candidate.value !== null && !Array.isArray(candidate.value)) {
      rawVal = {
        from: candidate.value.from !== undefined && candidate.value.from !== null ? String(candidate.value.from).trim() : '',
        to: candidate.value.to !== undefined && candidate.value.to !== null ? String(candidate.value.to).trim() : ''
      };
    } else if (typeof candidate.value === 'string') {
      rawVal = candidate.value.trim();
    } else {
      rawVal = candidate.value;
    }
  }

  const singleCond = {
    field: rawField,
    operator: rawOp,
    value: rawVal,
    _hasField: hasField,
    _hasOperator: hasOperator,
    _hasValue: hasValue
  };

  return {
    matchMode,
    conditions: [singleCond],
    field: rawField,
    operator: rawOp,
    value: rawVal,
    _hasField: hasField,
    _hasOperator: hasOperator,
    _hasValue: hasValue
  };
}

/**
 * Validates a normalized or raw filter object.
 *
 * @param {any} filterInput - Raw or normalized filter.
 * @returns {{ valid: boolean, error: string|null, filter: object|null }}
 */
function validateItemFilter(filterInput) {
  const normalized = normalizeItemFilter(filterInput);

  // Omitted or match-all filter is valid
  if (normalized === null) {
    return { valid: true, error: null, filter: null };
  }

  // Structural invalidity
  if (normalized.__invalid) {
    return {
      valid: false,
      error: normalized.error || 'Filter must be an object',
      filter: null
    };
  }

  // Validate matchMode
  if (!SUPPORTED_MATCH_MODES.includes(normalized.matchMode)) {
    return {
      valid: false,
      error: `Unsupported matchMode "${normalized.matchMode}". Supported modes: ${SUPPORTED_MATCH_MODES.join(', ')}`,
      filter: normalized
    };
  }

  // Validate conditions array
  if (!Array.isArray(normalized.conditions) || normalized.conditions.length === 0) {
    return {
      valid: false,
      error: 'Filter conditions cannot be empty',
      filter: normalized
    };
  }

  const validatedConditions = [];

  for (let i = 0; i < normalized.conditions.length; i++) {
    const cond = normalized.conditions[i];

    // Empty field name
    if (!cond._hasField || !cond.field || cond.field.trim() === '') {
      return {
        valid: false,
        error: 'Filter field cannot be empty',
        filter: normalized
      };
    }

    // Missing or blank operator
    if (!cond._hasOperator || !cond.operator || cond.operator.trim() === '') {
      return {
        valid: false,
        error: 'Filter operator cannot be empty',
        filter: normalized
      };
    }

    // Unsupported operator
    if (!SUPPORTED_OPERATORS.includes(cond.operator)) {
      return {
        valid: false,
        error: `Unsupported filter operator "${cond.operator}". Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`,
        filter: normalized
      };
    }

    // Validation per operator
    if (cond.operator === 'dateBetween') {
      if (!cond.value || typeof cond.value !== 'object' || Array.isArray(cond.value)) {
        return {
          valid: false,
          error: "dateBetween operator requires a value object with 'from' and 'to'",
          filter: normalized
        };
      }
      const rawFrom = cond.value.from;
      const rawTo = cond.value.to;
      if (rawFrom === undefined || rawFrom === null || String(rawFrom).trim() === '') {
        return {
          valid: false,
          error: "dateBetween filter requires 'from' date",
          filter: normalized
        };
      }
      if (rawTo === undefined || rawTo === null || String(rawTo).trim() === '') {
        return {
          valid: false,
          error: "dateBetween filter requires 'to' date",
          filter: normalized
        };
      }

      const valFrom = validateStrictIsoDate(rawFrom);
      if (!valFrom.valid) {
        return {
          valid: false,
          error: `dateBetween 'from' date must be a valid date in YYYY-MM-DD format (${valFrom.error})`,
          filter: normalized
        };
      }

      const valTo = validateStrictIsoDate(rawTo);
      if (!valTo.valid) {
        return {
          valid: false,
          error: `dateBetween 'to' date must be a valid date in YYYY-MM-DD format (${valTo.error})`,
          filter: normalized
        };
      }

      if (valFrom.dateStr > valTo.dateStr) {
        return {
          valid: false,
          error: `dateBetween 'from' date (${valFrom.dateStr}) cannot be after 'to' date (${valTo.dateStr})`,
          filter: normalized
        };
      }

      validatedConditions.push({
        field: cond.field,
        operator: 'dateBetween',
        value: {
          from: valFrom.dateStr,
          to: valTo.dateStr
        }
      });
    } else {
      // 'contains' or 'equals'
      if (!cond._hasValue || cond.value === undefined || cond.value === null || String(cond.value).trim() === '') {
        return {
          valid: false,
          error: 'Filter value cannot be empty',
          filter: normalized
        };
      }
      validatedConditions.push({
        field: cond.field,
        operator: cond.operator,
        value: String(cond.value).trim()
      });
    }
  }

  const validFilter = {
    matchMode: normalized.matchMode,
    conditions: validatedConditions
  };

  if (validatedConditions.length === 1) {
    validFilter.field = validatedConditions[0].field;
    validFilter.operator = validatedConditions[0].operator;
    validFilter.value = validatedConditions[0].value;
  }

  return {
    valid: true,
    error: null,
    filter: validFilter
  };
}

const EXTENDED_OPS = new Set([
  'contains', 'includes', 'equals', 'eq', '==', '===', 'not_equals', 'neq', '!=',
  'starts_with', 'ends_with', 'in', 'one_of', 'not_in',
  'greater_than', 'gt', '>', 'after', 'date_after', 'date_gt',
  'greater_than_or_equal', 'gte', '>=', 'on_or_after', 'date_on_or_after', 'date_gte',
  'less_than', 'lt', '<', 'before', 'date_before', 'date_lt',
  'less_than_or_equal', 'lte', '<=', 'on_or_before', 'date_on_or_before', 'date_lte',
  'date_between', 'between_dates', 'last_n_days'
]);

/**
 * Validates a filter object, accepting both core contract operators and extended operators
 * supported by ConditionEvaluator (relational numbers, comparisons, advanced dates).
 *
 * @param {any} rawFilter
 * @returns {{ valid: boolean, error: string|null, filter: any }}
 */
function validateFilterWithExtendedOps(rawFilter) {
  if (rawFilter && typeof rawFilter === 'object') {
    if ((rawFilter.field || rawFilter.column) && !rawFilter.operator && (rawFilter.value !== undefined || rawFilter.text !== undefined)) {
      rawFilter = Object.assign({}, rawFilter, { operator: 'equals' });
    }
    if (Array.isArray(rawFilter.conditions)) {
      const hasMissingOp = rawFilter.conditions.some(c => c && (c.field || c.column) && !c.operator);
      if (hasMissingOp) {
        rawFilter = Object.assign({}, rawFilter, {
          conditions: rawFilter.conditions.map(c => (c && (c.field || c.column) && !c.operator) ? Object.assign({}, c, { operator: 'equals' }) : c)
        });
      }
    }
  }

  const filterValidation = validateItemFilter(rawFilter);
  if (filterValidation.valid) {
    return filterValidation;
  }

  const isOperatorError = filterValidation.error && filterValidation.error.includes('Unsupported filter operator');
  if (isOperatorError && rawFilter) {
    const { ConditionEvaluator } = require('./condition-evaluator');
    const normalizedConditions = ConditionEvaluator.normalizeConditions(rawFilter);
    const isSupported = Boolean(
      normalizedConditions.rules.length > 0 &&
      normalizedConditions.rules.every(r => r.field && EXTENDED_OPS.has(String(r.operator || '').toLowerCase().trim()))
    );
    if (isSupported) {
      return { valid: true, error: null, filter: rawFilter };
    }
  }

  return filterValidation;
}

/**
 * Normalizes filter candidate shapes from workflows, runs, or preflight options.
 */
function normalizeFilterCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.itemFilter && typeof raw.itemFilter === 'object') return normalizeFilterCandidate(raw.itemFilter);
  if (raw.item_filter && typeof raw.item_filter === 'object') return normalizeFilterCandidate(raw.item_filter);
  if (raw.filter && typeof raw.filter === 'object' && (raw.filter.field || raw.filter.conditions || raw.filter.column)) {
    return normalizeFilterCandidate(raw.filter);
  }

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(raw));
  } catch {
    clone = Object.assign({}, raw);
  }

  if (Array.isArray(clone.conditions) && clone.conditions.length > 0) {
    clone.conditions = clone.conditions.map(c => {
      const field = c.field || c.column || c.header || '';
      const operator = c.operator || 'equals';
      return {
        ...c,
        field,
        operator,
        value: c.value !== undefined ? c.value : ''
      };
    });
    return clone;
  }

  if (clone.field || clone.column || clone.header) {
    const field = clone.field || clone.column || clone.header;
    const operator = clone.operator || 'equals';
    return {
      matchMode: clone.matchMode || 'all',
      conditions: [{ field, operator, value: clone.value !== undefined ? clone.value : (clone.text || '') }],
      field,
      operator,
      value: clone.value !== undefined ? clone.value : (clone.text || '')
    };
  }

  if (clone.value !== undefined || clone.text !== undefined) {
    const field = clone.column || clone.field || 'Type';
    const operator = clone.operator || 'contains';
    const val = clone.value !== undefined ? clone.value : clone.text;
    return {
      matchMode: clone.matchMode || 'all',
      conditions: [{ field, operator, value: val }],
      field,
      operator,
      value: val
    };
  }

  return null;
}

/**
 * Resolves and validates an item filter from candidate sources (run, workflow, options).
 */
function resolveItemFilter(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;

    const candidates = [
      src.itemFilter,
      src.item_filter,
      src.rowFilter,
      src.row_filter,
      src.filter,
      src.loop?.filter,
      src.loop?.itemFilter,
      src.loop?.item_filter,
      src.loop?.conditions ? { conditions: src.loop.conditions, matchMode: src.loop.matchMode || 'all' } : null,
      src.filter_rules?.itemFilter,
      src.filter_rules?.item_filter,
      src.filter_rules?.filter,
      src.filter_rules?.conditions ? { conditions: src.filter_rules.conditions, matchMode: src.filter_rules.matchMode || 'all' } : null,
      src.filter_rules,
      src.conditions ? { conditions: src.conditions, matchMode: src.matchMode || 'all' } : null,
      src.workflow_definition?.itemFilter,
      src.workflow_definition?.item_filter,
      src.workflow_definition?.rowFilter,
      src.workflow_definition?.filter,
      src.workflow_definition?.loop?.filter,
      src.workflow_definition?.loop?.itemFilter,
      src.workflow_definition?.filter_rules?.itemFilter,
      src.workflow_definition?.filter_rules?.conditions ? { conditions: src.workflow_definition.filter_rules.conditions, matchMode: src.workflow_definition.filter_rules.matchMode || 'all' } : null,
      src.workflow_definition?.filter_rules,
      src.filterValue ? { column: src.filterColumn || 'Type', value: src.filterValue, operator: 'contains' } : null
    ];

    for (const cand of candidates) {
      if (!cand || typeof cand !== 'object') continue;
      const normalized = normalizeFilterCandidate(cand);
      if (normalized) {
        const validation = validateFilterWithExtendedOps(normalized);
        if (validation.valid) {
          return validation.filter;
        }
      }
    }
  }
  return null;
}

/**
 * Extracts available fields from a map or list of items.
 *
 * @param {object|Map|Array} source - An item fields map or list of item objects.
 * @returns {string[]} - Array of unique field names.
 */
function extractAvailableFields(source) {
  if (!source) return [];

  const fieldSet = new Set();

  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item) continue;
      const fields = item.fields || item;
      if (fields instanceof Map) {
        for (const k of fields.keys()) {
          const trimmed = String(k).trim();
          if (trimmed) fieldSet.add(trimmed);
        }
      } else if (typeof fields === 'object') {
        for (const k of Object.keys(fields)) {
          const trimmed = String(k).trim();
          if (trimmed) fieldSet.add(trimmed);
        }
      }
    }
  } else if (source instanceof Map) {
    for (const k of source.keys()) {
      const trimmed = String(k).trim();
      if (trimmed) fieldSet.add(trimmed);
    }
  } else if (typeof source === 'object') {
    for (const k of Object.keys(source)) {
      const trimmed = String(k).trim();
      if (trimmed) fieldSet.add(trimmed);
    }
  }

  return Array.from(fieldSet);
}

/**
 * Looks up a field in a fields map with whitespace-trimmed, case-insensitive comparison.
 *
 * @param {object|Map} fieldsMap - Field names to values.
 * @param {string} targetField - Target field name to resolve.
 * @returns {{ found: boolean, matchedField: string|null, value: any, availableFields: string[] }}
 */
function resolveFieldValue(fieldsMap, targetField) {
  const availableFields = [];
  if (!fieldsMap || typeof fieldsMap !== 'object') {
    return { found: false, matchedField: null, value: undefined, availableFields };
  }

  // If passed a discovered item object with a .fields dictionary, unwrap to fields
  if (!(fieldsMap instanceof Map) && fieldsMap.fields && typeof fieldsMap.fields === 'object') {
    fieldsMap = fieldsMap.fields;
  }

  const normalizedTarget = String(targetField).trim().toLowerCase();
  let exactMatch = null;
  let caseInsensitiveMatch = null;

  if (fieldsMap instanceof Map) {
    for (const [key, val] of fieldsMap.entries()) {
      const strKey = String(key).trim();
      if (strKey) availableFields.push(strKey);
      if (strKey === String(targetField).trim() && exactMatch === null) {
        exactMatch = { matchedField: strKey, value: val };
      } else if (strKey.toLowerCase() === normalizedTarget && caseInsensitiveMatch === null) {
        caseInsensitiveMatch = { matchedField: strKey, value: val };
      }
    }
  } else {
    for (const key of Object.keys(fieldsMap)) {
      const strKey = String(key).trim();
      if (strKey) availableFields.push(strKey);
      if (strKey === String(targetField).trim() && exactMatch === null) {
        exactMatch = { matchedField: strKey, value: fieldsMap[key] };
      } else if (strKey.toLowerCase() === normalizedTarget && caseInsensitiveMatch === null) {
        caseInsensitiveMatch = { matchedField: strKey, value: fieldsMap[key] };
      }
    }
  }

  const matched = exactMatch || caseInsensitiveMatch;
  if (matched) {
    return {
      found: true,
      matchedField: matched.matchedField,
      value: matched.value,
      availableFields
    };
  }

  return {
    found: false,
    matchedField: null,
    value: undefined,
    availableFields
  };
}

/**
 * Evaluates a single condition against an item's fields map.
 * Distinguishes Case A (configured field unavailable) from Case B (field exists, missing/unparseable value).
 *
 * @param {object} cond - Validated condition { field, operator, value }.
 * @param {object|Map} fieldsMap - Map of field names to values.
 * @returns {object} Condition evaluation result.
 */
function evaluateSingleCondition(cond, fieldsMap) {
  const resolved = resolveFieldValue(fieldsMap, cond.field);

  // Case A: Configured field was not found in item's schema (evaluation/configuration error)
  if (!resolved.found) {
    const availStr = resolved.availableFields.length > 0
      ? ` (available fields: ${resolved.availableFields.map(f => `"${f}"`).join(', ')})`
      : ' (no fields available on item)';
    return {
      matches: false,
      field: cond.field,
      expectedValue: cond.value,
      actualValue: null,
      operator: cond.operator,
      reason: `Configured field "${cond.field}" was not found in available item fields${availStr}`,
      error: `Configured field "${cond.field}" is not available on item`
    };
  }

  const actualRaw = resolved.value;
  const actualStr = actualRaw !== undefined && actualRaw !== null ? String(actualRaw).trim() : '';

  if (cond.operator === 'equals') {
    const expectedStr = String(cond.value).trim();
    const matches = actualStr.toLowerCase() === expectedStr.toLowerCase();
    const reason = matches
      ? `Field "${resolved.matchedField}" ("${actualStr}") equals "${expectedStr}"`
      : `Field "${resolved.matchedField}" is "${actualStr}" (does not equal "${expectedStr}")`;
    return {
      matches,
      field: resolved.matchedField,
      expectedValue: expectedStr,
      actualValue: actualRaw !== undefined && actualRaw !== null ? String(actualRaw) : '',
      operator: 'equals',
      reason,
      error: null
    };
  }

  if (cond.operator === 'contains') {
    const expectedStr = String(cond.value).trim();
    const matches = actualStr.toLowerCase().includes(expectedStr.toLowerCase());
    const reason = matches
      ? `Field "${resolved.matchedField}" ("${actualStr}") contains "${expectedStr}"`
      : `Field "${resolved.matchedField}" is "${actualStr}" (does not contain "${expectedStr}")`;
    return {
      matches,
      field: resolved.matchedField,
      expectedValue: expectedStr,
      actualValue: actualRaw !== undefined && actualRaw !== null ? String(actualRaw) : '',
      operator: 'contains',
      reason,
      error: null
    };
  }

  if (cond.operator === 'dateBetween') {
    const from = cond.value.from;
    const to = cond.value.to;
    const parsed = parseSourceDate(actualRaw);

    // Case B: field exists, but value is missing or unparseable
    if (!parsed.valid) {
      if (parsed.missing) {
        return {
          matches: false,
          field: resolved.matchedField,
          expectedValue: cond.value,
          actualValue: actualRaw !== undefined && actualRaw !== null ? String(actualRaw) : '',
          operator: 'dateBetween',
          reason: `Field "${resolved.matchedField}" has missing or empty date value (cannot evaluate dateBetween)`,
          error: null
        };
      }
      return {
        matches: false,
        field: resolved.matchedField,
        expectedValue: cond.value,
        actualValue: actualRaw !== undefined && actualRaw !== null ? String(actualRaw) : '',
        operator: 'dateBetween',
        reason: `Field "${resolved.matchedField}" value "${actualStr}" is not a valid date in YYYY-MM-DD format (cannot evaluate dateBetween)`,
        error: null
      };
    }

    const itemDate = parsed.dateStr;
    const matches = itemDate >= from && itemDate <= to;
    const reason = matches
      ? `Field "${resolved.matchedField}" ("${itemDate}") is between "${from}" and "${to}" (inclusive)`
      : `Field "${resolved.matchedField}" is "${itemDate}" (not between "${from}" and "${to}")`;

    return {
      matches,
      field: resolved.matchedField,
      expectedValue: cond.value,
      actualValue: actualRaw !== undefined && actualRaw !== null ? String(actualRaw) : '',
      operator: 'dateBetween',
      reason,
      error: null
    };
  }

  return {
    matches: false,
    field: resolved.matchedField,
    expectedValue: cond.value,
    actualValue: actualStr,
    operator: cond.operator,
    reason: `Unsupported operator "${cond.operator}"`,
    error: `Unsupported filter operator "${cond.operator}"`
  };
}

/**
 * Pure evaluator for itemFilter against an item's fields map.
 * Supports single condition or compound conditions (all/any).
 *
 * @param {any} filterInput - Raw or normalized filter input.
 * @param {object|Map} fieldsMap - Map of field names to values for a discovered item.
 * @returns {{
 *   matches: boolean,
 *   field: string|null,
 *   expectedValue: any,
 *   actualValue: string|null,
 *   operator: string|null,
 *   matchMode: string|null,
 *   conditionResults: Array<object>,
 *   reason: string,
 *   error: string|null
 * }}
 */
function evaluateItemFilter(filterInput, fieldsMap) {
  // 1. Validate filter shape and parameters
  const validation = validateItemFilter(filterInput);

  if (!validation.valid) {
    return {
      matches: false,
      field: validation.filter ? validation.filter.field : null,
      expectedValue: validation.filter ? validation.filter.value : null,
      actualValue: null,
      operator: validation.filter ? validation.filter.operator : null,
      matchMode: validation.filter ? validation.filter.matchMode : null,
      conditionResults: [],
      reason: `Filter validation error: ${validation.error}`,
      error: validation.error
    };
  }

  const filter = validation.filter;

  // 2. Omitting itemFilter means match all
  if (filter === null) {
    return {
      matches: true,
      field: null,
      expectedValue: null,
      actualValue: null,
      operator: null,
      matchMode: null,
      conditionResults: [],
      reason: 'All items accepted (no filter configured)',
      error: null
    };
  }

  // 3. Evaluate each condition
  const conditionResults = filter.conditions.map(c => evaluateSingleCondition(c, fieldsMap));

  // Check if any condition had a configuration error (Case A: missing configured field)
  const firstError = conditionResults.find(r => r.error !== null);
  if (firstError) {
    return {
      matches: false,
      field: firstError.field,
      expectedValue: firstError.expectedValue,
      actualValue: firstError.actualValue,
      operator: firstError.operator,
      matchMode: filter.matchMode,
      conditionResults,
      reason: firstError.reason,
      error: firstError.error
    };
  }

  // 4. Combine results based on matchMode
  let matches = false;
  let reason = '';

  if (filter.matchMode === 'any') {
    matches = conditionResults.some(r => r.matches);
    if (filter.conditions.length === 1) {
      reason = conditionResults[0].reason;
    } else if (matches) {
      const passing = conditionResults.filter(r => r.matches);
      reason = `${passing.length} of ${conditionResults.length} condition(s) matched: ${passing.map(r => r.reason).join('; ')}`;
    } else {
      reason = `No conditions matched (mode: any): ${conditionResults.map(r => r.reason).join('; ')}`;
    }
  } else {
    // 'all'
    matches = conditionResults.every(r => r.matches);
    if (filter.conditions.length === 1) {
      reason = conditionResults[0].reason;
    } else if (matches) {
      reason = `All ${conditionResults.length} conditions matched: ${conditionResults.map(r => r.reason).join('; ')}`;
    } else {
      const failing = conditionResults.filter(r => !r.matches);
      reason = `${failing.length} of ${conditionResults.length} condition(s) failed: ${failing.map(r => r.reason).join('; ')}`;
    }
  }

  const res = {
    matches,
    matchMode: filter.matchMode,
    conditionResults,
    reason,
    error: null
  };

  // Provide convenience single-condition properties for backward compatibility
  if (conditionResults.length === 1) {
    res.field = conditionResults[0].field;
    res.expectedValue = conditionResults[0].expectedValue;
    res.actualValue = conditionResults[0].actualValue;
    res.operator = conditionResults[0].operator;
  } else {
    res.field = null;
    res.expectedValue = null;
    res.actualValue = null;
    res.operator = null;
  }

  return res;
}

/**
 * Computes preview evaluation for a collection of discovered items.
 * Implements filtering before limit selection, and reports item-level skips and limits.
 *
 * @param {any} filterInput - Raw or normalized filter input.
 * @param {Array<object>} items - List of items with fields: `{ index, fields, ... }` or array of fields maps.
 * @param {object} [options] - Options (e.g. previewLimit, loopLimit).
 * @returns {{
 *   totalCount: number,
 *   matchingCount: number,
 *   selectedCount: number,
 *   skippedFilterCount: number,
 *   skippedLimitCount: number,
 *   skippedCount: number,
 *   selectedPreview: Array<object>,
 *   skippedFilterPreview: Array<object>,
 *   skippedLimitPreview: Array<object>,
 *   skippedPreview: Array<object>,
 *   availableFields: string[],
 *   errors: string[]
 * }}
 */
function evaluateFilterPreview(filterInput, items = [], options = {}) {
  const previewLimit = Number.isInteger(options?.previewLimit) ? Math.max(1, options.previewLimit) : 5;
  const availableFields = extractAvailableFields(items);
  const errorsSet = new Set();

  // Validate filterInput initially
  const filterValidation = validateItemFilter(filterInput);
  if (!filterValidation.valid) {
    errorsSet.add(filterValidation.error);
  }

  // Determine loopLimit from options or filterInput envelope
  const rawLimit = options?.loopLimit !== undefined
    ? options.loopLimit
    : (options?.limit !== undefined
      ? options.limit
      : (filterInput && typeof filterInput === 'object' && 'loopLimit' in filterInput
        ? filterInput.loopLimit
        : undefined));

  let effectiveLimit = null; // null means unlimited
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0) {
      effectiveLimit = rawLimit;
    } else if (typeof rawLimit === 'string' && /^\d+$/.test(rawLimit.trim()) && parseInt(rawLimit.trim(), 10) > 0) {
      effectiveLimit = parseInt(rawLimit.trim(), 10);
    } else {
      effectiveLimit = 'INVALID';
      errorsSet.add('Invalid loopLimit: must be a positive integer');
    }
  }

  let matchingCount = 0;
  let selectedCount = 0;
  let skippedFilterCount = 0;
  let skippedLimitCount = 0;

  const selectedPreview = [];
  const skippedFilterPreview = [];
  const skippedLimitPreview = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fieldsMap = item && typeof item === 'object' && ('fields' in item) ? item.fields : item;
    const result = evaluateItemFilter(filterInput, fieldsMap);

    if (result.error) {
      const isMissingFieldErr = typeof result.error === 'string' && result.error.includes('is not available on item');
      const normField = String(filterInput?.field || filterInput?.column || '').trim().toLowerCase();
      const isFieldPresentInCollection = Boolean(normField && availableFields.some(f => f.toLowerCase() === normField));
      if (!isMissingFieldErr || !isFieldPresentInCollection) {
        errorsSet.add(result.error);
      }
    }

    const itemIndex = Number.isInteger(item?.index) ? item.index : i;
    const itemLabel = item?.label || item?.itemLabel || `Item #${i + 1}`;

    if (!result.matches) {
      skippedFilterCount++;
      const previewEntry = {
        index: itemIndex,
        label: itemLabel,
        field: result.field,
        actualValue: result.actualValue,
        reason: result.reason,
        status: 'SKIPPED_FILTER'
      };
      if (skippedFilterPreview.length < previewLimit) {
        skippedFilterPreview.push(previewEntry);
      }
    } else {
      // Matches filter!
      matchingCount++;

      if (effectiveLimit === 'INVALID') {
        skippedLimitCount++;
        const previewEntry = {
          index: itemIndex,
          label: itemLabel,
          field: result.field,
          actualValue: result.actualValue,
          reason: 'Item matched filter but could not be selected due to invalid loopLimit',
          status: 'SKIPPED_LIMIT'
        };
        if (skippedLimitPreview.length < previewLimit) {
          skippedLimitPreview.push(previewEntry);
        }
      } else if (effectiveLimit === null || selectedCount < effectiveLimit) {
        selectedCount++;
        const previewEntry = {
          index: itemIndex,
          label: itemLabel,
          field: result.field,
          actualValue: result.actualValue,
          reason: result.reason,
          status: 'SELECTED'
        };
        if (selectedPreview.length < previewLimit) {
          selectedPreview.push(previewEntry);
        }
      } else {
        // Exceeds limit
        skippedLimitCount++;
        const previewEntry = {
          index: itemIndex,
          label: itemLabel,
          field: result.field,
          actualValue: result.actualValue,
          reason: `Item matched filter but was skipped because loopLimit of ${effectiveLimit} was reached`,
          status: 'SKIPPED_LIMIT'
        };
        if (skippedLimitPreview.length < previewLimit) {
          skippedLimitPreview.push(previewEntry);
        }
      }
    }
  }

  return {
    totalCount: items.length,
    matchingCount,
    selectedCount,
    skippedFilterCount,
    skippedLimitCount,
    skippedCount: skippedFilterCount + skippedLimitCount,
    selectedPreview,
    skippedFilterPreview,
    skippedLimitPreview,
    skippedPreview: skippedFilterPreview,
    availableFields,
    errors: Array.from(errorsSet)
  };
}

module.exports = {
  SUPPORTED_OPERATORS,
  SUPPORTED_MATCH_MODES,
  normalizeItemFilter,
  normalizeFilter: normalizeItemFilter,
  validateItemFilter,
  validateFilter: validateItemFilter,
  validateFilterWithExtendedOps,
  evaluateItemFilter,
  evaluateFilter: evaluateItemFilter,
  evaluateFilterPreview,
  extractAvailableFields,
  resolveFieldValue,
  validateStrictIsoDate,
  parseSourceDate,
  normalizeFilterCandidate,
  resolveItemFilter,
  ItemFilter: {
    SUPPORTED_OPERATORS,
    SUPPORTED_MATCH_MODES,
    normalize: normalizeItemFilter,
    validate: validateItemFilter,
    validateWithExtendedOps: validateFilterWithExtendedOps,
    evaluate: evaluateItemFilter,
    evaluatePreview: evaluateFilterPreview,
    extractFields: extractAvailableFields,
    resolveItemFilter,
    normalizeFilterCandidate
  }
};
