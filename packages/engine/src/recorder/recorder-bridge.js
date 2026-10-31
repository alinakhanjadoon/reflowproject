/**
 * Recorder Bridge (Node.js)
 * 
 * Attaches to Chrome CDP, injects the recorder and selector resolver,
 * collects emitted actions from the page, and persists them to recording.json.
 */

const fs = require('fs');
const path = require('path');
const { connectToBrowser } = require('../utils/cdp-connector');
const SelectorResolver = require('../shared/selector-resolver');
const logger = require('../utils/logger');
const { isInternalBrowserUrl, isDashboardUrl, extractWorkflowStartUrl } = require('../utils/url-helper');
const { getSafeStoragePath, safeMkdir } = require('../utils/storage-helper');

/**
 * Recursively collect all frames within a page or frame hierarchy at any nesting depth
 */
function getAllFramesRecursive(pageOrFrame) {
  const result = [];
  const visited = new Set();
  const walk = (item) => {
    if (!item || visited.has(item)) return;
    visited.add(item);
    result.push(item);
    const children = typeof item.childFrames === 'function' ? item.childFrames() : [];
    for (const child of children) {
      walk(child);
    }
  };
  if (!pageOrFrame) return result;
  if (typeof pageOrFrame.frames === 'function') {
    for (const f of pageOrFrame.frames()) {
      walk(f);
    }
  } else {
    walk(pageOrFrame);
  }
  return result;
}

class RecorderBridge {
  constructor(options = {}) {
    this.name = options.name || `recording-${Date.now()}`;
    this.browserURL = options.browserURL || 'http://localhost:9222';
    this.outputDir = options.outputDir || getSafeStoragePath('recordings');
    this.browser = null;
    this.page = null;
    this.actions = [];
    this.isRecording = false;
    this.isPaused = false;
    this._pausedAt = null;
    this._pausedIntervals = [];
    this.onSave = typeof options.onSave === 'function' ? options.onSave : null;
    this.startedAt = null;
    this.startUrl = null;
  }

  /**
   * Initialize and start recording session
   */
  async start() {
    logger.header(`Starting Workflow Recorder: ${this.name}`);

    // Connect to Chrome
    const { browser, page } = await connectToBrowser({ browserURL: this.browserURL });
    this.browser = browser;
    this.page = page;

    try {
      this.startUrl = (typeof this.page.url === 'function' ? this.page.url() : '') || 'about:blank';
    } catch {
      this.startUrl = 'about:blank';
    }
    this.startedAt = new Date().toISOString();
    this.isRecording = true;
    this.isPaused = false;
    this._pausedAt = null;
    this._pausedIntervals = [];
    this.actions = [];

    // Register this instance with static shared registry for action routing
    RecorderBridge._activeInstances.add(this);

    this._sessionId = `rec_sess_${Date.now()}`;

    // 1. Read selector-resolver.js and recorder-injected.js source code
    const resolverPath = path.resolve(__dirname, '../shared/selector-resolver.js');
    const recorderPath = path.resolve(__dirname, './recorder-injected.js');
    this._resolverCode = fs.readFileSync(resolverPath, 'utf8');
    this._recorderCode = fs.readFileSync(recorderPath, 'utf8');
    this._unifiedScript = `${this._resolverCode}\n;\nwindow.__workflowCaptureSessionId = "${this._sessionId}";\n${this._recorderCode}`;

    this._attachedPages = new Set();
    this._pageCleanups = [];
    this._handledUids = new Set();

    // 2. Attach to ALL existing open pages and tabs concurrently so clicks in ANY tab are immediately captured
    const existingPages = await this.browser.pages().catch(() => [this.page]);
    await Promise.allSettled(
      existingPages
        .filter((p) => p && !p.isClosed())
        .map((p) => this._attachToPage(p).catch((err) => {
          logger.warn(`[Recorder] Tab attach warning: ${err?.message || err}`);
        }))
    );

    // 3. Auto-attach to newly opened tabs, popups, or auxiliary windows
    this._onTargetCreated = async (target) => {
      if (!this.isRecording) return;
      const targetType = typeof target?.type === 'function' ? target.type() : target?.type;
      if (targetType === 'page') {
        try {
          let newPage = await target.page().catch(() => null);
          if (!newPage) {
            // Wait briefly for target initialization if page object isn't immediately ready
            await new Promise((r) => setTimeout(r, 120));
            newPage = await target.page().catch(() => null);
          }
          if (newPage && !newPage.isClosed()) {
            let pUrl = '';
            try { pUrl = newPage.url(); } catch { pUrl = target.url(); }
            logger.info(`[Recorder] New window/popup detected: ${pUrl || 'new tab'}`);
            await this._attachToPage(newPage);
          }
        } catch (err) {
          logger.warn(`[Recorder] Failed to attach to new target: ${err.message}`);
        }
      }
    };
    this.browser.on('targetcreated', this._onTargetCreated);

    // 5. Start safe, non-overlapping frame sweep loop to guarantee all dynamic iframes (e.g. DevExpress ReportViewer) are continuously injected
    this._startFrameSweepLoop();

    logger.success(`Recorder successfully attached to tab: ${this.startUrl}`);
    logger.info('Perform your actions in the Chrome window. Press Enter or Ctrl+C in this terminal when finished.');
  }

