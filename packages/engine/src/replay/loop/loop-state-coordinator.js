/**
 * src/replay/loop/loop-state-coordinator.js
 * Tracks loop execution indices, batch counters, limits, filter normalization,
 * and checkpoint persistence.
 */

const fs = require('fs');
const path = require('path');
const { validateItemFilter } = require('../../shared/item-filter');
const { ConditionEvaluator } = require('../../shared/condition-evaluator');
const { getSafeStoragePath } = require('../../utils/storage-helper');

class LoopStateCoordinator {
  constructor(options = {}) {
    this.runId = options.runId || `run_${Date.now()}`;
    this.workflowId = options.workflowId || null;
    this.workflowName = options.workflowName || 'workflow';
    const safeBaseRecordings = options.baseRecordingsDir || (
      options.structuredDownloadsDir ? path.join(path.dirname(options.structuredDownloadsDir), 'recordings') : null
    ) || getSafeStoragePath('recordings');
    this.runsDir = options.runsDir || path.join(safeBaseRecordings, 'runs', this.runId);
    this.resumeFromCheckpoint = options.resumeFromCheckpoint === true;
    this.itemMode = ['new', 'old', 'all'].includes(options.itemMode) ? options.itemMode : 'new';
    this.maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : null;
    this.maxItemRetries = Number.isInteger(options.maxItemRetries) ? Math.max(0, options.maxItemRetries) : 1;
    this._lastCursor = null;

    // Filter normalization & validation
    const rawFilter = options.itemFilter !== undefined
      ? options.itemFilter
      : (options.rowFilter || (options.filterValue ? { column: options.filterColumn || 'Type', value: options.filterValue } : null));
    const filterValidation = validateItemFilter(rawFilter);

    // Support relational, date, and extended operators via ConditionEvaluator
    const normalizedConditions = ConditionEvaluator.normalizeConditions(rawFilter);
    const EXTENDED_OPS = new Set([
      'contains', 'includes', 'equals', 'eq', '==', '===', 'not_equals', 'neq', '!=',
      'starts_with', 'ends_with', 'in', 'one_of', 'not_in',
      'greater_than', 'gt', '>', 'after', 'date_after', 'date_gt',
      'greater_than_or_equal', 'gte', '>=', 'on_or_after', 'date_on_or_after', 'date_gte',
      'less_than', 'lt', '<', 'before', 'date_before', 'date_lt',
      'less_than_or_equal', 'lte', '<=', 'on_or_before', 'date_on_or_before', 'date_lte',
      'date_between', 'between_dates', 'last_n_days'
    ]);
    const isSupportedByConditionEvaluator = Boolean(
      rawFilter &&
      normalizedConditions.rules.length > 0 &&
      normalizedConditions.rules.every(r => r.field && EXTENDED_OPS.has(String(r.operator || '').toLowerCase().trim()))
    );

    const isOperatorError = filterValidation.error && filterValidation.error.includes('Unsupported filter operator');
    if (filterValidation.valid) {
      this.itemFilter = filterValidation.filter;
      this.filterValidationError = null;
    } else if (isOperatorError && isSupportedByConditionEvaluator) {
      this.itemFilter = rawFilter;
      this.filterValidationError = null;
    } else {
      this.itemFilter = options.itemFilter || null;
      this.filterValidationError = filterValidation.error;
    }

    let validatedLimit = null;
    let limitError = null;
    if (options.loopLimit !== undefined && options.loopLimit !== null) {
      if (typeof options.loopLimit === 'number' && Number.isInteger(options.loopLimit) && options.loopLimit > 0) {
        validatedLimit = options.loopLimit;
      } else if (typeof options.loopLimit === 'string' && /^\d+$/.test(options.loopLimit.trim()) && parseInt(options.loopLimit.trim(), 10) > 0) {
        validatedLimit = parseInt(options.loopLimit.trim(), 10);
      } else {
        limitError = 'Invalid loopLimit: must be a positive integer';
      }
    }
    this.loopLimit = validatedLimit;
    this.loopLimitError = limitError;
    this.rowFilter = options.itemFilter || options.rowFilter || null;
  }

  createStandardManifest(workflow, stepsCount = 0) {
    return {
      runId: this.runId,
      workflowId: workflow.id,
      mode: 'STANDARD',
      startTime: new Date().toISOString(),
      status: 'RUNNING',
      itemsTotal: stepsCount,
      itemsSucceeded: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      results: [],
      downloadedFiles: []
    };
  }

  createLoopManifest(workflow) {
    return {
      runId: this.runId,
      workflowId: workflow.id,
      mode: 'LOOP',
      startTime: new Date().toISOString(),
      status: 'RUNNING',
      itemsTotal: 0,
      itemsSucceeded: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      matchingCount: 0,
      selectedCount: 0,
      skippedFilterCount: 0,
      skippedLimitCount: 0,
      skippedDuplicateCount: 0,
      matching: 0,
      selected: 0,
      skippedFilter: 0,
      skippedLimit: 0,
      skippedDuplicate: 0,
      itemFilter: this.itemFilter,
      loopLimit: this.loopLimit,
      results: [],
      downloadedFiles: []
    };
  }

