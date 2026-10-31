/**
 * ReFlow Runner Daemon
 * 
 * Continuous desktop automation daemon that:
 * 1. Verifies local Chrome CDP connection on port 9222
 * 2. Runs an HTTP polling loop every 10-15 seconds querying for pending cloud runs
 * 3. Claims runs atomically (pending -> running)
 * 4. Boots LoopReplayRunner with cloud workflow parameters and streams telemetry
 * 5. Handles 90-second Human-in-the-Loop (HITL) 2FA intervention:
 *    - Detects 2FA/OTP/challenge prompts
 *    - Updates cloud status to 'requires_action' with error_summary
 *    - Pauses replay, counts down 90s, resumes on authentication or marks failed on timeout
 * 6. Computes SHA-256 hashes of downloaded invoice PDFs (guaranteeing zero duplicates)
 * 7. Saves files locally in target_folder and registers artifacts in cloud
 * 
 * Zero external dependencies - pure Node.js CommonJS.
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { CloudClient } = require('./cloud-client');
const { ArtifactTracker, computeSha256, sanitizePortalName, resolvePortalStorageDir, resolveDefaultDownloadFolder } = require('./dedup-helper');
const { detect2FAChallenge, waitFor2FAResolution } = require('./hitl-detector');
const LoopDetector = require('../shared/loop-detector');

/**
 * Diagnostic check to verify if Chrome CDP is responding
 * @param {number} [port=9222]
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<{ responding: boolean, statusCode?: number, data?: any, error?: string }>}
 */