  /**
   * Continuous, non-overlapping async frame sweep loop that inspects and injects into newly mounted iframes
   */
  _startFrameSweepLoop() {
    this._sweepRunning = true;
    const sweep = async () => {
      while (this.isRecording && this._sweepRunning) {
        try {
          if (this._attachedPages) {
            for (const p of this._attachedPages) {
              if (!this.isRecording || !this._sweepRunning) break;
              if (!p || p.isClosed()) continue;

              const frames = getAllFramesRecursive(p);
              for (const frame of frames) {
                if (!this.isRecording || !this._sweepRunning) break;
                if (!frame || frame.isDetached()) continue;

                const fName = frame.name() || frame.url() || 'unnamed';
                try {
                  const isLoaded = await Promise.race([
                    frame.evaluate((sessId) => (
                      window.__workflowCaptureSessionId === sessId &&
                      window.__workflowCaptureReady === true &&
                      window.__workflowCaptureDocRef === document &&
                      typeof document !== 'undefined' &&
                      document.__workflowCaptureDocReady === true &&
                      typeof window.SelectorResolver !== 'undefined'
                    ), this._sessionId),
                    new Promise((resolve) => setTimeout(() => resolve(false), 800))
                  ]).catch((err) => {
                    logger.warn(`[Recorder][Sweep] Readiness check evaluate failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
                    return false;
                  });

                  if (!isLoaded && this.isRecording && this._sweepRunning) {
                    await Promise.race([
                      frame.evaluate(this._unifiedScript),
                      new Promise((resolve) => setTimeout(() => resolve(null), 2500))
                    ]).catch((err) => {
                      logger.warn(`[Recorder][Sweep] Script injection evaluate failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
                    });

                    let nowReady = false;
                    for (const delay of [0, 60, 180]) {
                      if (delay > 0) await new Promise(r => setTimeout(r, delay));
                      nowReady = await frame.evaluate(() => (
                        window.__workflowCaptureReady === true &&
                        window.__workflowCaptureDocRef === document &&
                        typeof document !== 'undefined' &&
                        document.__workflowCaptureDocReady === true
                      )).catch((err) => {
                        logger.warn(`[Recorder][Sweep] Verification check evaluate failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
                        return false;
                      });
                      if (nowReady) break;
                    }

                    if (nowReady) {
                      const fname = frame.name() || (frame._id ? `frame-${frame._id.slice(0, 8)}` : null) || frame.url().slice(0, 50);
                      if (fname) {
                        if (!this._reportedFrames) this._reportedFrames = new Set();
                        if (!this._reportedFrames.has(fname)) {
                          this._reportedFrames.add(fname);
                          logger.info(`[Recorder] Toolbar / child iframe ready for capture: ${fname}`);
                        }
                      }
                    }
                  }
                } catch (err) {
                  logger.warn(`[Recorder][Sweep] Frame loop error on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
                }
              }
            }
          }
        } catch (err) {
          logger.warn(`[Recorder][Sweep] Sweep iteration error: ${err?.message || err}`);
        }

        if (!this.isRecording || !this._sweepRunning) break;
        await new Promise(r => setTimeout(r, 200));
      }
    };
    sweep().catch((err) => {
      logger.warn(`[Recorder] Frame sweep loop crashed: ${err?.message || err}`);
    });
  }

  _stopFrameSweepLoop() {
    this._sweepRunning = false;
  }

  async _updateInjectedUi() {
    if (!this._attachedPages) return;
    const state = { count: this.actions.length, isPaused: this.isPaused };
    for (const page of this._attachedPages) {
      if (!page || page.isClosed()) continue;
      await page.mainFrame().evaluate((uiState) => {
        if (typeof window.__workflowCaptureUpdateUI === 'function') {
          window.__workflowCaptureUpdateUI(uiState);
        }
      }, state).catch(() => {});
    }
  }

  async _setPaused(paused) {
    const nextPaused = Boolean(paused);
    if (!this.isRecording || this.isPaused === nextPaused) return this.isPaused;
    if (nextPaused) {
      this.isPaused = true;
      this._pausedAt = Date.now();
    }
    if (this._attachedPages) {
      await Promise.allSettled([...this._attachedPages].filter((page) => page && !page.isClosed()).map((page) =>
        page.evaluateOnNewDocument((pausedState) => {
          window.__workflowCapturePaused = pausedState;
          if (typeof window.__workflowCaptureSetPaused === 'function') {
            window.__workflowCaptureSetPaused(pausedState);
          }
        }, nextPaused)
      ));
    }
    if (this._attachedPages) {
      const frames = [];
      for (const page of this._attachedPages) {
        if (!page || page.isClosed()) continue;
        frames.push(...getAllFramesRecursive(page));
      }
      await Promise.allSettled(frames.map((frame) => frame.evaluate((nextPaused) => {
        if (typeof window.__workflowCaptureSetPaused === 'function') {
          window.__workflowCaptureSetPaused(nextPaused);
        }
      }, nextPaused)));
    }
    if (!nextPaused && this._pausedAt) {
      this._pausedIntervals.push([this._pausedAt, Date.now()]);
      this._pausedAt = null;
    }
    this.isPaused = nextPaused;
    logger.info(this.isPaused ? 'Workflow recording paused.' : 'Workflow recording resumed.');
    await this._updateInjectedUi();
    return this.isPaused;
  }

  pause() {
    return this._setPaused(true);
  }

  resume() {
    return this._setPaused(false);
  }

  /**
   * Attach recorder and selector resolver to a specific Page instance and all its frames
   */
  async _attachToPage(page) {
    if (!page || page.isClosed() || this._attachedPages.has(page)) return;
    try {
      const pUrl = (typeof page.url === 'function' ? page.url() : '') || '';
      if (isDashboardUrl(pUrl)) {
        return; // Never record actions on the workflow capture dashboard itself
      }
    } catch {}
    this._attachedPages.add(page);

    // 1. PRIMARY BULLETPROOF TRANSPORT: Listen for actions emitted via console
    // Works reliably from any frame, child frame, iframe, or execution context
    const onConsoleMessage = (msg) => {
      const text = msg.text();
      if (text && text.includes('__WORKFLOW_CAPTURE_ACTION__:')) {
        try {
          const idx = text.indexOf('__WORKFLOW_CAPTURE_ACTION__:');
          const jsonStr = text.slice(idx + '__WORKFLOW_CAPTURE_ACTION__:'.length).trim();
          const payload = JSON.parse(jsonStr);
          for (const inst of RecorderBridge._activeInstances) {
            if (inst && inst.isRecording) {
              inst._handleCapturedAction(payload);
            }
          }
        } catch (e) {
          logger.warn(`[Recorder] Failed to parse console action: ${e.message}`);
        }
      }
    };
    page.on('console', onConsoleMessage);
    this._pageCleanups.push(() => {
      if (!page.isClosed()) page.off('console', onConsoleMessage);
    });

    // 2. Expose action collector bridge function to window context with routing to active instance
    try {
      await page.exposeFunction('__workflowCaptureEmitAction', (actionPayload) => {
        for (const inst of RecorderBridge._activeInstances) {
          if (inst && inst.isRecording) {
            inst._handleCapturedAction(actionPayload);
          }
        }
      });
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn(`[Recorder] Bridge expose warning on page: ${err.message}`);
      }
    }

    const exposeControl = async (name, handler) => {
      try {
        await page.exposeFunction(name, handler);
      } catch (err) {
        if (!err.message.includes('already exists')) {
          logger.warn(`[Recorder] Could not expose ${name}: ${err.message}`);
        }
      }
    };
    await exposeControl('__workflowCapturePause', () => this.pause());
    await exposeControl('__workflowCaptureResume', () => this.resume());
    await exposeControl('__workflowCaptureSave', async () => {
      if (!this.isRecording) return null;
      return this.onSave ? this.onSave() : this.stop();
    });

    // Register unified script to evaluate on every new document (persists across navigations/reloads)
    await page.evaluateOnNewDocument(this._unifiedScript).catch((err) => {
      logger.warn(`[Recorder][Attach] evaluateOnNewDocument failed on page (${page.url()}): ${err?.message || err}`);
    });

    // Evaluate immediately on current document if already loaded
    await page.evaluate(this._unifiedScript).catch((err) => {
      logger.warn(`[Recorder][Attach] Immediate injection failed on ${page.url()}: ${err.message}`);
    });

    // Helper to inject unified recorder script into any child frame (including nested iframes)
    const injectIntoFrame = async (frame) => {
      if (!this.isRecording || !frame || frame.isDetached()) return;
      const fName = frame.name() || frame.url() || 'unnamed';
      try {
        const isLoaded = await Promise.race([
          frame.evaluate((sessId) => (
            window.__workflowCaptureSessionId === sessId &&
            window.__workflowCaptureReady === true &&
            window.__workflowCaptureDocRef === document &&
            typeof document !== 'undefined' &&
            document.__workflowCaptureDocReady === true &&
            typeof window.SelectorResolver !== 'undefined'
          ), this._sessionId),
          new Promise((resolve) => setTimeout(() => resolve(false), 800))
        ]).catch((err) => {
          logger.warn(`[Recorder][Frame] Readiness check failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
          return false;
        });

        if (!isLoaded) {
          await Promise.race([
            frame.evaluate(this._unifiedScript),
            new Promise((resolve) => setTimeout(() => resolve(null), 2500))
          ]).catch((err) => {
            logger.warn(`[Recorder][Frame] Script injection failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
          });

          // Confirm injection actually succeeded by reading back readiness, retrying with backoff if still false
          let verified = false;
          for (const delay of [0, 80, 200, 450]) {
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
            verified = await frame.evaluate(() => (
              window.__workflowCaptureReady === true &&
              window.__workflowCaptureDocRef === document &&
              typeof document !== 'undefined' &&
              document.__workflowCaptureDocReady === true
            )).catch((err) => {
              logger.warn(`[Recorder][Frame] Post-injection verify failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
              return false;
            });
            if (verified) break;
            // Retry injection on failure
            await frame.evaluate(this._unifiedScript).catch((err) => {
              logger.warn(`[Recorder][Frame] Retry script injection failed on frame "${fName}" (${frame.url()}): ${err?.message || err}`);
            });
          }

          if (verified) {
            const fname = frame.name() || (frame._id ? `frame-${frame._id.slice(0, 8)}` : null) || frame.url().slice(0, 50);
            if (fname) {
              if (!this._reportedFrames) this._reportedFrames = new Set();
              if (!this._reportedFrames.has(fname)) {
                this._reportedFrames.add(fname);
                logger.info(`[Recorder] Toolbar / child iframe ready for capture: ${fname}`);
              }
            }
          }
        }

        // Recursively ensure all child frames are also walked and injected
        const children = typeof frame.childFrames === 'function' ? frame.childFrames() : [];
        for (const child of children) {
          await injectIntoFrame(child);
        }
      } catch (err) {
        logger.warn(`[Recorder][Frame] injectIntoFrame threw on frame "${fName}" (${frame?.url?.()}): ${err?.message || err}`);
      }
    };

    // DevExpress and ExtJS dynamically create iframes and populate scripts asynchronously.
    // Retry injection across 10 seconds after frame attach/navigation and recursively across all nesting levels.
    const scheduleFrameInjection = (targetFrame) => {
      const allFrames = getAllFramesRecursive(targetFrame);
      for (const f of allFrames) {
        const delays = [0, 150, 600];
        for (const d of delays) {
          if (d === 0) {
            injectIntoFrame(f);
          } else {
            setTimeout(() => {
              if (this.isRecording && !f.isDetached()) {
                injectIntoFrame(f);
              }
            }, d);
          }
        }
      }
    };

    const onFrameAttached = (frame) => scheduleFrameInjection(frame);
    const onFrameNavigated = (frame) => {
      if (isInternalBrowserUrl(this.startUrl) && frame && typeof frame.url === 'function') {
        const navigatedUrl = frame.url();
        if (navigatedUrl && !isInternalBrowserUrl(navigatedUrl)) {
          this.startUrl = navigatedUrl;
          logger.info(`[Recorder] Updated workflow startUrl to navigated URL: ${this.startUrl}`);
        }
      }
      scheduleFrameInjection(frame);
    };
    page.on('frameattached', onFrameAttached);
    page.on('framenavigated', onFrameNavigated);

    this._pageCleanups.push(() => {
      if (!page.isClosed()) {
        page.off('frameattached', onFrameAttached);
        page.off('framenavigated', onFrameNavigated);
      }
    });

    const initialFrames = getAllFramesRecursive(page);
    await Promise.allSettled(initialFrames.map(f => injectIntoFrame(f)));
    for (const frame of initialFrames) {
      scheduleFrameInjection(frame);
    }
  }

  /**
   * Internal handler for actions emitted from in-page script.
   * Returns true if action was captured and stored, false if ignored or deduplicated.
   */
  _handleCapturedAction(rawAction) {
    if (!this.isRecording || !rawAction) return false;
    const capturedAt = Number(rawAction.captureTimestamp) || Number(rawAction.timestamp) || Date.now();
    if (this.isPaused || (this._pausedAt && capturedAt >= this._pausedAt) ||
        this._pausedIntervals.some(([startedAt, endedAt]) => capturedAt >= startedAt && capturedAt <= endedAt)) {
      return false;
    }

    // Deduplicate actions emitted via both console transport and direct binding
    if (rawAction.uid) {
      if (!this._handledUids) this._handledUids = new Set();
      if (this._handledUids.has(rawAction.uid)) return false;
      this._handledUids.add(rawAction.uid);
    }

    const actionIndex = this.actions.length;
    const prevTimestamp = actionIndex > 0 ? this.actions[actionIndex - 1].timestamp : rawAction.timestamp;
    const timeDeltaMs = rawAction.timestamp - prevTimestamp;

    // Consolidate rapid double-clicks on the same target element within 450ms
    if (this.actions.length > 0 && (rawAction.type === 'DOUBLE_CLICK' || rawAction.detail === 2)) {
      const lastAction = this.actions[this.actions.length - 1];
      const isSameTarget = lastAction.target && rawAction.target &&
        ((lastAction.target.fingerprint?.id && lastAction.target.fingerprint.id === rawAction.target.fingerprint?.id) ||
          (lastAction.target.candidates?.[0]?.value && lastAction.target.candidates[0].value === rawAction.target.candidates?.[0]?.value) ||
          (lastAction.target.fingerprint?.tagName && lastAction.target.fingerprint.tagName === rawAction.target.fingerprint?.tagName));

      if (isSameTarget && timeDeltaMs < 450) {
        lastAction.type = 'DOUBLE_CLICK';
        lastAction.timestamp = rawAction.timestamp;
        logger.info(`[Recorder] Consolidated rapid clicks into DOUBLE_CLICK for step #${lastAction.index + 1}`);
        return true;
      }
    }

    // Consolidate rapid consecutive SCROLL actions on the same target/window within 1200ms
    if (this.actions.length > 0 && rawAction.type === 'SCROLL') {
      const lastAction = this.actions[this.actions.length - 1];
      if (lastAction.type === 'SCROLL') {
        const sameTarget = (lastAction.isWindow && rawAction.isWindow) ||
          (lastAction.target?.candidates?.[0]?.value && lastAction.target.candidates[0].value === rawAction.target?.candidates?.[0]?.value);
        if (sameTarget && timeDeltaMs < 1200) {
          lastAction.scrollX = rawAction.scrollX;
          lastAction.scrollY = rawAction.scrollY;
          lastAction.timestamp = rawAction.timestamp;
          if (rawAction.scrollOffset) lastAction.scrollOffset = rawAction.scrollOffset;
          logger.info(`[Recorder] Consolidated consecutive SCROLL for step #${lastAction.index + 1} (x=${rawAction.scrollX}, y=${rawAction.scrollY})`);
          return true;
        }
      }
    }

    // Discard duplicate rapid single clicks on the same target within 150ms (event bubbling or dual trigger)
    if (this.actions.length > 0 && rawAction.type === 'CLICK') {
      const lastAction = this.actions[this.actions.length - 1];
      if (lastAction.type === 'CLICK' && timeDeltaMs < 150) {
        const isSameTarget = lastAction.target && rawAction.target &&
          ((lastAction.target.fingerprint?.id && lastAction.target.fingerprint.id === rawAction.target.fingerprint?.id) ||
            (lastAction.target.candidates?.[0]?.value && lastAction.target.candidates[0].value === rawAction.target.candidates?.[0]?.value) ||
            (lastAction.target.fingerprint?.tagName && lastAction.target.fingerprint.tagName === rawAction.target.fingerprint?.tagName &&
              lastAction.target.fingerprint?.text === rawAction.target.fingerprint?.text));
        if (isSameTarget) {
          logger.warn(`[Recorder] Discarded duplicate click event within ${timeDeltaMs}ms on <${lastAction.target.fingerprint?.tagName}>`);
          return false;
        }
      }
    }

    const elementName = rawAction.name ||
      rawAction.elementName ||
      rawAction.target?.elementName ||
      rawAction.target?.friendlyName ||
      (SelectorResolver.generateFriendlyName ? SelectorResolver.generateFriendlyName(null, rawAction.target?.fingerprint) : null) ||
      'Element';

    // Discard password visibility toggle clicks (e.g. eye icon, toggle password)
    if (rawAction.type === 'CLICK' || rawAction.type === 'DOUBLE_CLICK') {
      const targetText = (rawAction.target?.fingerprint?.text || '').toLowerCase().trim();
      const targetType = (rawAction.target?.fingerprint?.type || '').toLowerCase();
      const isLoginOrSubmit = targetType === 'submit' || /(log ?in|sign ?in|submit|continue|next|enter|proceed|register|sign ?up)/i.test(targetText);
      if (!isLoginOrSubmit) {
        const targetAria = (rawAction.target?.fingerprint?.attributes?.['aria-label'] || '').toLowerCase();
        const targetTitle = (rawAction.target?.fingerprint?.attributes?.title || '').toLowerCase();
        const explicitTogglePattern = /(show|hide|toggle|reveal|view)\s*(password|pin|credentials?)|password\s*(visibility|toggle|reveal)/i;
        const targetId = (rawAction.target?.fingerprint?.id || '').toLowerCase();
        const eyeClassPattern = /(fa-eye|fa-eye-slash|bi-eye|lucide-eye|feather-eye|icon-eye|eye-icon|password-toggle|toggle-password)/i;
        if (explicitTogglePattern.test(targetAria) || explicitTogglePattern.test(targetTitle) || eyeClassPattern.test(targetId)) {
          logger.info(`[Recorder] Discarded password visibility toggle action on <${elementName}>`);
          return false;
        }
      }
    }

    if (rawAction.target && typeof rawAction.target === 'object') {
      rawAction.target.elementName = elementName;
      rawAction.target.friendlyName = elementName;
    }

    const isCheckbox = Boolean(
      rawAction.isCheckbox ||
      rawAction.target?.isCheckbox ||
      rawAction.target?.fingerprint?.isCheckbox ||
      rawAction.target?.fingerprint?.type === 'checkbox' ||
      rawAction.target?.fingerprint?.role === 'checkbox' ||
      rawAction.target?.fingerprint?.tagName === 'mat-pseudo-checkbox' ||
      elementName.toLowerCase().includes('checkbox')
    );
    let desiredState = undefined;
    if (isCheckbox) {
      if (rawAction.isUncheck === true || rawAction.action === 'UNCHECK') {
        desiredState = false;
      } else if (rawAction.desiredState !== undefined) {
        if (rawAction.desiredState === false && rawAction.target?.fingerprint?.checked !== true) {
          // Element was not checked prior to click; clicking it was meant to check it (default ON)
          desiredState = true;
        } else {
          desiredState = Boolean(rawAction.desiredState);
        }
      } else if (rawAction.checked !== undefined) {
        desiredState = Boolean(rawAction.checked);
      } else {
        desiredState = true; // Default ON for any checkbox interaction
      }
    } else if (rawAction.desiredState !== undefined) {
      desiredState = Boolean(rawAction.desiredState);
    } else if (rawAction.checked !== undefined) {
      desiredState = Boolean(rawAction.checked);
    }

    // Update startUrl if currently internal/blank and action is from a real page
    const actionUrl = rawAction.url || rawAction.frame?.location || (rawAction.target?.fingerprint?.attributes?.href?.startsWith('http') ? rawAction.target.fingerprint.attributes.href : null);
    if (isInternalBrowserUrl(this.startUrl) && actionUrl && !isInternalBrowserUrl(actionUrl)) {
      this.startUrl = actionUrl;
      logger.info(`[Recorder] Updated workflow startUrl from action location: ${this.startUrl}`);
    }

    const action = {
      id: `act_${actionIndex + 1}_${Date.now().toString(36)}`,
      index: actionIndex,
      name: elementName,
      elementName: elementName,
      type: rawAction.type,
      timestamp: rawAction.timestamp,
      timeDeltaMs,
      target: rawAction.target,
      ...(rawAction.url ? { url: rawAction.url } : {}),
      ...(rawAction.frame ? { frame: rawAction.frame } : {}),
      ...(isCheckbox ? { isCheckbox: true, desiredState: desiredState !== false, checked: desiredState !== false } : (desiredState !== undefined ? { desiredState: Boolean(desiredState), checked: Boolean(desiredState) } : {})),
      ...(rawAction.key ? { key: rawAction.key } : {}),
      ...(rawAction.value !== undefined ? { value: rawAction.value } : {}),
      ...(rawAction.scrollX !== undefined ? { scrollX: rawAction.scrollX } : {}),
      ...(rawAction.scrollY !== undefined ? { scrollY: rawAction.scrollY } : {}),
      ...(rawAction.isWindow !== undefined ? { isWindow: rawAction.isWindow } : {}),
      ...(rawAction.scrollOffset ? { scrollOffset: rawAction.scrollOffset } : {}),
      ...(rawAction.meta ? { meta: rawAction.meta } : {}),
      ...(rawAction.context ? { context: rawAction.context } : {}),
      ...(rawAction.columns ? { columns: rawAction.columns } : {}),
      ...(rawAction.options ? { options: rawAction.options } : {}),
      ...(rawAction.selectOptions ? { selectOptions: rawAction.selectOptions } : {}),
      ...(rawAction.table ? { table: rawAction.table } : {}),
      ...(rawAction.fieldValues ? { fieldValues: rawAction.fieldValues } : {}),
      ...(rawAction.fieldName ? { fieldName: rawAction.fieldName } : {}),
      ...(rawAction.columnName ? { columnName: rawAction.columnName } : {}),
      ...(rawAction.sampleValue !== undefined ? { sampleValue: rawAction.sampleValue } : {})
    };

    this.actions.push(action);
    this._updateInjectedUi().catch(() => {});

    // Terminal log
    const topCandidate = action.target?.candidates?.[0]?.value || 'none';
    let detail = action.key ? `key="${action.key}"` : (action.value ? `value="${action.value}"` : `target="${elementName}"`);
    if (action.type === 'SCROLL') {
      detail = `x=${action.scrollX ?? 0}, y=${action.scrollY ?? 0}`;
    } else if (isCheckbox && desiredState !== undefined) {
      detail = `checkbox state=${desiredState ? 'CHECKED' : 'UNCHECKED'}`;
    }
    logger.action(actionIndex + 1, action.type, `"${elementName}" (${topCandidate})`, detail);
    return true;
  }

  /**
   * Consolidate all captured step contexts into a top-level filter_rules object
   * containing available_fields (and columns) and fieldValues (distinct column values).
   */
  consolidateFilterRules() {
    const fieldsSet = new Set();
    const fieldValuesMap = {};

    const EXPANDER_GLYPH_REGEX = /^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i;

    const addField = (raw) => {
      if (typeof raw !== 'string') return null;
      let str = raw.trim();
      if (!str || str.length > 60 || str.startsWith('{') || str.startsWith('<') || EXPANDER_GLYPH_REGEX.test(str)) return null;
      str = str.replace(/^(click|select|enter|type|open|download|view|press)\s+/i, '').trim();
      if (!str || str.length > 60) return null;
      fieldsSet.add(str);
      return str;
    };

    const addFieldValue = (field, val) => {
      const cleanField = addField(field);
      if (!cleanField || val == null) return;
      let str = String(val).trim().replace(/\s+/g, ' ');
      if (!str || str.length > 100 || EXPANDER_GLYPH_REGEX.test(str)) return;
      str = str.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
      str = str.replace(/[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/, '').trim();
      if (!str) return;

      if (!fieldValuesMap[cleanField]) {
        fieldValuesMap[cleanField] = new Set();
      }
      fieldValuesMap[cleanField].add(str);
    };

    const actionsList = Array.isArray(this.actions) ? this.actions : [];
    for (const act of actionsList) {
      if (!act) continue;

      if (act.fieldName || act.columnName) {
        const f = addField(act.fieldName || act.columnName);
        if (f && act.sampleValue !== undefined) {
          addFieldValue(f, act.sampleValue);
        }
      }

      // 1. From action.context (in-page sniffing)
      if (act.context) {
        if (Array.isArray(act.context.columns)) {
          act.context.columns.forEach(addField);
        }
        if (act.context.table) {
          if (Array.isArray(act.context.table.headers)) {
            act.context.table.headers.forEach(addField);
          }
          if (Array.isArray(act.context.table.columns)) {
            act.context.table.columns.forEach(addField);
          }
          if (act.context.table.rowValues && typeof act.context.table.rowValues === 'object') {
            for (const [col, vals] of Object.entries(act.context.table.rowValues)) {
              if (Array.isArray(vals)) {
                vals.forEach(v => addFieldValue(col, v));
              }
            }
          }
          if (act.context.table.activeRowValues && typeof act.context.table.activeRowValues === 'object') {
            for (const [col, v] of Object.entries(act.context.table.activeRowValues)) {
              addFieldValue(col, v);
            }
          }
        }
        if (act.context.fieldValues && typeof act.context.fieldValues === 'object') {
          for (const [col, vals] of Object.entries(act.context.fieldValues)) {
            if (Array.isArray(vals)) {
              vals.forEach(v => addFieldValue(col, v));
            }
          }
        }
      }

      // 2. From action.columns / action.table / action.fieldValues
      if (Array.isArray(act.columns)) {
        act.columns.forEach(addField);
      }
      if (act.table && Array.isArray(act.table.headers)) {
        act.table.headers.forEach(addField);
      }
      if (act.fieldValues && typeof act.fieldValues === 'object') {
        for (const [col, vals] of Object.entries(act.fieldValues)) {
          if (Array.isArray(vals)) {
            vals.forEach(v => addFieldValue(col, v));
          }
        }
      }

      // 3. Dropdown / options
      const targetCol = act.extract_column || act.column || act.field ||
        act.target?.fingerprint?.columnName || act.fingerprint?.columnName ||
        act.target?.fingerprint?.headerName || act.fingerprint?.headerName ||
        act.context?.table?.activeColumn ||
        (act.context?.fieldValues && Object.keys(act.context.fieldValues)[0]);

      const opts = act.options || act.selectOptions || act.context?.options;
      if (Array.isArray(opts) && opts.length > 0) {
        const optField = targetCol || act.name || act.elementName || 'Type';
        opts.forEach(opt => {
          const optText = typeof opt === 'string' ? opt : (opt.text || opt.label || opt.value);
          addFieldValue(optField, optText);
        });
      }

      // 4. Value
      if (act.value && typeof act.value === 'string' && !act.value.startsWith('{{')) {
        if (targetCol) {
          addFieldValue(targetCol, act.value);
        }
        if (/SI-|INV-|DR-|TX-|CM-|\b\d{4,10}\b/i.test(act.value)) {
          addFieldValue('Invoice Number', act.value);
        }
      }
    }

    const finalFieldValues = {};
    for (const [k, valSet] of Object.entries(fieldValuesMap)) {
      finalFieldValues[k] = Array.from(valSet).slice(0, 50);
    }

    const available_fields = Array.from(fieldsSet);
    return {
      available_fields,
      columns: available_fields,
      fieldValues: finalFieldValues
    };
  }

  /**
   * Stop recording, flush in-page buffers, and write recording.json
   */
  async stop() {
    if (!this.isRecording) return null;

    logger.info('Stopping recording and flushing pending input buffers...');

    this._stopFrameSweepLoop();

    if (this._onTargetCreated && this.browser) {
      this.browser.off('targetcreated', this._onTargetCreated);
      this._onTargetCreated = null;
    }

    if (this._pageCleanups) {
      for (const cleanup of this._pageCleanups) {
        try { cleanup(); } catch (err) {
          logger.warn(`[Recorder] Page cleanup error: ${err?.message || err}`);
        }
      }
      this._pageCleanups = [];
    }

    // Helper to race a promise against a timeout
    const withTimeout = (promise, ms = 400) => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      });
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {});
      }
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    // 1. Attempt to flush any active typing buffers across all frames concurrently with 400ms timeout race, prioritizing main page
    if (this._attachedPages) {
      const allFrames = [];
      for (const p of this._attachedPages) {
        if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;
        allFrames.push(...getAllFramesRecursive(p));
      }

      const flushPromises = allFrames.map((frame) => {
        const fName = (typeof frame.name === 'function' ? frame.name() : null) || (typeof frame.url === 'function' ? frame.url() : 'unnamed');
        return withTimeout(
          frame.evaluate(() => {
            if (typeof window.__workflowCaptureFlushBuffer === 'function') {
              window.__workflowCaptureFlushBuffer();
            }
          }),
          400
        ).catch((err) => {
          logger.warn(`[Recorder] Flush buffer notice on frame "${fName}": ${err?.message || err}`);
        });
      });

      if (this.page && (typeof this.page.isClosed !== 'function' || !this.page.isClosed())) {
        flushPromises.unshift(
          withTimeout(
            this.page.evaluate(() => {
              if (typeof window.__workflowCaptureFlushBuffer === 'function') {
                window.__workflowCaptureFlushBuffer();
              }
            }),
            400
          ).catch((err) => {
            logger.warn(`[Recorder] Primary page flush buffer notice: ${err?.message || err}`);
          })
        );
      }

      await Promise.allSettled(flushPromises);
    }

    // 2. Allow short breather for in-flight postMessage events to reach Node.js bridge
    await new Promise(r => setTimeout(r, 100));

    // 3. Mark recording as finished
    this.isRecording = false;
    this.isPaused = false;
    this._pausedAt = null;
    RecorderBridge._activeInstances.delete(this);

    const completedAt = new Date().toISOString();
    let viewport = { width: 1280, height: 800 };
    let userAgent = 'unknown';

    if (this.page && (typeof this.page.isClosed !== 'function' || !this.page.isClosed())) {
      try {
        viewport = await this.page.viewport() || viewport;
        userAgent = await this.page.evaluate(() => navigator.userAgent).catch((err) => {
          logger.warn(`[Recorder] Failed to read userAgent: ${err?.message || err}`);
          return 'unknown';
        });
      } catch (err) {
        logger.warn(`[Recorder] Failed to get page viewport: ${err?.message || err}`);
      }
    }

    let finalStartUrl = this.startUrl;
    if (isInternalBrowserUrl(finalStartUrl)) {
      const extracted = extractWorkflowStartUrl({ actions: this.actions, metadata: { startUrl: this.startUrl } });
      if (extracted) {
        finalStartUrl = extracted;
      }
    }

    // Consolidate all captured step contexts into top-level filter_rules
    const filter_rules = this.consolidateFilterRules();
    this.filter_rules = filter_rules;

    const hasExtractTable = this.actions.some(a => a && (a.type === 'EXTRACT_TABLE' || a.action === 'EXTRACT_TABLE'));
    const isLoopDetected = Boolean(hasExtractTable);
    const tableStepIdx = isLoopDetected ? this.actions.findIndex(a => a && (a.type === 'EXTRACT_TABLE' || a.action === 'EXTRACT_TABLE')) : null;

    // Decouple heavy synchronous loop detection from the critical Save path:
    // Persist raw actions immediately, flagging loop mode if EXTRACT_TABLE was recorded
    const recording = {
      metadata: {
        recordingId: `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        version: '1.0.0',
        name: this.name,
        startedAt: this.startedAt,
        completedAt,
        startUrl: finalStartUrl,
        userAgent,
        viewport,
        isLoop: isLoopDetected,
        loopStepIndex: tableStepIdx,
        loopConfidence: isLoopDetected ? 1 : 0,
        confidenceCategory: isLoopDetected ? 'HIGH' : 'NONE',
        patternType: isLoopDetected ? 'table_extract' : 'none',
        mode: isLoopDetected ? 'LOOP' : 'STANDARD',
        filter_rules,
        loopMetadata: {
          loopDetected: isLoopDetected,
          reasons: isLoopDetected ? ['User recorded EXTRACT_TABLE step'] : [],
          signals: isLoopDetected ? ['EXTRACT_TABLE'] : []
        },
        loop_metadata: {
          loopDetected: isLoopDetected,
          reasons: isLoopDetected ? ['User recorded EXTRACT_TABLE step'] : [],
          signals: isLoopDetected ? ['EXTRACT_TABLE'] : []
        }
      },
      loop_metadata: {
        loopDetected: isLoopDetected,
        reasons: isLoopDetected ? ['User recorded EXTRACT_TABLE step'] : [],
        signals: isLoopDetected ? ['EXTRACT_TABLE'] : []
      },
      filter_rules,
      actions: this.actions
    };

    // Ensure output directory exists safely
    if (!fs.existsSync(this.outputDir)) {
      try { safeMkdir(this.outputDir); } catch {}
    }

    const sanitizedName = this.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const filePath = path.join(this.outputDir, `${sanitizedName}.json`);

    // In-page Stop UI cleanup helper
    const cleanupStopUI = async () => {
      if (!this._attachedPages) return;
      const frames = [];
      for (const page of this._attachedPages) {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) continue;
        frames.push(...getAllFramesRecursive(page));
      }
      await Promise.allSettled(
        frames.map((frame) => withTimeout(
          frame.evaluate(() => {
            if (typeof window.__workflowCaptureStopUI === 'function') {
              window.__workflowCaptureStopUI();
            }
          }),
          200
        ).catch(() => {}))
      ).catch(() => {});
    };

    // Guard: If 0 actions were captured and a previous valid recording exists, do NOT overwrite it
    if (this.actions.length === 0 && fs.existsSync(filePath)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(existingData.actions) && existingData.actions.length > 0) {
          logger.warn(`[Recorder] No new actions captured. Preserving existing recording with ${existingData.actions.length} action(s) for "${sanitizedName}".`);
          await cleanupStopUI();
          logger.divider();
          logger.success(`Workflow recording preserved: ${filePath}`);
          logger.info(`Total actions in workflow: ${existingData.actions.length}`);
          try { await this.browser.disconnect(); } catch {}
          return filePath;
        }
      } catch {}
    }

    fs.writeFileSync(filePath, JSON.stringify(recording, null, 2), 'utf8');

    // Trigger in-page Stop UI cleanup across all attached pages before disconnecting
    await cleanupStopUI();

    logger.divider();
    logger.success(`Workflow recording saved: ${filePath}`);
    logger.info(`Total actions captured: ${this.actions.length}`);

    // Disconnect (do not close the user's Chrome session!)
    if (this.browser) {
      await this.browser.disconnect().catch(() => {});
      logger.info('Disconnected from Chrome (Chrome instance remains running).');
    }

    return filePath;
  }
}

RecorderBridge._activeInstances = new Set();

module.exports = RecorderBridge;
