/**
 * ReFlow - Intelligent Replay & Batch Execution Runner
 * 
 * Executes standard sequential workflows and generalized loops over table rows,
 * list items, or grids. Manages auto-navigation to target URLs, CDP file download
 * interception, per-item state restoration, and error isolation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ReplayEngine = require('./replay-engine');
const LoopDetector = require('../shared/loop-detector');
const ItemDiscovery = require('../shared/item-discovery');
const ActionGeneralizer = require('../shared/action-generalizer');
const logger = require('../utils/logger');
const { resolveTargetUrl, extractWorkflowStartUrl } = require('../utils/url-helper');
const { getSafeStoragePath, getSafeStorageBase, safeMkdir } = require('../utils/storage-helper');
const {
  normalizeItemFilter,
  validateItemFilter,
  validateFilterWithExtendedOps,
  evaluateItemFilter: sharedEvaluateItemFilter,
  evaluateFilterPreview,
  extractAvailableFields,
  resolveItemFilter
} = require('../shared/item-filter');
const { ConditionEvaluator } = require('../shared/condition-evaluator');
const { PageInspector } = require('../shared/page-inspector');
const DownloadManager = require('./download-manager');
const { detectLoginSequence, isSessionAuthenticated, isLoginAction } = require('../shared/auth-detector');
const ArtifactDownloadManager = require('./loop/artifact-download-manager');
const GridSelectionAdapter = require('./loop/grid-selection-adapter');
const ItemExecutionHandler = require('./loop/item-execution-handler');
const LoopStateCoordinator = require('./loop/loop-state-coordinator');

class LoopReplayRunner {
  constructor(options = {}) {
    this.options = options;
    this.cdpPort = options.cdpPort || 9222;
    this.runId = options.runId || `run_${Date.now()}`;
    this.workflowId = options.workflowId || null;
    this.workflowName = options.workflowName || 'workflow';
    this.forceRedownload = options.forceRedownload === true;
    this.alwaysExportTableCsv = options.alwaysExportTableCsv !== false;
    this.itemMode = ['new', 'old', 'all'].includes(options.itemMode) ? options.itemMode : 'new';
    this.maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : null;

    const safeBaseRecordings = options.baseRecordingsDir || (
      options.structuredDownloadsDir ? path.join(path.dirname(options.structuredDownloadsDir), 'recordings') : null
    ) || getSafeStoragePath('recordings');

    this.runsDir = options.runsDir || path.join(safeBaseRecordings, 'runs', this.runId);
    this.downloadsDir = options.downloadsDir || path.join(this.runsDir, 'downloads');
    this.replayEngine = new ReplayEngine({ cdpPort: this.cdpPort, downloadsDir: this.downloadsDir });
    this.maxItemRetries = Number.isInteger(options.maxItemRetries) ? Math.max(0, options.maxItemRetries) : 1;
    this.resumeFromCheckpoint = options.resumeFromCheckpoint === true;
    this.isAborted = false;

    this.workflow = options.workflow || null;

    // Filter and limit configuration
    const resolvedFilter = resolveItemFilter(options, this.workflow);
    this.itemFilter = resolvedFilter || null;
    this.rowFilter = options.rowFilter || this.itemFilter || null;
    this.filterValidationError = null;

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

    // Two-Level / Nested Loop Configuration (Controlled Two-Level Iteration)
    this.nestedLoop = options.nestedLoop || options.twoLevelLoop || null;
    this.newOnly = options.newOnly === true || options.new_only === true;

    // Unified Loop Configuration
    this.loopConfig = LoopDetector.deriveLoopConfig(
      options.loop ? { loop: options.loop } : (this.workflow || options)
    );
    if (options.loop && typeof options.loop === 'object') {
      this.loopConfig = {
        ...this.loopConfig,
        ...options.loop,
        enabled: options.loop.enabled !== false
      };
    }
    if (this.loopConfig && this.loopConfig.enabled) {
      this.isLoop = true;
      this.mode = 'loop';
      if (Number.isInteger(this.loopConfig.anchorStepIndex)) {
        this.loopStepIndex = this.loopConfig.anchorStepIndex;
      }
      if (Number.isInteger(this.loopConfig.maxItems) && !this.maxItems) {
        this.maxItems = this.loopConfig.maxItems;
      }
    } else if (options.loop && options.loop.enabled === false) {
      this.isLoop = false;
      this.mode = 'single';
      this.loopStepIndex = null;
    } else {
      this.loopStepIndex = Number.isInteger(options.loopStepIndex) ? options.loopStepIndex : (this.loopConfig?.anchorStepIndex ?? null);
      this.isLoop = options.isLoop === true || options.mode === 'loop' || Boolean(this.loopConfig?.enabled);
      this.mode = options.mode || (this.isLoop ? 'loop' : 'single');
    }

    // Structured downloads hierarchy: downloads/<workflow-slug>/<YYYY-MM-DD>/
    const rawSlug = (this.workflowName || this.workflowId || 'workflow').toLowerCase();
    this.workflowSlug = rawSlug.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workflow';
    this.dateStr = new Date().toISOString().split('T')[0];
    const safeBaseDownloads = options.baseDownloadsDir ||
      (options.structuredDownloadsDir ? path.dirname(options.structuredDownloadsDir) : null) ||
      getSafeStorageBase('downloads');

    this.workflowDownloadsBaseDir = path.resolve(safeBaseDownloads, this.workflowSlug);
    this._hasCustomStructuredDir = Boolean(options.structuredDownloadsDir);
    this.structuredDownloadsDir = options.structuredDownloadsDir ? path.resolve(options.structuredDownloadsDir) : path.resolve(this.workflowDownloadsBaseDir, this.dateStr);

    // Primary Run/ hierarchy: Run/<YYYY-MM-DD_HH-mm-ss>/<portalDomain>/<Category>/
    const targetUrl = options.targetUrl || options.portalUrl || this.workflow?.targetUrl || this.workflow?.startUrl || '';
    this.portalDomain = options.portalDomain || this._resolvePortalDomain(targetUrl);

    // Dedicated per-execution downloads isolation: downloads/<workflow-slug>/<execution-id>/
    // + Structured Run/ hierarchy: Run/<YYYY-MM-DD_HH-mm-ss>/<portalDomain>/<Category>/
    this.downloadManager = new DownloadManager({
      workflowSlug: this.workflowSlug,
      executionId: this.runId,
      workflowId: this.workflowId,
      portalDomain: this.portalDomain,
      portalUrl: targetUrl,
      baseDownloadsDir: safeBaseDownloads,
      baseRunDir: options.baseRunDir || (options.structuredDownloadsDir ? path.join(path.dirname(options.structuredDownloadsDir), 'Run') : null),
      runTimestamp: options?.runTimestamp,
      startedAt: options?.startedAt
    });
    this.runTimestamp = this.downloadManager.runTimestamp;
    this.runDomainDir = this.downloadManager.runDomainDir;
    this.executionDownloadsDir = this.downloadManager.getDirectory();
    this.secretResolver = options.secretResolver || null;

    this.artifactDownloadManager = new ArtifactDownloadManager({
      runId: this.runId,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      userId: options.userId,
      forceRedownload: this.forceRedownload,
      runsDir: this.runsDir,
      downloadsDir: this.downloadsDir,
      baseDownloadsDir: safeBaseDownloads,
      baseRecordingsDir: safeBaseRecordings,
      structuredDownloadsDir: this.structuredDownloadsDir,
      targetUrl: targetUrl,
      portalDomain: this.portalDomain,
      runTimestamp: this.runTimestamp,
      startedAt: options?.startedAt
    });

    this.gridSelectionAdapter = new GridSelectionAdapter({
      replayEngine: this.replayEngine
    });

    this.loopStateCoordinator = new LoopStateCoordinator({
      runId: this.runId,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      runsDir: this.runsDir,
      baseRecordingsDir: safeBaseRecordings,
      resumeFromCheckpoint: this.resumeFromCheckpoint,
      itemMode: this.itemMode,
      maxItems: this.maxItems,
      maxItemRetries: this.maxItemRetries,
      itemFilter: this.itemFilter,
      rowFilter: this.rowFilter,
      loopLimit: this.loopLimit
    });

    this.itemExecutionHandler = new ItemExecutionHandler({
      maxItemRetries: this.maxItemRetries,
      gridAdapter: this.gridSelectionAdapter,
      downloadManager: this.artifactDownloadManager,
      stateCoordinator: this.loopStateCoordinator,
      replayEngine: this.replayEngine,
      getIsAborted: () => this.isAborted
    });
  }

  _resolvePortalDomain(targetUrl, fallbackDomain = 'customerportal.usoil.com') {
    if (!targetUrl) return fallbackDomain;
    try {
      const u = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
      return u.hostname || fallbackDomain;
    } catch {
      return targetUrl.replace(/https?:\/\//, '').split('/')[0] || fallbackDomain;
    }
  }

  _applyTargetUrlDomain(targetUrl) {
    const extractedDomain = this._resolvePortalDomain(targetUrl, '');
    if (extractedDomain) {
      this.portalDomain = extractedDomain;
      if (this.downloadManager) {
        this.downloadManager.portalDomain = extractedDomain;
        this.downloadManager.runDomainDir = path.resolve(this.downloadManager.runTimestampDir, extractedDomain);
        if (!fs.existsSync(this.downloadManager.runDomainDir)) {
          try { fs.mkdirSync(this.downloadManager.runDomainDir, { recursive: true }); } catch {}
        }
      }
    }
  }

  /**
   * Abort/stop the current execution immediately
   * @param {boolean} [closePage=false] - Whether to close the active browser tab
   */
  async stop(closePage = false) {
    this.isAborted = true;
    logger.warn(`[Runner] Stop signal triggered for run: ${this.runId}`);
    if (this.replayEngine && typeof this.replayEngine.abort === 'function') {
      await this.replayEngine.abort().catch(() => { });
    }
    if (closePage && this.replayEngine?.page) {
      try {
        if (!this.replayEngine.page.isClosed()) {
          await this.replayEngine.page.close().catch(() => { });
        }
      } catch { }
    }
  }

  /**
   * Start executing a workflow (dispatches to executeLoop or executeStandard)
   * @param {object} workflow - Stored workflow object
   * @param {object} options - Execution options ({ onProgress, loopStepIndex, isLoop, mode })
   */
  async start(workflow, options = {}) {
    if (!workflow) return { success: false, error: 'No workflow provided' };
    const steps = workflow.steps ||
      (workflow.workflow_definition && (workflow.workflow_definition.steps || workflow.workflow_definition.actions)) ||
      (workflow.recordingData && workflow.recordingData.actions) ||
      workflow.actions ||
      [];

    const workflowWithOpts = {
      ...workflow,
      ...(this.isLoop ? { isLoop: this.isLoop, mode: this.mode, loopStepIndex: this.loopStepIndex, loopLimit: this.loopLimit } : {}),
      ...(options.isLoop !== undefined ? { isLoop: options.isLoop } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.loopStepIndex !== undefined ? { loopStepIndex: options.loopStepIndex } : {}),
      ...(options.loopLimit !== undefined ? { loopLimit: options.loopLimit } : {}),
    };
    if (workflow.loop) workflowWithOpts.loop = workflow.loop;
    else if (options.loop) workflowWithOpts.loop = options.loop;
    else if (this.loopConfig?.enabled) workflowWithOpts.loop = this.loopConfig;

    const effectiveConfig = LoopDetector.deriveLoopConfig(
      workflowWithOpts,
      steps
    );
    this.loopConfig = effectiveConfig;

    if (!effectiveConfig.enabled) {
      return this.executeStandard(workflow, options.onProgress);
    }

    // Validate loop configuration BEFORE browser connection
    const validation = LoopDetector.validateLoopConfig(effectiveConfig, steps.length);
    if (!validation.valid) {
      throw new Error(`Invalid loop configuration: ${validation.error}`);
    }

    return this.executeLoop(workflow, effectiveConfig.anchorStepIndex, options.onProgress);
  }

  _persistManifest(manifest) {
    if (!manifest) return;
    if (this.loopStateCoordinator && typeof this.loopStateCoordinator.persistManifest === 'function') {
      try { this.loopStateCoordinator.persistManifest(manifest); } catch {}
    } else {
      try {
        if (!fs.existsSync(this.runsDir)) fs.mkdirSync(this.runsDir, { recursive: true });
        fs.writeFileSync(path.join(this.runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch {}
    }
  }

  _syncSubManagers() {
    if (this.artifactDownloadManager) {
      this.artifactDownloadManager.workflowId = this.workflowId;
      this.artifactDownloadManager.workflowName = this.workflowName;
      this.artifactDownloadManager.workflowSlug = this.workflowSlug;
      this.artifactDownloadManager.workflowDownloadsBaseDir = this.workflowDownloadsBaseDir;
      this.artifactDownloadManager.structuredDownloadsDir = this.structuredDownloadsDir;
      this.artifactDownloadManager.downloadsDir = this.downloadsDir;
      this.artifactDownloadManager.runsDir = this.runsDir;
      this.artifactDownloadManager.forceRedownload = this.forceRedownload;
      if (this.portalDomain) {
        this.artifactDownloadManager.setPortalDomain(this.portalDomain);
      }
      if (this._activeItemContext) {
        this.artifactDownloadManager._activeItemContext = this._activeItemContext;
      }
    }
    if (this.loopStateCoordinator) {
      this.loopStateCoordinator.workflowId = this.workflowId;
      this.loopStateCoordinator.workflowName = this.workflowName;
      this.loopStateCoordinator.runsDir = this.runsDir;
      this.loopStateCoordinator.resumeFromCheckpoint = this.resumeFromCheckpoint;
      this.loopStateCoordinator.itemFilter = this.itemFilter;
      this.loopStateCoordinator.rowFilter = this.rowFilter;
      this.loopStateCoordinator.loopLimit = this.loopLimit;
      this.loopStateCoordinator.itemMode = this.itemMode;
      this.loopStateCoordinator.maxItems = this.maxItems;
      this.loopStateCoordinator.maxItemRetries = this.maxItemRetries;
    }
  }
  initDirectories() {
    this._syncSubManagers();
    try {
      if (!fs.existsSync(this.downloadsDir)) {
        fs.mkdirSync(this.downloadsDir, { recursive: true });
      }
    } catch (err) {
      logger.warn(`Could not create downloadsDir ${this.downloadsDir}: ${err.message}. Falling back.`);
      this.downloadsDir = path.join(os.tmpdir(), 'ReFlow', 'downloads', this.runId);
      try { fs.mkdirSync(this.downloadsDir, { recursive: true }); } catch {}
    }

    try {
      if (!fs.existsSync(this.structuredDownloadsDir)) {
        fs.mkdirSync(this.structuredDownloadsDir, { recursive: true });
      }
    } catch (err) {
      logger.warn(`Could not create structuredDownloadsDir ${this.structuredDownloadsDir}: ${err.message}. Falling back.`);
      this.structuredDownloadsDir = path.join(os.tmpdir(), 'ReFlow', 'structured', this.runId);
      try { fs.mkdirSync(this.structuredDownloadsDir, { recursive: true }); } catch {}
    }

    if (this.downloadManager) {
      this.downloadManager._initDirectory();
    }
  }

  /**
   * Post-processes a downloaded file:
   * 1. Validates existence and completion.
   * 2. Calculates SHA256 checksum.
   * 3. Moves/copies file into structured folder: downloads/<workflow-slug>/<YYYY-MM-DD>/<filename>
   * 4. Tracks download record in artifact download manager
   * 5. Appends record to workflow downloads manifest: downloads/<workflow-slug>/manifest.json
   */
  processAndStoreDownload(sourcePath, itemKey = null, itemLabel = null, itemFields = {}) {
    this._syncSubManagers();
    if (this._activeItemContext && !this.artifactDownloadManager._activeItemContext) {
      this.artifactDownloadManager._activeItemContext = this._activeItemContext;
    }
    return this.artifactDownloadManager.processAndStoreDownload(sourcePath, itemKey, itemLabel, itemFields);
  }

  syncWorkflowDownloadsManifest(downloadRecord) {
    return this.artifactDownloadManager.syncWorkflowDownloadsManifest(downloadRecord);
  }

  checkIfAlreadyDownloaded(itemKey, invoiceNumber = null, itemFields = {}, contentHash = null) {
    this._syncSubManagers();
    return this.artifactDownloadManager.checkIfAlreadyDownloaded(itemKey, invoiceNumber, itemFields, contentHash);
  }

  async isCollectionPresent(page, discovery) {
    return this.gridSelectionAdapter.isCollectionPresent(page, discovery);
  }

  async clearGridSelections(page, discovery) {
    return this.gridSelectionAdapter.clearGridSelections(page, discovery);
  }

  async enforceGridRowSingleSelection(page, discovery, targetIndex) {
    return this.gridSelectionAdapter.enforceGridRowSingleSelection(page, discovery, targetIndex);
  }

  async extractItemIdentifier(page, discovery, index, isDropdown = false) {
    return this.itemExecutionHandler.extractItemIdentifier(page, discovery, index, isDropdown);
  }

  static async extractDiscoveredItems(page, discovery) {
    return ItemExecutionHandler.extractDiscoveredItems(page, discovery);
  }

  async evaluateItemFilter(page, discovery, index, filterInput = undefined) {
    return this.itemExecutionHandler.evaluateItemFilter(page, discovery, index, filterInput);
  }

  async detectAndFilterItems(page, discovery, isDropdown, rowFilter) {
    return this.itemExecutionHandler.detectAndFilterItems(page, discovery, isDropdown, rowFilter);
  }

  async waitForDownload(previousSnapshot = [], timeoutMs = 10000) {
    return this.artifactDownloadManager.waitForDownload(previousSnapshot, timeoutMs);
  }

  snapshotDownloadedFiles() {
    return this.artifactDownloadManager.snapshotDownloadedFiles();
  }

  writeLoopCheckpoint(manifest, currentItemIndex = null, currentActionOffset = null, currentPage = 1, currentPageItemIndex = null, activeItem = null) {
    this._syncSubManagers();
    const result = this.loopStateCoordinator.writeLoopCheckpoint(manifest, currentItemIndex, currentActionOffset, currentPage, currentPageItemIndex, activeItem);
    this._lastCursor = this.loopStateCoordinator._lastCursor;
    return result;
  }

  loadLoopCheckpoint(workflow) {
    this._syncSubManagers();
    return this.loopStateCoordinator.loadLoopCheckpoint(workflow);
  }

  async configureDownloadInterception(page) {
    return this.artifactDownloadManager.configureDownloadInterception(page);
  }

  async _settlePageAsync(page, timeoutMs = 25000) {
    if (this.replayEngine && typeof this.replayEngine._waitForLoadingMasks === 'function') {
      await this.replayEngine._waitForLoadingMasks(timeoutMs).catch(() => {});
    }
    if (this.replayEngine && typeof this.replayEngine._waitForExtAjaxIdle === 'function') {
      await this.replayEngine._waitForExtAjaxIdle(timeoutMs).catch(() => {});
    }
  }

  /**
   * Helper to check if any modal or blocking overlay is currently visible on the page
   */
  async _hasModalOrOverlay(page) {
    if (!page || typeof page.evaluate !== 'function') return false;
    try {
      return await page.evaluate(() => {
        const overlaySelectors = [
          '[role="dialog"]',
          '[role="alertdialog"]',
          'dialog[open]',
          '[aria-modal="true"]',
          '.modal.show',
          '.modal.in',
          '.cdk-overlay-backdrop',
          '.cdk-overlay-pane',
          '.mat-mdc-dialog-container',
          '.mat-dialog-container',
          '.dx-dialog',
          '.dx-overlay-content',
          '.swal2-container',
          '.swal2-shown',
          '.ant-modal-mask',
          '.ant-modal-wrap',
          '.MuiBackdrop-root',
          '.MuiDialog-root',
          '.chakra-modal__content',
          '.chakra-modal__overlay'
        ];
        return overlaySelectors.some(sel => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.some(el => {
            if (el.offsetParent === null && el.tagName.toLowerCase() !== 'body') return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          });
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Navigate browser to the workflow's designated target/start URL
   */
  async navigateToWorkflowTarget(page, workflow) {
    const resolved = extractWorkflowStartUrl(workflow);
    if (!resolved) {
      logger.info('[Runner] No target URL specified for workflow. Executing on active tab.');
      return;
    }

    try {
      await page.bringToFront().catch(() => { });
    } catch { }

    // Proactively clear any open alert/confirmation dialogs on start
    if (typeof this.replayEngine?.interruptionHandler?.clearLingeringDialogs === 'function') {
      await this.replayEngine.interruptionHandler.clearLingeringDialogs(page).catch(() => {});
    }

    let currentUrl = '';
    try {
      currentUrl = typeof page.url === 'function' ? page.url() : '';
    } catch {}

    let shouldNavigate = false;

    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome://')) {
      shouldNavigate = true;
    } else {
      try {
        const currentParsed = new URL(currentUrl);
        const targetParsed = new URL(resolved);

        if (currentParsed.origin !== targetParsed.origin) {
          shouldNavigate = true;
        } else {
          // Same origin handling
          const isTargetLogin = /\/login\b|\/signin\b|\/auth\b/i.test(resolved) || /#(.*)\/(login|signin)/i.test(resolved);
          const isCurrentLogin = /\/login\b|\/signin\b|\/auth\b/i.test(currentUrl) || /#(.*)\/(login|signin)/i.test(currentUrl);

          if (isTargetLogin && !isCurrentLogin) {
            // Check if current page has an active, authenticated session
            const steps = workflow?.steps || (workflow?.recordingData?.actions) || workflow?.actions || [];
            const loginSeq = detectLoginSequence(steps);
            const isAuth = await isSessionAuthenticated(page, loginSeq);
            if (isAuth) {
              shouldNavigate = false;
              logger.info(`[Runner] Session already active at "${currentUrl}". Preserving active session instead of navigating back to login URL: ${resolved}`);
            } else {
              shouldNavigate = true;
              logger.info(`[Runner] Page at "${currentUrl}" is not authenticated. Navigating to start URL: ${resolved}`);
            }
          } else {
            // Compare normalized paths, search queries, and hashes
            const normCurrent = (currentParsed.pathname.replace(/\/+$/, '') || '/') + (currentParsed.search || '') + (currentParsed.hash.replace(/\/+$/, '') || '');
            const normTarget = (targetParsed.pathname.replace(/\/+$/, '') || '/') + (targetParsed.search || '') + (targetParsed.hash.replace(/\/+$/, '') || '');

            if (normCurrent !== normTarget) {
              // Current page is on a different sub-path, query, or hash (e.g., deep export screen, inner report view from prior run)
              shouldNavigate = true;
              logger.info(`[Runner] Current page path "${normCurrent}" differs from workflow target startUrl "${normTarget}". Enforcing clean navigation.`);
            } else {
              // Exact URL match: check if a lingering modal overlay from a prior run is blocking access
              const hasOverlay = await this._hasModalOrOverlay(page);
              if (hasOverlay) {
                logger.info('[Runner] Active modal/overlay detected from prior run. Clearing overlays and forcing fresh navigation...');
                const handler = this.replayEngine?.interruptionHandler;
                if (handler) {
                  const dismissFn = typeof handler.clearBlockingOverlays === 'function'
                    ? handler.clearBlockingOverlays
                    : (typeof handler.dismissBlockingOverlays === 'function' ? handler.dismissBlockingOverlays : null);
                  if (dismissFn) await dismissFn.call(handler, page).catch(() => {});
                }
                shouldNavigate = true;
              } else {
                shouldNavigate = false;
              }
            }
          }
        }
      } catch {
        shouldNavigate = currentUrl !== resolved;
      }
    }

    if (shouldNavigate) {
      logger.info(`[Runner] Navigating tab from "${currentUrl}" to workflow target URL: ${resolved}`);
      try {
        await page.goto(resolved, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (this.replayEngine && typeof this.replayEngine._applyStealthEvasion === 'function') {
          await this.replayEngine._applyStealthEvasion();
        }
        await new Promise(r => setTimeout(r, 600));
      } catch (navErr) {
        logger.warn(`[Runner] Auto-navigation note: ${navErr.message}`);
      }
    } else {
      logger.info(`[Runner] Tab already at target URL: ${currentUrl}`);
    }

    // Clean up any open alert/confirmation dialogs and modal overlays so Step 1 has clean access to DOM elements
    const postHandler = this.replayEngine?.interruptionHandler;
    if (postHandler) {
      if (typeof postHandler.clearLingeringDialogs === 'function') {
        await postHandler.clearLingeringDialogs(page).catch(() => {});
      }
      const postDismissFn = typeof postHandler.clearBlockingOverlays === 'function'
        ? postHandler.clearBlockingOverlays
        : (typeof postHandler.dismissBlockingOverlays === 'function' ? postHandler.dismissBlockingOverlays : null);
      if (postDismissFn) {
        await postDismissFn.call(postHandler, page).catch(() => {});
      }
    }
  }

  /**
   * Find a likely pagination "next" control on the current page.
   * The resolver is intentionally conservative: it requires semantic next-page
   * signals and rejects disabled/hidden controls. A workflow may provide an
   * explicit selector through workflow.pagination.nextSelector.
   */
  async findNextPageTarget(page, workflow = {}) {
    return this.gridSelectionAdapter.findNextPageTarget(page, workflow);
  }

  async getCollectionFingerprint(page, collection) {
    return this.gridSelectionAdapter.getCollectionFingerprint(page, collection);
  }

  async advanceToNextPage(page, workflow = {}) {
    return this.gridSelectionAdapter.advanceToNextPage(page, workflow, this.replayEngine);
  }

  isDropdownOptionCollection(collection, items = []) {
    return this.gridSelectionAdapter.isDropdownOptionCollection(collection, items);
  }

  async ensureDropdownOpen(page, triggerStep = null) {
    return this.gridSelectionAdapter.ensureDropdownOpen(page, triggerStep, this.replayEngine);
  }

  async executeDropdownOptionSingleSelect(page, targetIndex, targetText = '') {
    return this.gridSelectionAdapter.executeDropdownOptionSingleSelect(page, targetIndex, targetText);
  }

  /**
   * Execute a standard sequential workflow (all steps in order)
   * @param {object} workflow - Stored workflow object with steps array
   * @param {function} onProgress - Progress callback for live updates
   */
  async executeStandard(workflow, onProgress = () => { }) {
    if (workflow) {
      const targetUrl = workflow.targetUrl || workflow.startUrl || (workflow.steps && workflow.steps[0] && workflow.steps[0].url) || '';
      if (targetUrl && (!this.portalDomain || this.portalDomain === 'customerportal.usoil.com')) {
        this._applyTargetUrlDomain(targetUrl);
      }
    }
    this.initDirectories();
    const steps = workflow.steps || (workflow.recordingData && workflow.recordingData.actions) || workflow.actions || [];
    const manifest = {
      runId: this.runId,
      workflowId: workflow.id,
      mode: 'STANDARD',
      startTime: new Date().toISOString(),
      status: 'RUNNING',
      itemsTotal: steps.length,
      itemsSucceeded: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      results: [],
      downloadedFiles: [],
      extractedRows: []
    };
    this.manifest = manifest;

    logger.info(`[Runner] Starting standard execution run ${this.runId} for workflow "${workflow.name}" (${steps.length} steps)`);
    onProgress({ status: 'STARTING', manifest });

    try {
      // Set active recording on replayEngine for context-aware execution before connecting
      this.replayEngine.recording = workflow.recordingData || {
        actions: steps,
        targetUrl: workflow.targetUrl || workflow.startUrl,
        metadata: { startUrl: workflow.targetUrl || workflow.startUrl }
      };

      const browser = await this.replayEngine.connect();
      if (this.replayEngine.tabManager) {
        await this.replayEngine.tabManager.cleanupAuxiliaryTabs().catch(() => {});
      }
      const page = this.replayEngine.tabManager?.getPrimaryPage() || this.replayEngine.page || (await browser.pages())[0];
      this.replayEngine.page = page;

      // Set up the secret resolver
      this.replayEngine.secretResolver = this.secretResolver || (async (secretId) => `{{secret:${secretId}}}`);

      // Setup CDP download interception
      await this.configureDownloadInterception(page);

      // Auto-navigate to target URL before steps execution
      await this.navigateToWorkflowTarget(page, workflow);

      // Conditional Login Skip: If the portal is already authenticated, skip initial login steps
      let startIndex = 0;
      const loginSeq = detectLoginSequence(steps);
      if (loginSeq.hasLoginSequence) {
        const isAuth = await isSessionAuthenticated(page, loginSeq);
        if (isAuth) {
          logger.info(`[Runner] Active session detected at "${page.url()}". Skipping ${loginSeq.loginActionCount} login step(s) (Steps 1-${loginSeq.firstPostLoginIndex}) and resuming at Step #${loginSeq.firstPostLoginIndex + 1}.`);
          for (let s = loginSeq.startIndex; s <= loginSeq.endIndex; s++) {
            const skipStep = steps[s];
            const skipResult = {
              stepIndex: s + 1,
              type: skipStep.type || skipStep.action || 'CLICK',
              status: 'SKIPPED',
              reason: 'SESSION_ALREADY_AUTHENTICATED',
              name: skipStep.name || skipStep.elementName || `Step #${s + 1}`,
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString()
            };
            manifest.itemsSkipped++;
            manifest.results.push(skipResult);
            this.manifest = manifest;
            onProgress({ status: 'STEP_COMPLETE', stepResult: skipResult, manifest });
          }
          startIndex = loginSeq.firstPostLoginIndex;
        }
      }

      // Execute each step in order
      for (let i = startIndex; i < steps.length; i++) {
        if (this.isAborted) {
          logger.warn(`[Runner] Abort signal active before step #${i + 1}. Stopping execution.`);
          manifest.status = 'STOPPED';
          break;
        }

        const step = steps[i];
        const stepType = step.type || step.action || 'CLICK';

        // Natural pacing delay: wait if the user waited during recording (e.g. for grid data to load)
        if (i > 0 && step.timeDeltaMs && step.timeDeltaMs > 0) {
          const paceDelay = Math.min(step.timeDeltaMs, 15000);
          if (paceDelay > 600) {
            logger.info(`[Runner] Pacing step #${i + 1}: waiting ${paceDelay}ms for page/grid to settle...`);
            const end = Date.now() + paceDelay;
            while (Date.now() < end) {
              if (this.isAborted) break;
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }

        if (this.isAborted) {
          logger.warn(`[Runner] Abort signal active after pacing for step #${i + 1}. Stopping execution.`);
          manifest.status = 'STOPPED';
          break;
        }

        logger.info(`[Runner] Executing step ${i + 1}/${steps.length} [${stepType}]...`);
        const beforeStepFiles = this.snapshotDownloadedFiles();
        const stepResult = {
          stepIndex: i + 1,
          type: stepType,
          status: 'PENDING',
          startTime: new Date().toISOString()
        };

        try {
          await this.replayEngine.executeAction(step, i);
          stepResult.status = 'SUCCESS';
          manifest.itemsSucceeded++;

          if (stepType === 'CLICK' && this.downloadsDir) {
            const isDownloadAction = Boolean(
              (step.target?.candidates?.some(c => c.value && /download|export|save|pdf|print/i.test(c.value))) ||
              (step.target?.fingerprint?.attributes?.title && /download|export|save|pdf|print/i.test(step.target.fingerprint.attributes.title)) ||
              (step.target?.fingerprint?.text && /download|export|save|pdf|print/i.test(step.target.fingerprint.text))
            );
            const downloadWaitMs = isDownloadAction ? 12000 : 1200;
            const downloaded = await this.waitForDownload(beforeStepFiles, downloadWaitMs);
            if (downloaded.length) {
              stepResult.downloadedFiles = downloaded.map(dl => {
                const stored = this.processAndStoreDownload(dl.path, step.selector || `step_${i + 1}`, `Step #${i + 1}`) || dl;
                if (!manifest.downloadedFiles.some(existing => (existing.fileHash && existing.fileHash === stored.fileHash) || existing.path === stored.path)) {
                  manifest.downloadedFiles.push(stored);
                }
                return stored;
              });
            }
          }
        } catch (stepErr) {
          if (this.isAborted) {
            stepResult.status = 'STOPPED';
            stepResult.error = 'Execution stopped by user';
            manifest.status = 'STOPPED';
            manifest.results.push(stepResult);
            break;
          }
          logger.error(`[Runner] Step #${i + 1} failed: ${stepErr.message}`);
          stepResult.status = 'FAILED';
          stepResult.error = stepErr.message;
          manifest.itemsFailed++;
        }

        stepResult.endTime = new Date().toISOString();
        manifest.results.push(stepResult);
        this.manifest = manifest;

        // Ensure auxiliary tabs are closed and primary tab remains active in Chrome
        if (this.replayEngine?.tabManager) {
          await this.replayEngine.tabManager.cleanupAuxiliaryTabs();
          await this.replayEngine.tabManager.ensurePrimaryTabActive(this.replayEngine);
        }
        try {
          fs.writeFileSync(path.join(this.runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        } catch { }
        onProgress({ status: 'STEP_COMPLETE', stepResult, manifest });
      }

      // Gather and organize downloaded files into structured folder
      this.artifactDownloadManager.organizePendingDownloads(manifest, this._activeItemContext);

      manifest.status = this.isAborted ? 'STOPPED' : 'COMPLETED';
      manifest.endTime = new Date().toISOString();
      logger.success(`\n[Runner] Standard execution run ${this.runId} ${manifest.status}! Succeeded: ${manifest.itemsSucceeded}/${steps.length}`);

    } catch (err) {
      manifest.status = this.isAborted ? 'STOPPED' : 'FAILED';
      manifest.error = err.message;
      manifest.endTime = new Date().toISOString();
      if (this.isAborted) {
        logger.warn(`[Runner] Execution run ${this.runId} stopped by user.`);
      } else {
        logger.error(`[Runner] Fatal execution failure: ${err.message}`);
      }
    } finally {
      manifest.endTime = manifest.endTime || new Date().toISOString();
      if (this.isAborted) {
        manifest.status = 'STOPPED';
      }
      try {
        fs.writeFileSync(path.join(this.runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch { }
      if (this._replayTargetCreatedListener && this.replayEngine?.browser) {
        try {
          this.replayEngine.browser.off('targetcreated', this._replayTargetCreatedListener);
        } catch { }
        this._replayTargetCreatedListener = null;
      }
      if (this.artifactDownloadManager) {
        this.artifactDownloadManager.teardownDownloadInterception(this.replayEngine?.browser);
      }
      if (this.replayEngine) {
        await this.replayEngine.disconnect().catch(() => { });
      }
      onProgress({ status: manifest.status, manifest });
    }

    return manifest;
  }

  /**
   * Checks whether a composite record (e.g. "company_101/SI-184914") has already been
   * successfully processed and downloaded to prevent redundant processing under NEW_ONLY mode.
   *
   * @param {string} compositeKey - Composite identity (e.g. "companyId/invoiceNumber")
   * @param {string} outerId - Company identifier
   * @param {string} innerId - Record / Invoice identifier
   * @param {object} manifest - Active execution manifest
   * @returns {boolean}
   */
  checkCompositeAlreadyProcessed(compositeKey, outerId, innerId, manifest) {
    if (!compositeKey) return false;

    // 1. Check in-memory execution results
    if (manifest && Array.isArray(manifest.results)) {
      if (manifest.results.some(r => r && (r.compositeKey === compositeKey || (r.companyId === outerId && r.recordId === innerId)) && r.status === 'SUCCESS')) {
        return true;
      }
    }

    // 2. Check workflow download artifacts manifest
    if (this.artifactDownloadManager?.manifest?.files) {
      if (this.artifactDownloadManager.manifest.files.some(f => f && (f.compositeKey === compositeKey || (f.itemKey && f.itemKey.includes(compositeKey))))) {
        return true;
      }
    }

    // 3. Check underlying DownloadManager if attached
    if (this.downloadManager?.checkIfAlreadyDownloaded) {
      const res = this.downloadManager.checkIfAlreadyDownloaded(compositeKey, innerId, { companyId: outerId });
      if (res?.isDuplicate) return true;
    }

    return false;
  }

  /**
   * Executes a Controlled Two-Level Iteration workflow:
   * Level 1: Outer collection (Company / Department / Customer)
   * Level 2: Inner collection (Record / Invoice / Order)
   *
   * Exact execution flow:
   * 1. Initial setup steps (e.g. Login) run ONCE
   * 2. Outer collection (Companies) is discovered
   * 3. For Company 101:
   *    a. Select Company 101 (item-relative action)
   *    b. Execute outer pre-steps (navigate to Invoices page)
   *    c. Discover Invoices belonging to Company 101 freshly
   *    d. Process all matching invoices (A, B, C...)
   *    e. Exit inner loop, execute outer post-steps (return to company selection context)
   * 4. For Company 102:
   *    a. Select Company 102
   *    b. Execute outer pre-steps
   *    c. Discover Invoices belonging to Company 102 freshly
   *    d. Process all matching invoices (D, E...)
   *    e. Exit inner loop, return to company selection context
   * 5. Repeat for all remaining companies
   * 6. Final teardown steps run ONCE at completion
   *
   * @param {object} workflow - Stored workflow object with steps array
   * @param {object} nestedConfig - Standardized nested loop configuration
   * @param {function} onProgress - Progress callback for live updates
   */
  async executeNestedLoop(workflow, nestedConfig, onProgress = () => {}) {
    const steps = workflow.steps ||
      (workflow.workflow_definition && (workflow.workflow_definition.steps || workflow.workflow_definition.actions)) ||
      (workflow.recordingData && workflow.recordingData.actions) ||
      workflow.actions ||
      [];

    const partition = LoopDetector.partitionNestedWorkflow(steps, nestedConfig);

    const manifest = {
      runId: this.runId,
      workflowId: workflow.id,
      mode: 'TWO_LEVEL_LOOP',
      startTime: new Date().toISOString(),
      status: 'RUNNING',
      nestedConfig,
      outer: {
        name: nestedConfig.outer.name || 'company',
        total: 0,
        succeeded: 0,
        failed: 0,
        items: []
      },
      inner: {
        name: nestedConfig.inner.name || 'record',
        total: 0,
        succeeded: 0,
        failed: 0,
        skippedFilter: 0,
        skippedDuplicate: 0,
        downloadedFiles: []
      },
      results: [],
      downloadedFiles: []
    };
    this.manifest = manifest;

    onProgress({ status: 'STARTING', manifest, mode: 'TWO_LEVEL_LOOP' });

    if (this.replayEngine) {
      this.replayEngine.isPaused = false;
      this.replayEngine.isAborted = false;
    }
    this.replayEngine.recording = workflow.recordingData || {
      actions: steps,
      targetUrl: workflow.targetUrl || workflow.startUrl,
      metadata: { startUrl: workflow.targetUrl || workflow.startUrl }
    };

    const browser = await this.replayEngine.connect();
    if (this.replayEngine.tabManager) {
      await this.replayEngine.tabManager.cleanupAuxiliaryTabs().catch(() => {});
    }
    const page = this.replayEngine.tabManager?.getPrimaryPage() || this.replayEngine.page || (await browser.pages())[0];
    this.replayEngine.page = page;

    this.replayEngine.secretResolver = this.secretResolver || (async (secretId) => `{{secret:${secretId}}}`);
    await this.configureDownloadInterception(page);
    await this.navigateToWorkflowTarget(page, workflow);
    await this.replayEngine._ensureSelectorResolverInFrame(page.mainFrame());

    try {
      // Phase 1: Initial Setup Steps (Login) executed ONCE
      if (partition.initialSetupSteps.length > 0) {
        logger.info(`[Two-Level Loop] [SETUP] Executing ${partition.initialSetupSteps.length} initial setup step(s) once...`);
        const setupLoginSeq = detectLoginSequence(partition.initialSetupSteps);
        const isSessionAuth = setupLoginSeq.hasLoginSequence
          ? await isSessionAuthenticated(page, setupLoginSeq)
          : false;

        for (let i = 0; i < partition.initialSetupSteps.length; i++) {
          if (this.isAborted) throw new Error('Execution stopped by user');
          const step = partition.initialSetupSteps[i];
          if (isSessionAuth && i <= setupLoginSeq.endIndex) {
            logger.info(`[Two-Level Loop] [SETUP] Skipping login step #${i + 1} - session already authenticated.`);
            continue;
          }
          if (i > 0 && step.timeDeltaMs && step.timeDeltaMs > 0) {
            const paceDelay = Math.min(step.timeDeltaMs, 10000);
            if (paceDelay > 600) await new Promise(r => setTimeout(r, paceDelay));
          }
          logger.info(`[Two-Level Loop] [SETUP] Step #${i + 1}/${partition.initialSetupSteps.length}: ${step.name || step.elementName || step.type || 'Action'}`);
          await this.replayEngine.executeAction(step, i);
        }

        await new Promise(r => setTimeout(r, 1500));
        await this._settlePageAsync(page, 25000);
        if (typeof this.replayEngine.interruptionHandler?.closeDuplicateWindows === 'function') {
          await this.replayEngine.interruptionHandler.closeDuplicateWindows(page).catch(() => {});
        }
      }

      // Phase 2: Outer Collection Discovery (Companies)
      const outerAnchorStep = partition.outerPreSteps[partition.outerAnchorOffset];
      if (!outerAnchorStep) {
        throw new Error(`Outer anchor action not found at step #${nestedConfig.outer.anchorStepIndex + 1}`);
      }

      logger.info(`[Two-Level Loop] Discovering outer collection (${nestedConfig.outer.name || 'company'}) targeting anchor step #${nestedConfig.outer.anchorStepIndex + 1}...`);
      const outerDiscovery = await ItemDiscovery.discover(page, outerAnchorStep.target || outerAnchorStep.fingerprint, {
        minItems: 1,
        minScore: 0.45
      });

      if (!outerDiscovery || !outerDiscovery.success || outerDiscovery.itemCount === 0) {
        throw new Error(`Outer collection discovery failed for ${nestedConfig.outer.name || 'company'} anchor step #${nestedConfig.outer.anchorStepIndex + 1}: ${outerDiscovery?.reason || 'No collection items found'}`);
      }

      let outerItems = Array.isArray(outerDiscovery.items) ? outerDiscovery.items : [];
      if (nestedConfig.outer.filter) {
        const evalOuter = await this.detectAndFilterItems(page, outerDiscovery, false, nestedConfig.outer.filter);
        outerItems = evalOuter.filter(it => it.matches);
      }
      if (nestedConfig.outer.maxItems && nestedConfig.outer.maxItems > 0) {
        outerItems = outerItems.slice(0, nestedConfig.outer.maxItems);
      }

      manifest.outer.total = outerItems.length;
      manifest.itemsTotal = outerItems.length;
      logger.info(`[Two-Level Loop] Discovered ${outerItems.length} outer item(s) to process.`);

      // Phase 3: Controlled Outer Loop Execution (Company by Company)
      for (let c = 0; c < outerItems.length; c++) {
        if (this.isAborted) {
          manifest.status = 'STOPPED';
          break;
        }

        const currentOuter = outerItems[c];
        const outerIdx = currentOuter.index !== undefined ? currentOuter.index : c;
        const outerFields = currentOuter.fields || {};
        const outerId = outerFields['Company ID'] || outerFields['ID'] ||
          (currentOuter.text && currentOuter.text.match(/\b\d{3,6}\b/)?.[0]) ||
          (currentOuter.text ? currentOuter.text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) : `company_${c + 1}`);
        const outerLabel = currentOuter.text || `Company #${c + 1}`;

        const outerRecord = {
          index: c,
          domIndex: outerIdx,
          id: outerId,
          label: outerLabel,
          status: 'IN_PROGRESS',
          startedAt: new Date().toISOString(),
          innerItemsTotal: 0,
          innerItemsSucceeded: 0,
          innerItemsFailed: 0,
          results: []
        };
        manifest.outer.items.push(outerRecord);

        logger.info(`\n================================================================================`);
        logger.info(`[Two-Level Loop] >>> [${c + 1}/${outerItems.length}] Processing ${nestedConfig.outer.name || 'Company'}: "${outerLabel}" (ID: ${outerId}) <<<`);
        logger.info(`================================================================================\n`);
        onProgress({ status: 'PROCESSING_OUTER', outerIndex: c, outerTotal: outerItems.length, outerRecord, manifest });

        // 3a. Select current company
        const outerItemHandle = await ItemDiscovery.getItemHandle(page, outerDiscovery, outerIdx);
        const outerItemEl = outerItemHandle ? (outerItemHandle.asElement ? outerItemHandle.asElement() : outerItemHandle) : null;
        if (!outerItemEl) {
          throw new Error(`Could not resolve DOM element for ${nestedConfig.outer.name} #${c + 1} ("${outerLabel}")`);
        }

        try {
          logger.info(`[Two-Level Loop] Selecting ${nestedConfig.outer.name}: "${outerLabel}"`);
          await this.replayEngine.executeActionWithinItem(
            outerItemEl,
            outerAnchorStep,
            nestedConfig.outer.anchorStepIndex
          );
        } finally {
          await outerItemEl.dispose().catch(() => {});
        }

        await new Promise(r => setTimeout(r, 1200));
        await this._settlePageAsync(page, 25000);

        // 3b. Execute outer pre-steps (navigate to records page, e.g. Step 3: Open Invoices)
        for (let pIdx = partition.outerAnchorOffset + 1; pIdx < partition.outerPreSteps.length; pIdx++) {
          if (this.isAborted) break;
          const preStep = partition.outerPreSteps[pIdx];
          const absStepIdx = nestedConfig.outer.startStepIndex + pIdx;
          logger.info(`[Two-Level Loop] Navigation step #${absStepIdx + 1}: ${preStep.name || preStep.elementName || preStep.type || 'Action'}`);
          await this.replayEngine.executeAction(preStep, absStepIdx);
          await new Promise(r => setTimeout(r, 1200));
          await this._settlePageAsync(page, 25000);
        }

        if (typeof this.replayEngine.interruptionHandler?.closeDuplicateWindows === 'function') {
          await this.replayEngine.interruptionHandler.closeDuplicateWindows(page).catch(() => {});
        }

        // 3c. Fresh discovery of Inner Collection for THIS company
        const innerAnchorStep = partition.innerLoopSteps[partition.innerAnchorOffset];
        if (!innerAnchorStep) {
          throw new Error(`Inner anchor action not found at step #${nestedConfig.inner.anchorStepIndex + 1}`);
        }

        logger.info(`[Two-Level Loop] Discovering inner collection (${nestedConfig.inner.name || 'records'}) for ${outerLabel}...`);
        const innerDiscovery = await ItemDiscovery.discover(page, innerAnchorStep.target || innerAnchorStep.fingerprint, {
          minItems: 1,
          minScore: 0.45
        }).catch(err => ({ success: false, reason: err.message, itemCount: 0 }));

        if (!innerDiscovery || !innerDiscovery.success || innerDiscovery.itemCount === 0) {
          logger.info(`[Two-Level Loop] No records found for ${outerLabel} (0 records). Moving to return step for next company.`);
        } else {
          logger.info(`[Two-Level Loop] Discovered ${innerDiscovery.itemCount} record(s) for ${outerLabel}.`);
          outerRecord.innerItemsTotal = innerDiscovery.itemCount;
          manifest.inner.total += innerDiscovery.itemCount;

          // Filter inner items (e.g. Type = Invoice)
          const effectiveInnerFilter = nestedConfig.inner.filter || this.itemFilter || this.rowFilter || null;
          const evaluatedInner = await this.detectAndFilterItems(page, innerDiscovery, false, effectiveInnerFilter);
          const matchingInner = evaluatedInner.filter(it => it.matches);
          const skippedInner = evaluatedInner.filter(it => !it.matches);

          logger.info(`[Two-Level Loop] Filter results: ${matchingInner.length} matching record(s), ${skippedInner.length} skipped.`);
          manifest.inner.skippedFilter += skippedInner.length;

          for (const sk of skippedInner) {
            outerRecord.results.push({
              index: sk.index,
              status: 'SKIPPED_FILTER',
              label: sk.itemIdentifier.itemLabel,
              reason: sk.reason
            });
          }

          // Generalized inner loop actions
          const innerCollection = innerDiscovery.collection || { itemTag: 'tr', collectionType: 'table-row' };
          if (!innerCollection.itemTag) innerCollection.itemTag = 'tr';
          const generalizedInnerActions = ActionGeneralizer.generalizeActions(
            partition.innerLoopSteps,
            innerCollection,
            partition.innerAnchorOffset
          );

          // Process each matching record for this company
          const maxInner = (nestedConfig.inner.maxItems && nestedConfig.inner.maxItems > 0)
            ? Math.min(matchingInner.length, nestedConfig.inner.maxItems)
            : matchingInner.length;

          for (let m = 0; m < maxInner; m++) {
            if (this.isAborted) break;
            const targetInner = matchingInner[m];
            const innerIdx = targetInner.index;
            const innerId = targetInner.itemIdentifier.businessId || targetInner.itemIdentifier.invoiceNumber || targetInner.itemIdentifier.itemKey;
            const innerLabel = targetInner.itemIdentifier.itemLabel;
            const compositeKey = `${outerId}/${innerId}`;

            logger.info(`\n[Two-Level Loop] --- [${c + 1}.${m + 1}] Processing ${nestedConfig.inner.name}: "${innerLabel}" (${compositeKey}) ---`);

            // NEW_ONLY / Duplicate check
            const isNewOnly = Boolean(this.newOnly || this.options?.newOnly || workflow?.newOnly);
            if (isNewOnly) {
              const isDuplicate = this.checkCompositeAlreadyProcessed(compositeKey, outerId, innerId, manifest);
              if (isDuplicate) {
                logger.info(`[Two-Level Loop] 🛑 Skipping "${compositeKey}" (already processed in previous execution)`);
                outerRecord.results.push({
                  index: innerIdx,
                  compositeKey,
                  status: 'SKIPPED_DUPLICATE',
                  reason: 'Already processed (NEW_ONLY)',
                  label: innerLabel
                });
                manifest.inner.skippedDuplicate++;
                continue;
              }
            }

            const innerItemResult = {
              index: innerIdx,
              compositeKey,
              companyId: outerId,
              recordId: innerId,
              label: innerLabel,
              status: 'PENDING',
              downloadedFiles: [],
              actions: []
            };

            // Execute inner item actions
            try {
              for (let actIdx = 0; actIdx < generalizedInnerActions.length; actIdx++) {
                if (this.isAborted) break;
                const act = generalizedInnerActions[actIdx];
                const actType = act.type || act.action || 'CLICK';
                const isDl = actType === 'CLICK' && ItemExecutionHandler.isDownloadPotentialAction(act, targetInner);
                const beforeFiles = this.artifactDownloadManager?.snapshotDownloadedFiles() || { runFiles: [], osFiles: [] };

                if (act.scope === 'item') {
                  const itemHandle = await ItemDiscovery.getItemHandle(page, innerDiscovery, innerIdx);
                  const itemEl = itemHandle ? (itemHandle.asElement ? itemHandle.asElement() : itemHandle) : null;
                  if (!itemEl) throw new Error(`Could not resolve DOM handle for record #${m + 1} ("${innerLabel}")`);
                  try {
                    await this.replayEngine.executeActionWithinItem(itemEl, act, nestedConfig.inner.startStepIndex + actIdx);
                  } finally {
                    await itemEl.dispose().catch(() => {});
                  }
                } else {
                  await this.replayEngine.executeAction(act, nestedConfig.inner.startStepIndex + actIdx);
                }

                // Download handling
                if (isDl && this.artifactDownloadManager) {
                  const dlWait = this.itemExecutionHandler?.downloadTimeoutMs || 15000;
                  const dls = await this.artifactDownloadManager.waitForDownload(beforeFiles, dlWait);
                  if (dls && dls.length > 0) {
                    for (const dl of dls) {
                      const companySubfolder = path.join(this.workflowDownloadsBaseDir || '', outerId);
                      const organized = this.artifactDownloadManager.processAndStoreDownload(dl.path, compositeKey, innerLabel, {
                        ...targetInner.fields,
                        companyId: outerId,
                        companyName: outerLabel
                      }, companySubfolder);
                      if (organized) {
                        innerItemResult.downloadedFiles.push(organized);
                        manifest.inner.downloadedFiles.push(organized);
                        manifest.downloadedFiles.push(organized.filename || organized.targetFilename);
                      }
                    }
                  }
                }

                await new Promise(r => setTimeout(r, 600));
                await this._settlePageAsync(page, 15000);
              }

              innerItemResult.status = 'SUCCESS';
              outerRecord.innerItemsSucceeded++;
              manifest.inner.succeeded++;
            } catch (recErr) {
              logger.error(`[Two-Level Loop] Error processing record "${innerLabel}": ${recErr.message}`);
              innerItemResult.status = 'FAILED';
              innerItemResult.error = recErr.message;
              outerRecord.innerItemsFailed++;
              manifest.inner.failed++;
            }

            outerRecord.results.push(innerItemResult);
            manifest.results.push(innerItemResult);
          }
        }

        // 3d. Exit Inner Loop & Teardown / Return to Company Selection Context
        if (partition.outerPostSteps.length > 0) {
          logger.info(`[Two-Level Loop] Executing ${partition.outerPostSteps.length} outer return/post step(s) to prepare next company...`);
          for (let postIdx = 0; postIdx < partition.outerPostSteps.length; postIdx++) {
            if (this.isAborted) break;
            const postStep = partition.outerPostSteps[postIdx];
            const absStepIdx = (nestedConfig.inner.endStepIndex + 1) + postIdx;
            logger.info(`[Two-Level Loop] Return step #${absStepIdx + 1}: ${postStep.name || postStep.elementName || postStep.type || 'Action'}`);
            await this.replayEngine.executeAction(postStep, absStepIdx);
            await new Promise(r => setTimeout(r, 1200));
            await this._settlePageAsync(page, 25000);
          }
        }

        if (typeof this.replayEngine.interruptionHandler?.closeDuplicateWindows === 'function') {
          await this.replayEngine.interruptionHandler.closeDuplicateWindows(page).catch(() => {});
        }

        outerRecord.status = outerRecord.innerItemsFailed > 0 ? 'PARTIAL' : 'SUCCESS';
        outerRecord.completedAt = new Date().toISOString();
        manifest.outer.succeeded++;
        this._persistManifest(manifest);
      }

      // Phase 4: Final Teardown Steps executed ONCE after all companies complete
      if (partition.finalTeardownSteps.length > 0) {
        logger.info(`[Two-Level Loop] Executing ${partition.finalTeardownSteps.length} final teardown step(s)...`);
        for (let t = 0; t < partition.finalTeardownSteps.length; t++) {
          const tearStep = partition.finalTeardownSteps[t];
          const absStepIdx = (nestedConfig.outer.endStepIndex + 1) + t;
          await this.replayEngine.executeAction(tearStep, absStepIdx);
        }
      }

      manifest.status = this.isAborted ? 'STOPPED' : 'COMPLETED';
      manifest.completedAt = new Date().toISOString();
      this._persistManifest(manifest);
      onProgress({ status: manifest.status, manifest });
      return { success: true, status: manifest.status, manifest };
    } catch (err) {
      logger.error(`[Two-Level Loop] Execution failed: ${err.message}`);
      manifest.status = 'FAILED';
      manifest.error = err.message;
      manifest.completedAt = new Date().toISOString();
      this._persistManifest(manifest);
      onProgress({ status: 'FAILED', error: err.message, manifest });
      return { success: false, status: 'FAILED', error: err.message, manifest };
    }
  }

  /**
   * Execute a parameterized loop workflow
   * @param {object} workflow - Stored workflow object with steps array
   * @param {number} loopStepIndex - Index of the action to iterate over
   * @param {function} onProgress - Progress callback for live updates
   */
  async executeLoop(workflow, loopStepIndex = null, onProgress = () => { }) {
    this._limitReached = false;
    if (workflow) {
      if (!this.workflowId) this.workflowId = workflow.id || workflow.metadata?.recordingId;
      if (!this.workflowName || this.workflowName === 'workflow') this.workflowName = workflow.name || workflow.metadata?.name || workflow.id || 'workflow';
      const rawSlug = (this.workflowName || this.workflowId || 'workflow').toLowerCase();
      this.workflowSlug = rawSlug.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workflow';
      this.workflowDownloadsBaseDir = getSafeStoragePath('downloads', this.workflowSlug);
      if (!this._hasCustomStructuredDir) {
        this.structuredDownloadsDir = path.resolve(this.workflowDownloadsBaseDir, this.dateStr);
      }

      const targetUrl = workflow.targetUrl || workflow.startUrl || (workflow.steps && workflow.steps[0] && workflow.steps[0].url) || '';
      if (targetUrl && (!this.portalDomain || this.portalDomain === 'customerportal.usoil.com')) {
        this._applyTargetUrlDomain(targetUrl);
      }
    }
    const resolvedStartFilter = resolveItemFilter(workflow, this.options, this.workflow);
    if (resolvedStartFilter) {
      this.itemFilter = resolvedStartFilter;
      this.rowFilter = this.itemFilter;
    }
    if (!this.loopLimit && (workflow?.loopLimit || workflow?.workflow_definition?.loopLimit)) {
      this.loopLimit = workflow.loopLimit || workflow.workflow_definition?.loopLimit;
    }
    this.initDirectories();
    const manifest = {
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

    const checkpoint = this.loadLoopCheckpoint(workflow);
    if (checkpoint) {
      manifest.results = Array.isArray(checkpoint.results) ? checkpoint.results : [];
      manifest.itemsSucceeded = Number.isInteger(checkpoint.itemsSucceeded)
        ? checkpoint.itemsSucceeded
        : manifest.results.filter(result => result.status === 'SUCCESS').length;
      manifest.itemsFailed = Number.isInteger(checkpoint.itemsFailed)
        ? checkpoint.itemsFailed
        : manifest.results.filter(result => result.status === 'FAILED').length;
      manifest.skippedFilterCount = Number.isInteger(checkpoint.skippedFilterCount)
        ? checkpoint.skippedFilterCount
        : manifest.results.filter(result => result.status === 'SKIPPED_FILTER').length;
      manifest.skippedLimitCount = Number.isInteger(checkpoint.skippedLimitCount)
        ? checkpoint.skippedLimitCount
        : manifest.results.filter(result => result.status === 'SKIPPED_LIMIT').length;
      manifest.skippedDuplicateCount = Number.isInteger(checkpoint.skippedDuplicateCount)
        ? checkpoint.skippedDuplicateCount
        : manifest.results.filter(result => result.status === 'SKIPPED_DUPLICATE').length;
      manifest.itemsSkipped = Number.isInteger(checkpoint.itemsSkipped)
        ? checkpoint.itemsSkipped
        : (manifest.skippedFilterCount + manifest.skippedLimitCount + manifest.skippedDuplicateCount);
      manifest.matchingCount = Number.isInteger(checkpoint.matchingCount)
        ? checkpoint.matchingCount
        : manifest.results.filter(result => result.status !== 'SKIPPED_FILTER').length;
      manifest.selectedCount = Number.isInteger(checkpoint.selectedCount)
        ? checkpoint.selectedCount
        : manifest.results.filter(result => result.status !== 'SKIPPED_FILTER' && result.status !== 'SKIPPED_LIMIT').length;
      manifest.matching = manifest.matchingCount;
      manifest.selected = manifest.selectedCount;
      manifest.skippedFilter = manifest.skippedFilterCount;
      manifest.skippedLimit = manifest.skippedLimitCount;
      manifest.skippedDuplicate = manifest.skippedDuplicateCount;
      manifest.downloadedFiles = Array.isArray(checkpoint.downloadedFiles)
        ? checkpoint.downloadedFiles
        : [];
      manifest.pagesProcessed = Number.isInteger(checkpoint.pagesProcessed)
        ? checkpoint.pagesProcessed
        : 1;
      manifest.itemsTotal = Number.isInteger(checkpoint.itemsTotal)
        ? checkpoint.itemsTotal
        : 0;
      manifest.activeItem = checkpoint.activeItem || null;
    }
    this.manifest = manifest;
    this._lastCursor = checkpoint ? {
      currentItemIndex: checkpoint.currentItemIndex ?? null,
      currentActionOffset: checkpoint.currentActionOffset ?? null,
      currentPage: checkpoint.currentPage ?? 1,
      currentPageItemIndex: checkpoint.currentPageItemIndex ?? null,
      activeItem: checkpoint.activeItem ?? null
    } : null;

    logger.info(`[Loop Runner] Starting execution run ${this.runId} for workflow "${workflow.name}"`);
    onProgress({ status: checkpoint ? 'RESUMING' : 'STARTING', manifest, checkpoint });

    let currentPage = 1;

    try {
      // 1. Unified Loop Configuration and Validation BEFORE browser actions
      const steps = workflow.steps ||
        (workflow.workflow_definition && (workflow.workflow_definition.steps || workflow.workflow_definition.actions)) ||
        (workflow.recordingData && workflow.recordingData.actions) ||
        workflow.actions ||
        [];

      const loopConfigInput = {
        ...workflow,
        ...(this.isLoop ? { isLoop: this.isLoop, mode: this.mode, loopStepIndex: this.loopStepIndex, loopLimit: this.loopLimit } : {}),
      };
      if (workflow.loop) loopConfigInput.loop = workflow.loop;
      else if (this.loopConfig?.enabled) loopConfigInput.loop = this.loopConfig;

      // Check for Controlled Two-Level Iteration (Company-level outer + Record-level inner)
      const nestedConfig = LoopDetector.deriveNestedLoopConfig({
        ...workflow,
        ...(this.nestedLoop ? { nestedLoop: this.nestedLoop } : {}),
        ...(this.options?.nestedLoop ? { nestedLoop: this.options.nestedLoop } : {}),
      }, steps);

      if (nestedConfig && nestedConfig.enabled) {
        const nestedValidation = LoopDetector.validateNestedLoopConfig(nestedConfig, steps.length);
        if (nestedValidation.valid) {
          logger.info(`[Loop Runner] Initiating Controlled Two-Level Iteration: Level 1 (${nestedConfig.outer.name || 'company'}) + Level 2 (${nestedConfig.inner.name || 'record'})`);
          return await this.executeNestedLoop(workflow, nestedConfig, onProgress);
        } else {
          logger.warn(`[Loop Runner] Nested loop configuration invalid (${nestedValidation.error}). Falling back to single-level loop.`);
        }
      }

      const loopConfig = LoopDetector.deriveLoopConfig(
        loopConfigInput,
        steps
      );
      this.loopConfig = loopConfig;

      if (loopConfig.enabled) {
        const validation = LoopDetector.validateLoopConfig(loopConfig, steps.length);
        if (!validation.valid) {
          throw new Error(`Invalid loop configuration: ${validation.error}`);
        }
      }

      const anchorStepIndex = Number.isInteger(loopConfig.anchorStepIndex) ? loopConfig.anchorStepIndex : (Number.isInteger(loopStepIndex) ? loopStepIndex : 0);
      const startStepIndex = Number.isInteger(loopConfig.startStepIndex) ? loopConfig.startStepIndex : anchorStepIndex;
      const endStepIndex = Number.isInteger(loopConfig.endStepIndex) ? loopConfig.endStepIndex : (steps.length > 0 ? steps.length - 1 : 0);

      const partition = LoopDetector.partitionWorkflow(steps, startStepIndex, endStepIndex);
      const anchorOffset = anchorStepIndex - startStepIndex;
      const targetStep = partition.loopSteps[anchorOffset] || partition.loopSteps[0];
      if (!targetStep) {
        logger.warn(`[Loop Runner] No loop target action found at anchor index ${anchorStepIndex}. Falling back to standard execution.`);
        return await this.executeStandard(workflow, onProgress);
      }
      const analysis = LoopDetector.analyzeStep(targetStep);

      manifest.loopStepIndex = anchorStepIndex;
      manifest.anchorStepIndex = anchorStepIndex;
      manifest.startStepIndex = startStepIndex;
      manifest.endStepIndex = endStepIndex;

      logger.info(`[Loop Runner] Loop starts at step index ${startStepIndex}..${endStepIndex} (anchor: #${anchorStepIndex + 1}, Setup: ${partition.setupSteps.length} step(s), Loop: ${partition.loopSteps.length} action(s), Teardown: ${partition.teardownSteps.length} step(s))`);
      logger.info(`[Loop Runner] Detected pattern: ${analysis.patternType} (Container: ${analysis.containerSelector})`);

      if (this.replayEngine) {
        this.replayEngine.isPaused = false;
        this.replayEngine.isAborted = false;
      }
      // Set active recording on replayEngine for context-aware execution before connecting
      this.replayEngine.recording = workflow.recordingData || {
        actions: workflow.steps || [],
        targetUrl: workflow.targetUrl || workflow.startUrl,
        metadata: { startUrl: workflow.targetUrl || workflow.startUrl }
      };

      const browser = await this.replayEngine.connect();
      if (this.replayEngine.tabManager) {
        await this.replayEngine.tabManager.cleanupAuxiliaryTabs().catch(() => {});
      }
      const page = this.replayEngine.tabManager?.getPrimaryPage() || this.replayEngine.page || (await browser.pages())[0];
      this.replayEngine.page = page;
      const initialPages = await browser.pages().catch(() => []);
      const initialPageUrls = new Set(initialPages.map(p => p.url()));

      // Set up the secret resolver
      this.replayEngine.secretResolver = this.secretResolver || (async (secretId) => `{{secret:${secretId}}}`);

      // Setup CDP download interception
      await this.configureDownloadInterception(page);

      // Auto-navigate to workflow target URL before executing setup / loop steps
      await this.navigateToWorkflowTarget(page, workflow);

      // Ensure the same selector resolver used by normal replay is available to
      // ItemDiscovery before it tries to resolve the recorded target.
      await this.replayEngine._ensureSelectorResolverInFrame(page.mainFrame());

      // Capture the current page URL for state restoration. This must be updated
      // per pagination page so retries on page 2+ do not accidentally return to page 1.
      let currentPageUrl = page.url();

      // If target step is an option/dropdown, ensure dropdown is open before ItemDiscovery
      const isDropdownCandidate = analysis.patternType === 'dropdown-option' ||
        targetStep.fingerprint?.parentTag === 'mat-option' ||
        targetStep.fingerprint?.tagName === 'mat-option' ||
        (targetStep.target?.candidates && targetStep.target.candidates.some(c => c && /mat-option|role=["']option["']/i.test(c.value)));

      // Execute Setup Steps (e.g. Login & Navigate) once
      if (partition.setupSteps.length > 0) {
        logger.info(`[SETUP] Executing ${partition.setupSteps.length} setup step(s) once...`);
        const setupLoginSeq = detectLoginSequence(partition.setupSteps);
        const isSessionAuth = setupLoginSeq.hasLoginSequence
          ? await isSessionAuthenticated(page, setupLoginSeq)
          : false;

        for (let i = 0; i < partition.setupSteps.length; i++) {
          const step = partition.setupSteps[i];
          if (isSessionAuth && i <= setupLoginSeq.endIndex) {
            logger.info(`[SETUP] Skipping setup login step #${i + 1} (${step.name || step.elementName || 'Login step'}) - session already authenticated.`);
            continue;
          }

          // Natural pacing delay: wait if the user waited during recording (e.g. for page or grid to load)
          if (i > 0 && step.timeDeltaMs && step.timeDeltaMs > 0) {
            const paceDelay = Math.min(step.timeDeltaMs, 15000);
            if (paceDelay > 600) {
              logger.info(`[SETUP] Pacing setup step #${i + 1}: waiting ${paceDelay}ms for page/state to settle...`);
              const end = Date.now() + paceDelay;
              while (Date.now() < end) {
                if (this.isAborted) break;
                await new Promise(r => setTimeout(r, 100));
              }
            }
          }

          logger.info(`[SETUP] Step #${i + 1}/${partition.setupSteps.length}: ${step.name || step.elementName || step.type || 'Action'}`);
          await this.replayEngine.executeAction(step, i);
        }

        if (isDropdownCandidate) {
          const triggerStep = partition.setupSteps[partition.setupSteps.length - 1];
          await this.ensureDropdownOpen(page, triggerStep);
          await new Promise(r => setTimeout(r, 400));
        }

        // Natural pacing delay after setup steps and allow asynchronous frames/AJAX to settle
        await new Promise(r => setTimeout(r, 1500));
        await this._settlePageAsync(page, 25000);
        if (typeof this.replayEngine?.interruptionHandler?.closeDuplicateWindows === 'function') {
          await this.replayEngine.interruptionHandler.closeDuplicateWindows(page).catch(() => {});
        }
      }

      // Ensure duplicate / stacked windows are deduplicated before discovery
      if (typeof this.replayEngine?.interruptionHandler?.closeDuplicateWindows === 'function') {
        await this.replayEngine.interruptionHandler.closeDuplicateWindows(page).catch(() => {});
      }

      // Discover collection targeting the explicit anchor step
      let discovery = await ItemDiscovery.discover(page, targetStep.target || targetStep.fingerprint, {
        minItems: 1,
        minScore: 0.45
      }).catch((err) => ({ success: false, reason: err.message }));

      if (!discovery || !discovery.success) {
        const errorMsg = `Collection discovery failed for anchor step #${anchorStepIndex + 1}: ${(discovery && (discovery.reason || discovery.error)) || 'Anchor element could not be resolved or collection container not found'}`;
        logger.error(`[Loop Runner] ${errorMsg}`);
        manifest.status = 'FAILED';
        manifest.error = errorMsg;
        manifest.completedAt = new Date().toISOString();
        if (typeof onProgress === 'function') {
          onProgress({ status: 'LOOP_ERROR', runId: this.runId, error: errorMsg, manifest });
        }
        this._persistManifest(manifest);
        return { success: false, status: 'FAILED', error: errorMsg, manifest };
      }

      // Capture authoritative collection URL after setup steps and discovery succeed.
      // This URL (with all filters, query params, hash) is preserved across iterations.
      let collectionUrl = page.url();
      this.collectionUrl = collectionUrl;
      currentPageUrl = collectionUrl;
      logger.info(`[LOOP] Anchor step #${anchorStepIndex + 1} (${targetStep.name || targetStep.type || 'Action'})`);
      logger.info(`[LOOP] Collection discovered: ${discovery.itemCount} records (Type: ${discovery.collection?.collectionType || discovery.patternType || 'table-row'}, URL: ${collectionUrl})`);

      // Valid collection found, but contains 0 items
      if (discovery.itemCount === 0 || !Array.isArray(discovery.items) || discovery.items.length === 0) {
        logger.info(`[Loop Runner] Collection found for anchor step #${anchorStepIndex + 1}, but collection contains 0 records.`);
        manifest.status = 'COMPLETED';
        manifest.itemsTotal = 0;
        manifest.itemsSucceeded = 0;
        manifest.itemsFailed = 0;
        manifest.completedAt = new Date().toISOString();
        if (!this.isAborted && Array.isArray(partition.teardownSteps) && partition.teardownSteps.length > 0) {
          logger.info(`[Loop Runner] Executing ${partition.teardownSteps.length} teardown step(s)...`);
          for (let t = 0; t < partition.teardownSteps.length; t++) {
            await this.replayEngine.executeAction(partition.teardownSteps[t], (endStepIndex + 1) + t);
          }
        }
        this._persistManifest(manifest);
        return { success: true, status: 'COMPLETED', manifest, totalItems: 0, processedItems: 0 };
      }

      if (!checkpoint) {
        manifest.itemsTotal = discovery.itemCount;
        manifest.pagesProcessed = 1;
      }

      const isDropdown = this.isDropdownOptionCollection(discovery.collection, discovery.items);
      const triggerStep = partition.setupSteps.length > 0
        ? partition.setupSteps[partition.setupSteps.length - 1]
        : null;

      // ItemDiscovery already extracts fields while preserving the exact
      // discovered item identity/order used by getItemHandle().
      // Do not rebuild the collection from the DOM here: doing so can shift
      // row indices (headers/hidden rows) and overwrite correct fields.
      let itemsWithFields = Array.isArray(discovery.items)
        ? discovery.items
        : [];

      const effectiveFilter = this.itemFilter || this.rowFilter || null;
      const preview = this.itemExecutionHandler.evaluateCollectionPreview({
        items: itemsWithFields,
        filter: effectiveFilter,
        limit: this.loopLimit,
        validationError: this.filterValidationError || this.loopLimitError
      });

      if (itemsWithFields.length > 0 && preview.selectedCount === 0) {
        return await this.itemExecutionHandler.handleZeroMatches({
          page,
          discovery,
          isDropdown,
          itemsWithFields,
          preview,
          manifest,
          isRelational: preview.isRelational,
          effectiveFilter,
          onProgress,
          runner: this
        });
      }

      // Convert recorded actions: items inside collection become item-relative,
      // subsequent page actions (e.g. backdrop, Run Report, Export to Excel) are page-scoped.
      const generalizedActions = ActionGeneralizer.generalizeActions(partition.loopSteps, discovery.collection, anchorOffset);

      logger.info(`[Loop Runner] Discovered ${discovery.itemCount} repeated item(s) with confidence ${Math.round(discovery.confidence * 100)}% (Dropdown Mode: ${isDropdown})`);
      logger.info(`[Loop Runner] Generalized ${generalizedActions.length} loop action(s) (${generalizedActions.filter(a => a.scope === 'item').length} item-scoped, ${generalizedActions.filter(a => a.scope === 'page').length} page-scoped).`);
      onProgress({ status: 'PROCESSING_ITEMS', manifest, discovery, generalizedActions });

      // 4. Process the current page, then optionally advance through pagination.
      // Pagination is opt-in through workflow.pagination.enabled to avoid clicking
      // unrelated "Next" controls on portals that do not use paging.
      const paginationEnabled = workflow.pagination?.enabled === true;
      const maxPages = Number.isInteger(workflow.pagination?.maxPages)
        ? Math.max(1, workflow.pagination.maxPages)
        : 100;
      currentPage = 1;
      const resumePage = checkpoint && Number.isInteger(checkpoint.currentPage)
        ? checkpoint.currentPage
        : 1;
      const resumePageItemIndex = checkpoint && Number.isInteger(checkpoint.currentPageItemIndex)
        ? checkpoint.currentPageItemIndex
        : 0;
      const resumeActionOffset = checkpoint && Number.isInteger(checkpoint.currentActionOffset)
        ? checkpoint.currentActionOffset
        : 0;
      const resumeItemIndex = checkpoint && Number.isInteger(checkpoint.currentItemIndex)
        ? checkpoint.currentItemIndex
        : null;

      while (true) {
        currentPageUrl = page.url();

        if (currentPage < resumePage) {
          const beforeResumeFingerprint = await this.getCollectionFingerprint(page, discovery.collection);
          const advancedToResumePage = await this.advanceToNextPage(page, workflow);
          if (!advancedToResumePage) {
            throw new Error(`Could not reach checkpoint page #${resumePage}`);
          }

          const nextDiscovery = await ItemDiscovery.discover(
            page,
            targetStep.target || targetStep.fingerprint,
            { minItems: 1, minScore: 0.55 }
          );
          if (!nextDiscovery.success || nextDiscovery.itemCount < 1) {
            throw new Error(`Could not rediscover item collection while resuming page #${currentPage + 1}`);
          }

          const afterResumeFingerprint = await this.getCollectionFingerprint(page, nextDiscovery.collection);
          if (
            beforeResumeFingerprint &&
            afterResumeFingerprint &&
            beforeResumeFingerprint === afterResumeFingerprint
          ) {
            throw new Error(`Pagination did not advance while resuming page #${currentPage + 1}`);
          }

          discovery = nextDiscovery;
          itemsWithFields = Array.isArray(discovery.items) ? discovery.items : [];
          currentPage++;
          manifest.pagesProcessed = currentPage;
          manifest.itemsTotal += discovery.itemCount;
          currentPageUrl = page.url();
          continue;
        }

        // 1. Efficiently identify and filter available items on current page
        const evaluatedItems = await this.detectAndFilterItems(page, discovery, isDropdown, this.itemFilter || this.rowFilter);

        const matchingItems = evaluatedItems.filter(it => it.matches);
        const skippedItems = evaluatedItems.filter(it => !it.matches);

        manifest.matchingCount = (manifest.matchingCount || 0) + matchingItems.length;
        manifest.matching = manifest.matchingCount;

        // Record all filtered-out items in manifest and progress immediately
        for (const skipped of skippedItems) {
          const skippedIndex = resumeItemIndex != null && currentPage === resumePage && skipped.index === resumePageItemIndex
            ? resumeItemIndex
            : manifest.results.reduce((max, result) => Math.max(max, Number(result.index) || 0), 0) + 1;
          const skippedResult = {
            index: skippedIndex,
            itemIndex: skipped.index,
            page: currentPage,
            label: skipped.itemIdentifier.itemLabel,
            itemKey: skipped.itemIdentifier.itemKey,
            status: 'SKIPPED_FILTER',
            skippedReason: skipped.reason,
            timestamp: new Date().toISOString()
          };
          manifest.results.push(skippedResult);
          manifest.skippedFilterCount = (manifest.skippedFilterCount || 0) + 1;
          manifest.skippedFilter = manifest.skippedFilterCount;
          manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
        }

        if (this.rowFilter || isDropdown) {
          logger.info(`[Loop Runner] Filter evaluation: ${matchingItems.length}/${evaluatedItems.length} matching item(s) (${skippedItems.length} filtered out). Iterating properly through matching items.`);
        }

        // 2. Iterate properly through ONLY matching items
        for (let m = 0; m < matchingItems.length; m++) {
          const targetItem = matchingItems[m];
          const i = targetItem.index;
          const itemIdentifier = targetItem.itemIdentifier;

          if (this.isAborted) {
            logger.warn(`[Loop Runner] Abort signal active before item #${i + 1}. Stopping loop.`);
            manifest.status = 'STOPPED';
            this.writeLoopCheckpoint(manifest, null, 0, currentPage, i, null);
            break;
          }

          if (checkpoint && currentPage === resumePage && i < resumePageItemIndex) {
            continue;
          }

          logger.info(`\n[ITEM ${m + 1}/${matchingItems.length}] Processing item ${itemIdentifier.itemLabel ? `"${itemIdentifier.itemLabel}"` : `#${i + 1}`} (DOM index ${i + 1}) ---`);

          // 1b. Stop when the requested loop limit / maxItems is reached
          const effectiveLimit = this.loopLimit || this.maxItems;
          if (effectiveLimit) {
            const doneCount = (manifest.selectedCount || 0);
            if (doneCount >= effectiveLimit) {
              const limitReason = `Beyond loop limit (${effectiveLimit})`;
              logger.info(`[Loop Runner] 🛑 Skipping item #${i + 1} ("${itemIdentifier.itemLabel}") - ${limitReason}`);
              this._limitReached = true;
              const skippedIndex = resumeItemIndex != null && currentPage === resumePage && i === resumePageItemIndex
                ? resumeItemIndex
                : manifest.results.reduce((max, result) => Math.max(max, Number(result.index) || 0), 0) + 1;

              const skippedResult = {
                index: skippedIndex,
                itemIndex: i,
                page: currentPage,
                label: itemIdentifier.itemLabel,
                itemKey: itemIdentifier.itemKey,
                status: 'SKIPPED_LIMIT',
                skippedReason: limitReason,
                timestamp: new Date().toISOString()
              };

              manifest.results.push(skippedResult);
              manifest.skippedLimitCount = (manifest.skippedLimitCount || 0) + 1;
              manifest.skippedLimit = manifest.skippedLimitCount;
              manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
              this.manifest = manifest;
              this.writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
              onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
              continue;
            }
          }

          // Item matched filter and is selected for execution!
          manifest.selectedCount = (manifest.selectedCount || 0) + 1;
          manifest.selected = manifest.selectedCount;

          // 2. Hybrid Deduplication Check: UI Identifier + DB Metadata + Physical Disk File
          const dedupe = this.checkIfAlreadyDownloaded(itemIdentifier.itemKey, itemIdentifier.invoiceNumber, targetItem.fields || {});

          // "old only" mode: skip items that were never downloaded before and not past due
          if (this.itemMode === 'old' && !dedupe.isDuplicate && !dedupe.isOldData) {
            const skippedIndex = manifest.results.reduce((max, result) => Math.max(max, Number(result.index) || 0), 0) + 1;
            const skippedResult = {
              index: skippedIndex,
              itemIndex: i,
              page: currentPage,
              label: itemIdentifier.itemLabel,
              itemKey: itemIdentifier.itemKey,
              status: 'SKIPPED_FILTER',
              skippedReason: 'New item (run mode is "old only")',
              timestamp: new Date().toISOString()
            };
            manifest.results.push(skippedResult);
            manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
            this.manifest = manifest;
            this.writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
            onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
            continue;
          }

          // "new only" mode (default): skip items already downloaded
          if (dedupe.isDuplicate && this.itemMode === 'new' && !this.forceRedownload) {
            logger.info(`[Loop Runner] Skipping item #${i + 1} ("${itemIdentifier.itemLabel}") - already downloaded: "${dedupe.record?.filename || 'existing'}" (${dedupe.record?.filePath || 'folder'})`);
            const skippedIndex = resumeItemIndex != null && currentPage === resumePage && i === resumePageItemIndex
              ? resumeItemIndex
              : manifest.results.reduce((max, result) => Math.max(max, Number(result.index) || 0), 0) + 1;

            const skippedResult = {
              index: skippedIndex,
              itemIndex: i,
              page: currentPage,
              label: itemIdentifier.itemLabel,
              itemKey: itemIdentifier.itemKey,
              status: 'SKIPPED_DUPLICATE',
              skippedReason: dedupe.inFolder ? `Already in download folder: ${dedupe.record?.filename || 'file'}` : `Already downloaded: ${dedupe.record?.filename || 'file'}`,
              existingFile: dedupe.record?.filePath || null,
              downloadedFiles: dedupe.record?.filePath ? [{
                filename: dedupe.record.filename,
                path: path.resolve(process.cwd(), dedupe.record.filePath),
                relativePath: dedupe.record.filePath,
                sizeBytes: dedupe.record.fileSizeBytes || 0,
                skipped: true
              }] : [],
              timestamp: new Date().toISOString()
            };

            manifest.results.push(skippedResult);
            manifest.skippedDuplicateCount = (manifest.skippedDuplicateCount || 0) + 1;
            manifest.skippedDuplicate = manifest.skippedDuplicateCount;
            manifest.itemsSkipped = (manifest.itemsSkipped || 0) + 1;
            this.manifest = manifest;
            this.writeLoopCheckpoint(manifest, null, 0, currentPage, i + 1, null);
            try {
              fs.writeFileSync(path.join(this.runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            } catch { }
            onProgress({ status: 'ITEM_SKIPPED', itemResult: skippedResult, manifest });
            continue;
          }

          this._syncSubManagers();
          const attemptOutcome = await this.itemExecutionHandler.executeItemAttempt({
            page,
            discovery,
            i,
            targetItem,
            itemIdentifier,
            generalizedActions,
            effectiveLoopStepIndex: startStepIndex,
            isDropdown,
            triggerStep,
            partition,
            currentPageUrl,
            collectionUrl: this.collectionUrl || currentPageUrl,
            initialPageUrls,
            currentPage,
            manifest,
            checkpoint,
            resumePage,
            resumePageItemIndex,
            resumeActionOffset,
            resumeItemIndex,
            onProgress,
            runner: this
          });
          if (attemptOutcome && attemptOutcome.stopped) {
            break;
          }
          if (attemptOutcome && attemptOutcome.itemResult && attemptOutcome.itemResult.collectionRestorationFailed) {
            const reason = attemptOutcome.itemResult.collectionRestorationReason || 'Collection context could not be restored safely';
            logger.error(`[LOOP] Halting loop because collection context could not be restored safely: ${reason}`);
            this._collectionRestorationFailed = true;
            this._collectionRestorationError = `Collection restoration failed: ${reason}`;
            manifest.error = this._collectionRestorationError;
            break;
          }
        }

        if (!paginationEnabled || currentPage >= maxPages || this._limitReached || this._collectionRestorationFailed) {
          break;
        }
        const beforePageFingerprint = await this.getCollectionFingerprint(page, discovery.collection);
        const advanced = await this.advanceToNextPage(page, workflow);
        if (!advanced) {
          logger.info('[Loop Runner] No next page control found. Pagination complete.');
          break;
        }

        const previousItemCount = discovery.itemCount;
        const nextDiscovery = await ItemDiscovery.discover(
          page,
          targetStep.target || targetStep.fingerprint,
          { minItems: 1, minScore: 0.55 }
        );

        if (!nextDiscovery.success || nextDiscovery.itemCount < 1) {
          logger.info('[Loop Runner] Next page did not expose a discoverable item collection. Pagination complete.');
          break;
        }

        const afterPageFingerprint = await this.getCollectionFingerprint(page, nextDiscovery.collection);
        if (beforePageFingerprint && afterPageFingerprint && beforePageFingerprint === afterPageFingerprint) {
          logger.info('[Loop Runner] Next control did not change the discovered collection. Pagination complete.');
          break;
        }

        discovery = nextDiscovery;
        itemsWithFields = Array.isArray(discovery.items) ? discovery.items : [];
        manifest.itemsTotal += discovery.itemCount;
        manifest.pagesProcessed = currentPage + 1;
        currentPage++;
        currentPageUrl = page.url();
        this.collectionUrl = currentPageUrl;
        this.writeLoopCheckpoint(manifest, null, null, currentPage, null, null);
        logger.info('[Loop Runner] Advanced to page #' + currentPage + ' with ' + discovery.itemCount + ' item(s).');
        onProgress({ status: 'PAGE_COMPLETE', page: currentPage, manifest, discovery });

        if (discovery.itemCount === previousItemCount && currentPage >= maxPages) {
          break;
        }
      }

      // 5. Gather and organize all downloaded files into structured folder
      this.artifactDownloadManager.organizePendingDownloads(manifest, this._activeItemContext);

      this._syncSubManagers();
      if (this.artifactDownloadManager) {
        const shouldGenerateCsv =
          manifest.downloadedFiles.length === 0 ||
          (this.alwaysExportTableCsv !== false && Array.isArray(manifest.extractedRows) && manifest.extractedRows.length > 0);
        if (shouldGenerateCsv) {
          this.artifactDownloadManager.generateStructuredDataArtifact(manifest);
        }
      }

      // 6. Execute teardown steps after normal loop completion once
      if (!this.isAborted && !this._collectionRestorationFailed && Array.isArray(partition.teardownSteps) && partition.teardownSteps.length > 0) {
        logger.info(`[TEARDOWN] Executing ${partition.teardownSteps.length} teardown step(s) once...`);
        for (let t = 0; t < partition.teardownSteps.length; t++) {
          const step = partition.teardownSteps[t];
          const stepIndex = (endStepIndex + 1) + t;
          logger.info(`[TEARDOWN] Step #${t + 1}/${partition.teardownSteps.length}: ${step.name || step.elementName || step.type || 'Action'}`);
          await this.replayEngine.executeAction(step, stepIndex);
        }
      }

      manifest.status = this.isAborted
        ? 'STOPPED'
        : (this._collectionRestorationFailed
          ? 'FAILED'
          : (manifest.itemsFailed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'));
      if (this._collectionRestorationFailed && !manifest.error) {
        manifest.error = this._collectionRestorationError || 'Collection restoration failed';
      }
      manifest.endTime = new Date().toISOString();
      if (!this.isAborted) {
        this.writeLoopCheckpoint(manifest, null, null, currentPage, null, null);
      }
      logger.success(`\n[Loop Runner] Run ${this.runId} ${manifest.status}! Succeeded: ${manifest.itemsSucceeded}, Failed: ${manifest.itemsFailed}`);

    } catch (err) {
      manifest.status = this.isAborted ? 'STOPPED' : 'FAILED';
      manifest.error = err.message;
      manifest.endTime = new Date().toISOString();
      if (this.isAborted) {
        logger.warn(`[Loop Runner] Loop run ${this.runId} stopped by user.`);
      } else {
        logger.error(`[Loop Runner] Fatal run failure: ${err.message}`);
      }
    } finally {
      manifest.endTime = manifest.endTime || new Date().toISOString();
      if (this.isAborted) {
        manifest.status = 'STOPPED';
      }

      try {
        if (this.isAborted && this._lastCursor) {
          this.writeLoopCheckpoint(
            manifest,
            this._lastCursor.currentItemIndex,
            this._lastCursor.currentActionOffset,
            this._lastCursor.currentPage || currentPage,
            this._lastCursor.currentPageItemIndex,
            this._lastCursor.activeItem
          );
        } else if (manifest.status === 'COMPLETED' || manifest.status === 'COMPLETED_WITH_ERRORS') {
          this.writeLoopCheckpoint(manifest, null, null, currentPage, null, null);
        }
      } catch (cpErr) {
        logger.warn(`[Loop Runner] Warning writing final checkpoint: ${cpErr.message}`);
      }

      try {
        fs.writeFileSync(path.join(this.runsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      } catch (mfErr) {
        logger.warn(`[Loop Runner] Warning writing final manifest: ${mfErr.message}`);
      }

      if (this._replayTargetCreatedListener && this.replayEngine?.browser) {
        try {
          this.replayEngine.browser.off('targetcreated', this._replayTargetCreatedListener);
        } catch { }
        this._replayTargetCreatedListener = null;
      }

      if (this.artifactDownloadManager) {
        this.artifactDownloadManager.teardownDownloadInterception(this.replayEngine?.browser);
      }
      if (this.replayEngine) {
        await this.replayEngine.disconnect().catch(() => { });
      }

      onProgress({ status: manifest.status, manifest });
    }

    return manifest;
  }
}

module.exports = LoopReplayRunner;