  applyCheckpoint(manifest, checkpoint) {
    if (!checkpoint) return;
    manifest.results = Array.isArray(checkpoint.results) ? checkpoint.results : [];
    manifest.itemsSucceeded = checkpoint.itemsSucceeded ?? manifest.results.filter(r => r.status === 'SUCCESS').length;
    manifest.itemsFailed = checkpoint.itemsFailed ?? manifest.results.filter(r => r.status === 'FAILED').length;
    manifest.skippedFilterCount = checkpoint.skippedFilterCount ?? manifest.results.filter(r => r.status === 'SKIPPED_FILTER').length;
    manifest.skippedLimitCount = checkpoint.skippedLimitCount ?? manifest.results.filter(r => r.status === 'SKIPPED_LIMIT').length;
    manifest.skippedDuplicateCount = checkpoint.skippedDuplicateCount ?? manifest.results.filter(r => r.status === 'SKIPPED_DUPLICATE').length;
    manifest.itemsSkipped = manifest.skippedFilterCount + manifest.skippedLimitCount + manifest.skippedDuplicateCount;
    manifest.matchingCount = checkpoint.matchingCount ?? (manifest.results.length - manifest.skippedFilterCount);
    manifest.selectedCount = checkpoint.selectedCount ?? (manifest.itemsSucceeded + manifest.itemsFailed);
    manifest.matching = manifest.matchingCount;
    manifest.selected = manifest.selectedCount;
    manifest.skippedFilter = manifest.skippedFilterCount;
    manifest.skippedLimit = manifest.skippedLimitCount;
    manifest.skippedDuplicate = manifest.skippedDuplicateCount;
    manifest.downloadedFiles = checkpoint.downloadedFiles || [];
    manifest.pagesProcessed = checkpoint.pagesProcessed || 1;
    manifest.itemsTotal = checkpoint.itemsTotal || 0;
    manifest.activeItem = checkpoint.activeItem || null;
  }

  extractCursor(checkpoint) {
    if (!checkpoint) return null;
    return {
      currentItemIndex: checkpoint.currentItemIndex ?? null,
      currentActionOffset: checkpoint.currentActionOffset ?? null,
      currentPage: checkpoint.currentPage ?? 1,
      currentPageItemIndex: checkpoint.currentPageItemIndex ?? null,
      activeItem: checkpoint.activeItem ?? null
    };
  }

  writeLoopCheckpoint(
    manifest,
    currentItemIndex = null,
    currentActionOffset = null,
    currentPage = 1,
    currentPageItemIndex = null,
    activeItem = null
  ) {
    this._lastCursor = {
      currentItemIndex,
      currentActionOffset,
      currentPage,
      currentPageItemIndex,
      activeItem
    };
    const checkpoint = {
      runId: manifest.runId,
      workflowId: manifest.workflowId,
      mode: manifest.mode,
      status: manifest.status,
      currentPage,
      currentPageItemIndex,
      currentItemIndex,
      currentActionOffset,
      completedItemIndexes: (manifest.results || [])
        .filter(result => result.status === 'SUCCESS')
        .map(result => result.index),
      itemsSucceeded: manifest.itemsSucceeded,
      itemsFailed: manifest.itemsFailed,
      itemsSkipped: manifest.itemsSkipped || 0,
      matchingCount: manifest.matchingCount || 0,
      selectedCount: manifest.selectedCount || 0,
      skippedFilterCount: manifest.skippedFilterCount || 0,
      skippedLimitCount: manifest.skippedLimitCount || 0,
      skippedDuplicateCount: manifest.skippedDuplicateCount || 0,
      matching: manifest.matchingCount || 0,
      selected: manifest.selectedCount || 0,
      skippedFilter: manifest.skippedFilterCount || 0,
      skippedLimit: manifest.skippedLimitCount || 0,
      skippedDuplicate: manifest.skippedDuplicateCount || 0,
      pagesProcessed: manifest.pagesProcessed || currentPage,
      itemsTotal: manifest.itemsTotal,
      results: manifest.results,
      downloadedFiles: manifest.downloadedFiles,
      activeItem,
      updatedAt: new Date().toISOString()
    };
    try {
      if (!fs.existsSync(this.runsDir)) fs.mkdirSync(this.runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.runsDir, 'checkpoint.json'),
        JSON.stringify(checkpoint, null, 2)
      );
    } catch (err) {
      logger.warn(`[LoopStateCoordinator] Could not write checkpoint: ${err.message}`);
    }
  }

  persistManifest(manifest) {
    if (!manifest) return;
    try {
      if (!fs.existsSync(this.runsDir)) fs.mkdirSync(this.runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.runsDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );
    } catch (err) {
      logger.warn(`[LoopStateCoordinator] Could not write manifest: ${err.message}`);
    }
  }

  loadLoopCheckpoint(workflow) {
    if (!this.resumeFromCheckpoint) return null;

    const checkpointPath = path.join(this.runsDir, 'checkpoint.json');
    if (!fs.existsSync(checkpointPath)) return null;

    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

      if (
        checkpoint.runId !== this.runId ||
        checkpoint.workflowId !== workflow.id ||
        checkpoint.mode !== 'LOOP'
      ) {
        logger.warn('[LoopStateCoordinator] Existing checkpoint does not match this run/workflow. Starting fresh.');
        return null;
      }

      logger.info(
        '[LoopStateCoordinator] Resuming checkpoint: page ' +
        (checkpoint.currentPage || 1) +
        ', item ' +
        (checkpoint.currentPageItemIndex == null ? '-' : checkpoint.currentPageItemIndex + 1) +
        ', action offset ' +
        (checkpoint.currentActionOffset || 0)
      );

      return checkpoint;
    } catch (err) {
      logger.warn('[LoopStateCoordinator] Could not read checkpoint. Starting fresh: ' + err.message);
      return null;
    }
  }
}

module.exports = LoopStateCoordinator;