function checkCdpResponding(port = 9222, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/json/version`, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let versionData = null;
        try { versionData = JSON.parse(raw); } catch {}
        resolve({
          responding: res.statusCode === 200,
          statusCode: res.statusCode,
          data: versionData,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        responding: false,
        error: err.message,
        code: err.code,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        responding: false,
        error: 'CDP connection timed out',
        code: 'ETIMEDOUT',
      });
    });
  });
}

class RunnerDaemon {
  /**
   * @param {Object} options
   * @param {CloudClient|Object} [options.cloudClient] - Cloud client instance or configuration options
   * @param {number} [options.cdpPort=9222] - Chrome remote debugging port
   * @param {string} [options.cdpHost='127.0.0.1'] - Chrome remote debugging host
   * @param {number} [options.pollIntervalMs=10000] - Polling interval in ms (10-15s recommended)
   * @param {string} [options.targetFolder] - Base directory for downloaded artifacts
   * @param {number} [options.hitlTimeoutMs=90000] - HITL 2FA wait timeout (default: 90000ms = 90s)
   * @param {Object} [options.logger] - Optional custom logger
   */
  constructor(options = {}) {
    if (options.cloudClient instanceof CloudClient ||
       (options.cloudClient && (typeof options.cloudClient.getPendingRuns === 'function' || typeof options.cloudClient.updateRunStatus === 'function'))) {
      this.cloudClient = options.cloudClient;
    } else {
      this.cloudClient = new CloudClient(options.cloudClient || options);
    }

    this.cdpPort = options.cdpPort || 9222;
    this.cdpHost = options.cdpHost || '127.0.0.1';
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.targetFolder = options.targetFolder || process.env.REFLOW_TARGET_FOLDER || resolveDefaultDownloadFolder();
    this.hitlTimeoutMs = options.hitlTimeoutMs || 90000;

    this.logger = options.logger || {
      info: (...args) => console.log('[Daemon:INFO]', ...args),
      warn: (...args) => console.warn('[Daemon:WARN]', ...args),
      error: (...args) => console.error('[Daemon:ERROR]', ...args),
      success: (...args) => console.log('[Daemon:SUCCESS]', ...args),
    };

    this.isRunning = false;
    this.activeRun = null;
    this.currentRunner = null;
    this.isInHitl = false;
    this.isStoppingCurrentRun = false;
    this.artifactTracker = new ArtifactTracker();
    this._pollTimer = null;
    this._sleepResolve = null;
    this._heartbeatTimer = null;
  }

  /**
   * Check CDP availability
   */
  async checkCdp() {
    return checkCdpResponding(this.cdpPort, this.cdpHost);
  }

  /**
   * Start continuous polling loop
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.logger.info(`Starting ReFlow Runner Daemon (CDP port: ${this.cdpPort}, Poll interval: ${this.pollIntervalMs / 1000}s)`);
    this.logger.info(`Cloud API URL: ${this.cloudClient.baseUrl}`);

    // Initial CDP check
    const cdpStatus = await this.checkCdp();
    if (cdpStatus.responding) {
      this.logger.success(`Chrome CDP is responding on ${this.cdpHost}:${this.cdpPort} (${cdpStatus.data?.Browser || 'Chrome'})`);
    } else {
      this.logger.warn(`Chrome CDP not detected on port ${this.cdpPort}. Daemon will poll for runs, but browser execution requires Chrome running with --remote-debugging-port=${this.cdpPort}.`);
    }

    // Send initial heartbeat and start continuous heartbeat interval (every 10s)
    void this.cloudClient.sendHeartbeat({ cdp_active: cdpStatus.responding }).catch(() => {});
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const cdp = await this.checkCdp();
        await this.cloudClient.sendHeartbeat({ cdp_active: cdp.responding });
      } catch {
        // quiet background heartbeat error
      }
    }, 10000);

    // Polling loop
    while (this.isRunning) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error(`Error during polling cycle: ${err.message}`);
      }

      if (this.isRunning) {
        await this._sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Stop continuous polling loop
   */
  async stop() {
    this.logger.info('Stopping ReFlow Runner Daemon...');
    this.isRunning = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }

    // A pending _sleep() would otherwise never settle, leaving the poll loop suspended forever.
    if (this._sleepResolve) {
      const resolveSleep = this._sleepResolve;
      this._sleepResolve = null;
      resolveSleep();
    }

    if (this.currentRunner && typeof this.currentRunner.stop === 'function') {
      try {
        await this.currentRunner.stop();
      } catch (err) {
        this.logger.warn(`Error stopping active runner: ${err.message}`);
      }
    }

    this.activeRun = null;
    this.currentRunner = null;
    this.logger.info('Daemon stopped.');
  }

  /**
   * Single polling execution cycle
   * Queries pending runs, atomically claims one, and executes it.
   */
  async pollOnce() {
    if (this.activeRun) {
      // Busy executing a run
      return null;
    }

    let pendingRuns = [];
    try {
      pendingRuns = await this.cloudClient.getPendingRuns();
    } catch (err) {
      this.logger.warn(`Failed to poll pending runs: ${err.message}`);
      return null;
    }

    if (!Array.isArray(pendingRuns) || pendingRuns.length === 0) {
      return null;
    }

    this.logger.info(`Found ${pendingRuns.length} pending run(s). Attempting to claim...`);
    let claimedRun = null;
    let runToExecute = null;

    for (const candidate of pendingRuns) {
      try {
        claimedRun = await this.cloudClient.claimRun(candidate.id);
        runToExecute = claimedRun || candidate;
        break;
      } catch (err) {
        this.logger.warn(`Could not claim candidate run ${candidate.id} (status: ${err.status || 'err'}): ${err.message}`);
      }
    }

    if (!runToExecute) {
      return null;
    }

    return await this.executeRun(runToExecute);
  }

  /**
   * Execute a single claimed run
   * @param {Object} run - ExecutionRun record
   */
  async executeRun(run) {
    if (!run || !run.id) {
      throw new Error('executeRun requires a valid run record');
    }

    this.activeRun = run;
    let hitlInterval = null;

    try {
      this.logger.info(`Executing run ${run.id} for workflow: ${run.workflow_id}`);

      // Fetch workflow definition
      let workflow = run.workflow;
      if (!workflow && run.workflow_id) {
        try {
          workflow = await this.cloudClient.getWorkflow(run.workflow_id);
        } catch (err) {
          this.logger.warn(`Could not fetch workflow details for ${run.workflow_id}: ${err.message}`);
        }
      }

      // Extract workflow definition and normalize actions/steps
      const def = workflow?.workflow_definition || {};
      const steps = Array.isArray(def.steps) && def.steps.length > 0
        ? def.steps
        : (Array.isArray(def.actions) && def.actions.length > 0
          ? def.actions
          : (Array.isArray(workflow?.steps) && workflow.steps.length > 0
            ? workflow.steps
            : (Array.isArray(workflow?.actions) ? workflow.actions : [])));

      // Determine sanitized portal name
      const rawPortalName = workflow?.name || def.name || def.metadata?.name || workflow?.metadata?.name || run.workflow_name || 'DefaultPortal';
      const sanitizedPortalName = sanitizePortalName(rawPortalName);

      // Scan steps for actual action URL if portal_url is placeholder or generic
      const realStepUrl = steps.find(s => s && s.url && !s.url.startsWith('about:') && !s.url.startsWith('chrome://') && !s.url.includes('example.com'))?.url;

      const rawCandidateUrl = workflow?.portal_url ||
        def.portal_url ||
        def.metadata?.startUrl ||
        workflow?.metadata?.startUrl ||
        workflow?.startUrl ||
        workflow?.targetUrl;

      const startUrl = (rawCandidateUrl && !rawCandidateUrl.includes('example.com') && !rawCandidateUrl.startsWith('about:'))
        ? rawCandidateUrl
        : (realStepUrl || rawCandidateUrl || (steps[0] && steps[0].url) || 'about:blank');

      const metadata = def.metadata || workflow?.metadata || {
        name: rawPortalName,
        startUrl: startUrl,
      };

      const candidateStepIdx = LoopDetector.findLoopCandidateIndex(steps);
      const stepsHasLoop = steps.some(s => s && (s.role === 'LOOP' || s.isLoop || s.loopMode === 'sequential_iteration'));

      const isLoop = Boolean(
        run.is_loop === true ||
        run.isLoop === true ||
        run.mode === 'loop' ||
        def.metadata?.isLoop === true ||
        def.isLoop === true ||
        def.mode === 'loop' ||
        metadata.isLoop === true ||
        workflow?.isLoop === true ||
        stepsHasLoop ||
        (candidateStepIdx >= 0 && (run.mode === 'loop' || def.mode === 'loop' || !run.mode))
      );
      const mode = (run.mode === 'loop' || run.mode === 'single')
        ? run.mode
        : (isLoop ? 'loop' : (def.mode || 'single'));

      // Safely resolve filter object from candidate rules
      function resolveCandidateFilter(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;
        if (candidate.itemFilter) return resolveCandidateFilter(candidate.itemFilter);
        if (Array.isArray(candidate.conditions) && candidate.conditions.length > 0) return candidate;
        if (candidate.field || candidate.column || candidate.filterValue) return candidate;
        return null;
      }

      // Resolve filter and loop parameters from run, definition, and filter_rules
      const rawRunFilter = run.itemFilter ?? run.item_filter ?? null;
      const rawDefFilter = def.itemFilter ?? null;
      const rawWfFilter = resolveCandidateFilter(workflow?.filter_rules) ?? resolveCandidateFilter(def.filter_rules) ?? null;

      const itemFilter = (rawRunFilter !== null && rawRunFilter !== undefined)
        ? rawRunFilter
        : ((rawDefFilter !== null && rawDefFilter !== undefined)
            ? rawDefFilter
            : rawWfFilter);

      const rowFilter = run.rowFilter ??
        run.row_filter ??
        def.rowFilter ??
        itemFilter;

      const loopLimit = run.loopLimit ??
        run.loop_limit ??
        def.loopLimit ??
        def.maxItems ??
        (run.total_items_discovered > 0 ? run.total_items_discovered : null);

      let loopStepIndex = run.loopStepIndex ??
        run.loop_step_index ??
        def.loopStepIndex ??
        def.settings?.loopStepIndex ??
        workflow?.loopStepIndex ??
        null;

      if (loopStepIndex === null && isLoop) {
        if (candidateStepIdx >= 0) {
          loopStepIndex = candidateStepIdx;
        } else if (steps.length > 1) {
          loopStepIndex = 1;
        } else {
          loopStepIndex = 0;
        }
      }

      const uploadToCloud = Boolean(def.upload_to_cloud ?? workflow?.upload_to_cloud ?? false);

      // Determine target download directory organized by portal name
      const workflowTargetFolder = def.target_folder || workflow?.target_folder;
      let runTargetDir = resolvePortalStorageDir(this.targetFolder, sanitizedPortalName);

      if (workflowTargetFolder && typeof workflowTargetFolder === 'string' && workflowTargetFolder.trim().length > 0) {
        try {
          const { getSafeStorageBase } = require('../utils/storage-helper');
          const trimmed = workflowTargetFolder.trim();
          const customBase = path.isAbsolute(trimmed)
            ? trimmed
            : path.resolve(getSafeStorageBase(), trimmed);

          runTargetDir = path.basename(customBase).toLowerCase() === sanitizedPortalName.toLowerCase()
            ? customBase
            : path.join(customBase, sanitizedPortalName);

          if (!fs.existsSync(runTargetDir)) {
            fs.mkdirSync(runTargetDir, { recursive: true });
          }
        } catch (mkdirErr) {
          this.logger.warn(`Configured target folder '${workflowTargetFolder}' is inaccessible (${mkdirErr.message}). Falling back to '${runTargetDir}'.`);
        }
      }

      if (!fs.existsSync(runTargetDir)) {
        try {
          fs.mkdirSync(runTargetDir, { recursive: true });
        } catch (fallbackErr) {
          runTargetDir = path.join(os.tmpdir(), 'ReFlow', sanitizedPortalName);
          fs.mkdirSync(runTargetDir, { recursive: true });
        }
      }

      // Pre-load existing file hashes in target directory to prevent re-downloading duplicates
      this.artifactTracker.loadExistingHashesFromDir(runTargetDir);

      // Initialize LoopReplayRunner lazily
      let LoopReplayRunner;
      try {
        LoopReplayRunner = require('../replay/loop-replay-runner');
      } catch (err) {
        const errorMsg = `Failed to load LoopReplayRunner: ${err.message}`;
        this.logger.error(errorMsg);
        await this.cloudClient.updateRunStatus(run.id, 'failed', {
          error_summary: errorMsg,
          completed_at: new Date().toISOString(),
        }).catch(() => {});
        throw new Error(errorMsg);
      }

      const runner = new LoopReplayRunner({
        cdpPort: this.cdpPort,
        runId: run.id,
        workflowId: run.workflow_id,
        workflowName: sanitizedPortalName || rawPortalName || 'workflow',
        targetUrl: startUrl,
        structuredDownloadsDir: runTargetDir,
        baseDownloadsDir: path.dirname(runTargetDir),
        baseRunDir: path.join(path.dirname(runTargetDir), 'Run'),
        baseRecordingsDir: path.join(path.dirname(runTargetDir), 'recordings'),
        itemFilter: itemFilter,
        rowFilter: rowFilter,
        loopLimit: loopLimit,
        loopStepIndex: loopStepIndex,
        isLoop: isLoop,
        mode: mode,
        steps: steps,
      });
      this.currentRunner = runner;

      // Track execution telemetry
      let itemsProcessed = 0;
      let itemsDownloaded = 0;
      let totalItemsDiscovered = run.total_items_discovered > 0 ? run.total_items_discovered : 0;
      // Progress handler
      const onProgress = async (progress) => {
        if (progress && progress.manifest) {
          const m = progress.manifest;
          const computedProcessed = (m.itemsSucceeded || 0) + (m.itemsFailed || 0) + (m.itemsSkipped || 0);
          itemsProcessed = m.itemsProcessed ?? (computedProcessed > 0 ? computedProcessed : itemsProcessed);
          itemsDownloaded = m.itemsDownloaded ?? (Array.isArray(m.downloadedFiles) ? m.downloadedFiles.length : itemsDownloaded);
          if (Number.isInteger(m.itemsTotal) && m.itemsTotal > 0) {
            totalItemsDiscovered = m.itemsTotal;
          }
        }
        if (progress && Number.isInteger(progress.totalItems) && progress.totalItems > 0) {
          totalItemsDiscovered = progress.totalItems;
        }
        await this.cloudClient.updateRunProgress(run.id, {
          items_processed: itemsProcessed,
          items_downloaded: itemsDownloaded,
          total_items_discovered: totalItemsDiscovered,
        }).catch(err => {
          this.logger.warn(`Failed to update progress: ${err.message}`);
        });
      };

      // Background watchdog for 2FA challenge detection and remote cancellation
      let cancelWatchdogCounter = 0;
      hitlInterval = setInterval(async () => {
        if (this.isInHitl || !this.currentRunner) return;
        const page = this.currentRunner.replayEngine?.page;
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;

        // 1. Detect 2FA challenge
        try {
          const challenge = await detect2FAChallenge(page);
          if (challenge.detected) {
            await this.handleHitlIntervention(run.id, page, challenge);
          }
        } catch {
          // Ignore transient evaluation errors
        }

        // 2. Watch for remote cancellation every ~3 seconds
        cancelWatchdogCounter++;
        if (cancelWatchdogCounter % 2 === 0 && !this.isStoppingCurrentRun) {
          try {
            // Also check current run if not pending
            const remoteStatus = await this.cloudClient._request(`/api/v1/runs?workflow_id=${run.workflow_id}`, { method: 'GET' });
            const currentRecord = Array.isArray(remoteStatus?.runs) ? remoteStatus.runs.find((r) => r.id === run.id) : null;
            if (currentRecord && currentRecord.status === 'cancelled') {
              this.logger.warn(`Remote cancellation detected for run ${run.id}. Stopping local execution...`);
              await this.stopActiveRun();
            }
          } catch {
            // Ignore transient network errors during watchdog poll
          }
        }
      }, 1500);

      // Execute normalized workflow with explicit steps and start URL
      const effectiveWorkflow = {
        ...workflow,
        ...def,
        id: run.workflow_id || workflow?.id,
        name: rawPortalName,
        portal_url: startUrl,
        targetUrl: startUrl,
        startUrl: startUrl,
        steps: steps,
        actions: steps,
        metadata: metadata,
        recordingData: {
          actions: steps,
          metadata: metadata,
        },
        mode: mode,
        isLoop: isLoop,
        loopStepIndex: loopStepIndex,
        loop: run.loop || def.loop || workflow?.loop || (isLoop ? {
          enabled: true,
          anchorStepIndex: loopStepIndex,
          startStepIndex: loopStepIndex,
          endStepIndex: steps.length > 0 ? steps.length - 1 : 0,
          maxItems: loopLimit
        } : null),
        itemFilter: itemFilter,
        rowFilter: rowFilter,
        loopLimit: loopLimit,
      };

      this.logger.info(`Starting execution of "${rawPortalName}" (${steps.length} actions) on ${startUrl} [mode: ${mode}, isLoop: ${isLoop}, loopStepIndex: ${loopStepIndex}]`);
      const result = await runner.start(effectiveWorkflow, {
        onProgress,
        loopStepIndex: loopStepIndex,
        isLoop: isLoop,
        mode: mode,
      });

      // Clean up watchdog
      if (hitlInterval) {
        clearInterval(hitlInterval);
        hitlInterval = null;
      }

      // If run was stopped or aborted during execution, exit without overwriting cancelled status
      if (this.isStoppingCurrentRun || runner.isAborted) {
        this.logger.info(`Run ${run.id} was stopped by user.`);
        return { success: false, runId: run.id, status: 'cancelled' };
      }

      // Check downloaded artifacts, compute SHA-256, deduplicate, and register in cloud
      const newArtifacts = await this.collectAndRegisterArtifacts(
        run.id,
        runTargetDir,
        runner,
        sanitizedPortalName,
        uploadToCloud,
        result?.downloadedFiles || []
      );
      itemsDownloaded = Math.max(itemsDownloaded, newArtifacts.length);

      // Determine final run status.
      // The cloud API only accepts pending|running|requires_action|completed|failed|cancelled,
      // so a run with partial failures keeps the contract status 'completed' but must carry a
      // non-null error summary instead of silently reporting a clean success.
      const rawStatus = result?.status || null;
      const failedCount = Number(result?.itemsFailed) || 0;
      const completedWithErrors = rawStatus === 'COMPLETED_WITH_ERRORS' || (rawStatus === 'COMPLETED' && failedCount > 0);
      const isSuccess = !result?.error
        && rawStatus !== 'FAILED'
        && (rawStatus === 'COMPLETED' || rawStatus === 'COMPLETED_WITH_ERRORS' || rawStatus === null);
      const finalStatus = isSuccess ? 'completed' : 'failed';
      const errorSummary = result?.error
        || (completedWithErrors
          ? `${failedCount > 0 ? failedCount : 'One or more'} step(s) or item(s) failed during execution (runner status: ${rawStatus || 'COMPLETED_WITH_ERRORS'})`
          : null);
      const reportedStatus = rawStatus || finalStatus;

      await this.cloudClient.updateRunStatus(run.id, finalStatus, {
        items_processed: itemsProcessed,
        items_downloaded: itemsDownloaded,
        total_items_discovered: totalItemsDiscovered,
        completed_at: new Date().toISOString(),
        error_summary: errorSummary,
      });

      this.logger.success(`Run ${run.id} finished with status: ${reportedStatus} (${itemsDownloaded} artifact(s) registered)`);
      if (errorSummary) {
        this.logger.warn(`Run ${run.id} error summary: ${errorSummary}`);
      }
      return {
        success: isSuccess && !completedWithErrors,
        status: reportedStatus,
        error: errorSummary,
        runId: run.id,
        itemsDownloaded,
        itemsProcessed,
      };
    } catch (err) {
      if (hitlInterval) {
        clearInterval(hitlInterval);
        hitlInterval = null;
      }

      if (this.isStoppingCurrentRun || (this.currentRunner && this.currentRunner.isAborted)) {
        this.logger.info(`Run ${run.id} halted as cancelled.`);
        return { success: false, runId: run.id, status: 'cancelled' };
      }

      const errorMsg = err.message || 'Execution error';
      this.logger.error(`Run ${run.id} failed: ${errorMsg}`);

      await this.cloudClient.updateRunStatus(run.id, 'failed', {
        error_summary: errorMsg,
        completed_at: new Date().toISOString(),
      }).catch(() => {});

      throw err;
    } finally {
      if (hitlInterval) {
        clearInterval(hitlInterval);
        hitlInterval = null;
      }
      this.activeRun = null;
      this.currentRunner = null;
      this.isInHitl = false;
      this.isStoppingCurrentRun = false;
    }
  }

  /**
   * Stop currently active run mid-execution, close browser tab, and update cloud status to cancelled
   */
  async stopActiveRun() {
    if (!this.activeRun) {
      return { success: false, message: 'No active run executing' };
    }

    const runId = this.activeRun.id;
    this.logger.warn(`Stopping active run ${runId} by request...`);
    this.isStoppingCurrentRun = true;

    if (this.currentRunner) {
      try {
        await this.currentRunner.stop(true); // Close page tab
      } catch (err) {
        this.logger.warn(`Error stopping runner: ${err.message}`);
      }
    }

    try {
      await this.cloudClient.updateRunStatus(runId, 'cancelled', {
        error_summary: 'Stopped by user',
        completed_at: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(`Failed to update run status to cancelled: ${err.message}`);
    }

    this.activeRun = null;
    this.currentRunner = null;
    this.isInHitl = false;
    this.isStoppingCurrentRun = false;
    this.logger.success(`Active run ${runId} stopped and marked as cancelled.`);
    return { success: true, runId, status: 'cancelled' };
  }

  /**
   * Handle 90-second HITL 2FA intervention
   * @param {string} runId 
   * @param {any} page 
   * @param {Object} [challengeInfo] 
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.pollIntervalMs]
   * @param {boolean} [options.throwOnTimeout]
   * @returns {Promise<{ resolved: boolean, timedOut?: boolean }>}
   */
  async handleHitlIntervention(runId, page, challengeInfo = {}, options = {}) {
    this.isInHitl = true;
    try {
      const reasonText = challengeInfo?.reason ? ` (${challengeInfo.reason})` : '';
      this.logger.warn(`[HITL 2FA] 2FA/Authentication challenge detected on run ${runId}${reasonText}`);

      // Step 1: Update cloud status to requires_action
      const errorSummary = '2FA challenge detected: awaiting human verification';
      await this.cloudClient.updateRunStatus(runId, 'requires_action', {
        error_summary: errorSummary,
      }).catch(err => this.logger.warn(`Could not update 2FA status: ${err.message}`));

      // Step 2: Pause replay execution
      if (this.currentRunner?.replayEngine && typeof this.currentRunner.replayEngine.pause === 'function') {
        await this.currentRunner.replayEngine.pause('2FA Challenge');
      }

      const timeoutMs = options.timeoutMs || this.hitlTimeoutMs || 90000;
      const pollIntervalMs = options.pollIntervalMs || (options.timeoutMs ? Math.min(1000, Math.max(20, Math.floor(timeoutMs / 10))) : (this.hitlTimeoutMs ? Math.min(1000, Math.max(20, Math.floor(this.hitlTimeoutMs / 10))) : 1000));

      // Step 3: Wait up to 90 seconds for human intervention
      const result = await waitFor2FAResolution(page, {
        timeoutMs,
        pollIntervalMs,
        onTick: typeof options.onTick === 'function' ? options.onTick : (remainingSec) => {
          this.logger.info(`[HITL 2FA] Awaiting human verification... ${remainingSec}s remaining`);
        },
        checkAuth: typeof options.checkAuth === 'function' ? options.checkAuth : async (p) => {
          try {
            const { isSessionAuthenticated } = require('../shared/auth-detector');
            return await isSessionAuthenticated(p);
          } catch {
            return false;
          }
        },
      });

      if (result.resolved) {
        this.logger.success(`[HITL 2FA] Human verification completed in ${Math.round(result.elapsedMs / 1000)}s! Resuming execution...`);
        // Step 4: Resume execution and update cloud back to running
        await this.cloudClient.updateRunStatus(runId, 'running', {
          error_summary: null,
        }).catch(() => {});

        if (this.currentRunner?.replayEngine && typeof this.currentRunner.replayEngine.resume === 'function') {
          await this.currentRunner.replayEngine.resume();
        }
        return { resolved: true };
      } else {
        // Step 5: Timeout expired (90 seconds elapsed)
        const timeoutMsg = '2FA timeout: Human verification was not completed within 90 seconds';
        this.logger.error(`[HITL 2FA] ${timeoutMsg}`);

        await this.cloudClient.updateRunStatus(runId, 'failed', {
          error_summary: timeoutMsg,
          completed_at: new Date().toISOString(),
        }).catch(() => {});

        if (this.currentRunner && typeof this.currentRunner.stop === 'function') {
          await this.currentRunner.stop().catch(() => {});
        }

        if (options.throwOnTimeout === false) {
          return { resolved: false, timedOut: true };
        }

        const timeoutError = new Error(timeoutMsg);
        timeoutError.resolved = false;
        timeoutError.timedOut = true;
        throw timeoutError;
      }
    } finally {
      this.isInHitl = false;
    }
  }

  /**
   * Scan download directories, compute SHA-256, deduplicate, and register artifacts
   * @param {string} runId 
   * @param {string} targetDir 
   * @param {any} runner 
   * @param {string} [portalName]
   * @returns {Promise<Array<any>>} List of registered artifacts
   */
  async collectAndRegisterArtifacts(runId, targetDir, runner, portalName = null, uploadToCloud = false, manifestDownloads = []) {
    const registeredHashesInRun = new Set();
    const registered = [];

    // 1. Process files explicitly recorded in manifestDownloads
    if (Array.isArray(manifestDownloads) && manifestDownloads.length > 0) {
      for (const dl of manifestDownloads) {
        const filePath = dl.path;
        if (!filePath || !fs.existsSync(filePath)) continue;

        const hash = dl.fileHash || computeSha256(filePath);
        if (registeredHashesInRun.has(hash)) continue;

        let finalPath = filePath;
        // Ensure file is copied to targetDir if not already in targetDir
        if (targetDir && !filePath.startsWith(targetDir)) {
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          const destName = dl.filename || path.basename(filePath);
          const destPath = path.join(targetDir, destName);
          if (filePath !== destPath && !fs.existsSync(destPath)) {
            try {
              fs.copyFileSync(filePath, destPath);
              finalPath = destPath;
            } catch (copyErr) {
              this.logger.warn(`Could not copy artifact to targetDir: ${copyErr.message}`);
            }
          } else if (fs.existsSync(destPath)) {
            finalPath = destPath;
          }
        }

        const sizeBytes = dl.sizeBytes || (fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0);
        const fileName = dl.filename || path.basename(finalPath);

        this.artifactTracker.recordHash(hash);
        registeredHashesInRun.add(hash);

        let cloudStoragePath = null;
        if (uploadToCloud) {
          try {
            this.logger.info(`[Hybrid Storage] Uploading artifact to cloud: ${fileName}`);
            const uploadRes = await this.cloudClient.uploadArtifact(runId, finalPath, {
              file_name: fileName,
              file_size_bytes: sizeBytes,
              sha256_hash: hash,
            });
            cloudStoragePath = uploadRes?.cloud_storage_path || null;
            if (cloudStoragePath) {
              this.logger.success(`[Hybrid Storage] Uploaded to cloud storage: ${cloudStoragePath}`);
            } else {
              this.logger.warn(`[Hybrid Storage] Cloud storage unavailable for ${fileName}. Registering as local artifact.`);
            }
          } catch (uploadErr) {
            this.logger.warn(`[Hybrid Storage] Cloud upload failed: ${uploadErr.message}. Registering as local artifact.`);
          }
        }

        try {
          const registeredArtifact = await this.cloudClient.registerArtifact(runId, {
            file_name: fileName,
            file_size_bytes: sizeBytes,
            sha256_hash: hash,
            storage_path: finalPath,
            cloud_storage_path: cloudStoragePath,
            item_metadata: {
              source: 'desktop-runner',
              run_id: runId,
              portal: portalName || 'DefaultPortal',
              discovered_at: new Date().toISOString(),
              uploaded_to_cloud: Boolean(cloudStoragePath),
              item_key: dl.itemKey || null,
              category: dl.category || null,
            },
          });
          this.logger.success(`Registered artifact: ${fileName} [SHA-256: ${hash.substring(0, 10)}...] (Storage: ${cloudStoragePath ? 'Cloud' : 'Local'})`);
          registered.push(registeredArtifact);
        } catch (err) {
          this.logger.warn(`Failed to register artifact in cloud: ${err.message}`);
        }
      }
    }

    // 2. Scan directoriesToScan as fallback for any newly created files whose hash is not yet in registeredHashesInRun
    const directoriesToScan = new Set();
    if (fs.existsSync(targetDir)) directoriesToScan.add(targetDir);
    if (runner?.runsDir && fs.existsSync(runner.runsDir)) directoriesToScan.add(runner.runsDir);
    if (runner?.downloadsDir && fs.existsSync(runner.downloadsDir)) directoriesToScan.add(runner.downloadsDir);

    for (const dir of directoriesToScan) {
      const files = this.artifactTracker.scanDirectory(dir);
      for (const fileRecord of files) {
        // Exclude internal manifests or state files
        if (fileRecord.fileName.toLowerCase() === 'manifest.json' || fileRecord.fileName.endsWith('.json')) {
          continue;
        }

        const fileHash = computeSha256(fileRecord.filePath);
        if (registeredHashesInRun.has(fileHash)) {
          continue;
        }

        const artifactResult = this.artifactTracker.processAndSaveArtifact(
          fileRecord.filePath,
          targetDir,
          fileRecord.fileName
        );

        if (artifactResult.isDuplicate || registeredHashesInRun.has(artifactResult.hash)) {
          this.logger.info(`[Deduplication] Skipping duplicate file: ${artifactResult.fileName} (SHA-256: ${artifactResult.hash.substring(0, 12)}...)`);
          continue;
        }

        registeredHashesInRun.add(artifactResult.hash);

        let cloudStoragePath = null;
        if (uploadToCloud) {
          try {
            this.logger.info(`[Hybrid Storage] Uploading artifact to cloud: ${artifactResult.fileName}`);
            const uploadRes = await this.cloudClient.uploadArtifact(runId, artifactResult.targetPath, {
              file_name: artifactResult.fileName,
              file_size_bytes: artifactResult.sizeBytes,
              sha256_hash: artifactResult.hash,
            });
            cloudStoragePath = uploadRes?.cloud_storage_path || null;
            if (cloudStoragePath) {
              this.logger.success(`[Hybrid Storage] Uploaded to cloud storage: ${cloudStoragePath}`);
            } else {
              this.logger.warn(`[Hybrid Storage] Cloud storage unavailable for ${artifactResult.fileName}. Registering as local artifact.`);
            }
          } catch (uploadErr) {
            this.logger.warn(`[Hybrid Storage] Cloud upload failed: ${uploadErr.message}. Registering as local artifact.`);
          }
        }

        try {
          const registeredArtifact = await this.cloudClient.registerArtifact(runId, {
            file_name: artifactResult.fileName,
            file_size_bytes: artifactResult.sizeBytes,
            sha256_hash: artifactResult.hash,
            storage_path: artifactResult.targetPath,
            cloud_storage_path: cloudStoragePath,
            item_metadata: {
              source: 'desktop-runner',
              run_id: runId,
              portal: portalName || 'DefaultPortal',
              discovered_at: new Date().toISOString(),
              uploaded_to_cloud: Boolean(cloudStoragePath),
            },
          });
          this.logger.success(`Registered artifact: ${artifactResult.fileName} [SHA-256: ${artifactResult.hash.substring(0, 10)}...] (Storage: ${cloudStoragePath ? 'Cloud' : 'Local'})`);
          registered.push(registeredArtifact);
        } catch (err) {
          this.logger.warn(`Failed to register artifact in cloud: ${err.message}`);
        }
      }
    }

    return registered;
  }

  /**
   * Execute a specific workflow immediately by ID
   * @param {string} workflowId 
   * @param {Object} [options]
   */
  async executeWorkflow(workflowId, options = {}) {
    this.logger.info(`Fetching workflow: ${workflowId}`);
    const workflow = await this.cloudClient.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const syntheticRun = {
      id: `run_local_${Date.now()}`,
      workflow_id: workflowId,
      org_id: workflow.org_id || 'local',
      workflow,
    };

    return await this.executeRun(syntheticRun);
  }

  _sleep(ms) {
    return new Promise(resolve => {
      this._sleepResolve = resolve;
      this._pollTimer = setTimeout(() => {
        this._pollTimer = null;
        this._sleepResolve = null;
        resolve();
      }, ms);
    });
  }
}

module.exports = RunnerDaemon;
RunnerDaemon.RunnerDaemon = RunnerDaemon;
RunnerDaemon.checkCdpResponding = checkCdpResponding;
RunnerDaemon.computeSha256 = computeSha256;
RunnerDaemon.detect2FAChallenge = detect2FAChallenge;
RunnerDaemon.waitFor2FAResolution = waitFor2FAResolution;
RunnerDaemon.sanitizePortalName = sanitizePortalName;
RunnerDaemon.resolvePortalStorageDir = resolvePortalStorageDir;

