/**
 * Replay Engine (Node.js)
 * 
 * Orchestrates condition-based playback of recorded actions against
 * an existing Chrome session via CDP, enhanced with humanized mouse trajectories,
 * stochastic keystroke dynamics, and anti-captcha stealth evasion.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { connectToBrowser } = require('../utils/cdp-connector');
const { DEFAULT_TIMEOUTS } = require('../shared/constants');
const {
  ElementResolutionTimeoutError,
  ActionExecutionError,
  AutomationError
} = require('../utils/errors');
const { dispatchAction } = require('./action-executors');
const { getActiveBotConfig } = require('../shared/bot-config');
const { resolveTargetUrl, extractWorkflowStartUrl, isInternalBrowserUrl } = require('../utils/url-helper');
const logger = require('../utils/logger');
const { detectLoginSequence, isSessionAuthenticated } = require('../shared/auth-detector');
const InterruptionHandler = require('./interruption-handler');
const TabManager = require('./tab-manager');
const { getSafeStoragePath, safeMkdir } = require('../utils/storage-helper');
const ActionDispatcher = require('./action-dispatcher');

/**
 * Detect if an action targets an ephemeral, programmatic download anchor (<a href="blob:..." download>)
 * created dynamically by website scripts (e.g. Export/Download buttons) and immediately removed.
 */
function isTransientProgrammaticDownloadAction(action) {
  if (!action || (action.type !== 'CLICK' && action.action !== 'CLICK')) return false;
  const fp = action.target?.fingerprint || action.fingerprint || (action.target?.tagName ? action.target : {});
  const tag = (fp.tagName || '').toLowerCase();
  if (tag !== 'a') return false;

  const href = (fp.attributes?.href || fp.href || '').toLowerCase();
  const isBlob = href.startsWith('blob:') || href.includes('blob:');
  const isZeroSize = (fp.dimensions && fp.dimensions.width === 0 && fp.dimensions.height === 0);
  const candidates = action.target?.candidates || [];
  const isBodyChild = candidates.some(c => c.value && (c.value.includes('body > a') || c.value.includes('/body/a')));
  const hasNoText = !fp.text || fp.text.trim().length === 0;

  return (isBlob || isZeroSize) && (isBodyChild || isZeroSize) && hasNoText;
}

class ReplayEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.browserURL = options.browserURL || (options.cdpPort ? `http://127.0.0.1:${options.cdpPort}` : 'http://localhost:9222');
    this.speed = options.speed || 1.0; // Speed multiplier (1.0 = real-time, 2.0 = 2x, etc.)
    this.botConfig = options.botConfig || getActiveBotConfig();
    this.timeoutMs = options.timeoutMs || this.botConfig?.resolution?.timeoutMs || DEFAULT_TIMEOUTS.RESOLUTION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs || this.botConfig?.resolution?.pollIntervalMs || DEFAULT_TIMEOUTS.POLL_INTERVAL_MS;
    this.stepDelayMs = options.stepDelayMs || options.stepDelay || 0;
    this.secretResolver = options.secretResolver || null; // async function(secretId) => plaintext
    this.browser = null;
    this.page = null;
    this.isAborted = false;
    this.currentActionIndex = 0;
    this.isAutomatedActionActive = false;
    this.lastIntervention = null;
    this.isPaused = false;
    this.isLocked = false;
    this.enableDisturbanceDetection = options.enableDisturbanceDetection === true;
    this._guardPages = new Set();
    this._guardScriptIds = new Map();

    // Universal Interruption Handler & Intelligent Tab Manager
    this.downloadsDir = options.downloadsDir || getSafeStoragePath('downloads');
    this.interruptionHandler = new InterruptionHandler({
      autoAcceptDialogs: options.autoAcceptDialogs !== false
    });
    this.tabManager = new TabManager({
      interruptionHandler: this.interruptionHandler,
      downloadsDir: this.downloadsDir
    });
    this.extractedRowFields = {};
  }

  resetExtractedRowFields() {
    this.extractedRowFields = {};
  }

  getExtractedRowFields() {
    return { ...(this.extractedRowFields || {}) };
  }

  /**
   * Signal abort to halt execution
   */
  async abort() {
    this.isAborted = true;
    this.isPaused = false;
    await this._syncReplayGuard();
    logger.warn('[Replay Engine] Abort signal triggered.');
  }

  async pause(reason = 'manual') {
    if (this.isAborted || this.isPaused) return;
    this.isPaused = true;
    this.emit('paused', { reason });
    await this._syncReplayGuard();
  }

  async resume() {
    if (this.isAborted || !this.isPaused) return;
    this.isPaused = false;
    this.emit('resumed');
    await this._syncReplayGuard();
  }

  async setLocked(locked) {
    this.isLocked = !!locked;
    await this._syncReplayGuard();
  }

  async _waitWhilePaused() {
    while (this.isPaused && !this.isAborted) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.isAborted) throw new Error('Execution stopped by user');
  }

  /**
   * Safely dismiss open popups, overlays, or dropdowns via Escape key without triggering disturbance detection.
   * Only presses Escape if an actual ephemeral backdrop, dropdown, or context menu is present in the DOM.
   */
  async dismissOverlays() {
    if (!this.page || this.page.isClosed()) return;
    try {
      if (this.interruptionHandler) {
        await this.interruptionHandler.dismissBlockingOverlays(this.page).catch(() => {});
      }
      const hasDismissibleOverlay = await this.page.evaluate(() => {
        const overlaySelectors = [
          '.cdk-overlay-backdrop',
          '.modal-backdrop',
          '.mat-select-panel',
          '[role="listbox"]',
          '.x-menu:not(.x-hidden)',
          '.dropdown-menu.show',
          '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
          '.dx-overlay-content:not([style*="display: none"])'
        ];
        return overlaySelectors.some(sel => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.some(el => {
            if (el.offsetParent === null && el.tagName.toLowerCase() !== 'body') return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          });
        });
      }).catch(() => false);

      if (!hasDismissibleOverlay) return;

      await this._setAutomatedAction(true, { key: 'Escape' });
      await this.page.keyboard.press('Escape').catch(() => {});
      await new Promise(r => setTimeout(r, 200));
    } finally {
      await this._setAutomatedAction(false);
    }
  }

  /**
   * Clean up guard listeners, teardown in-page scripts, and disconnect from browser
   */
  async disconnect() {
    try {
      this.tabManager?.destroy();
    } catch {}
    try {
      await this._teardownReplayGuard();
    } catch {}
    if (this.browser) {
      try {
        await this.browser.disconnect();
        logger.info('Disconnected from Chrome (session preserved).');
      } catch {}
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Wait for any transient SPA/ExtJS loading masks or spinners to disappear
   */
  async _waitForLoadingMasks(timeoutMs = 8000) {
    if (!this.page) return;
    try {
      await this.page.waitForFunction(() => {
        const masks = Array.from(document.querySelectorAll('.x-mask, .x-mask-loading, .x-mask-msg, .loading-mask, .spinner-overlay, [aria-busy="true"]'));
        return !masks.some(m => {
          if (m.offsetParent === null) return false;
          const style = window.getComputedStyle(m);
          return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
        });
      }, { timeout: timeoutMs }).catch(() => {});
    } catch {}
  }

  /**
   * Load and validate a recording JSON file from disk
   */
  loadRecording(recordingPath) {
    const fullPath = path.resolve(process.cwd(), recordingPath);
    if (!fs.existsSync(fullPath)) {
      throw new AutomationError(`Recording file not found: ${fullPath}`);
    }

    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const recording = JSON.parse(raw);

      if (!recording.metadata || !Array.isArray(recording.actions)) {
        throw new Error('Missing "metadata" or "actions" array in recording JSON');
      }

      return recording;
    } catch (err) {
      throw new AutomationError(`Failed to parse recording JSON: ${err.message}`, { path: fullPath });
    }
  }

  /**
   * Inject anti-detection / anti-captcha evasion scripts into page
   */
  async _applyStealthEvasion() {
    if (!this.page || !this.botConfig?.stealth) return;
    const stealth = this.botConfig.stealth;

    if (!this._stealthPages) {
      this._stealthPages = new WeakSet();
    }

    try {
      if (!this._stealthPages.has(this.page)) {
        if (typeof this.page.evaluateOnNewDocument === 'function') {
          await this.page.evaluateOnNewDocument((cfg) => {
            if (cfg.maskWebdriver) {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
                configurable: true
              });
            }

            if (cfg.emulateChromeRuntime) {
              if (!window.chrome) {
                window.chrome = {
                  runtime: {},
                  app: {},
                  csi: () => {},
                  loadTimes: () => {}
                };
              }
            }

            if (cfg.emulatePlugins) {
              if (navigator.plugins.length === 0) {
                const mockPlugins = [
                  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                ];
                Object.defineProperty(navigator, 'plugins', {
                  get: () => mockPlugins,
                  configurable: true
                });
              }
            }
          }, stealth).catch(() => {});
        }
        this._stealthPages.add(this.page);
      }

      await this.page.evaluate((cfg) => {
        if (cfg.maskWebdriver) {
          // Remove navigator.webdriver flag
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true
          });
        }

        if (cfg.emulateChromeRuntime) {
          // Emulate standard window.chrome
          if (!window.chrome) {
            window.chrome = {
              runtime: {},
              app: {},
              csi: () => {},
              loadTimes: () => {}
            };
          }
        }

        if (cfg.emulatePlugins) {
          // Mask empty plugins array commonly found in automated Headless Chrome
          if (navigator.plugins.length === 0) {
            const mockPlugins = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
            Object.defineProperty(navigator, 'plugins', {
              get: () => mockPlugins,
              configurable: true
            });
          }
        }
      }, stealth);
    } catch {}
  }

  /**
   * Connects to the browser via CDP and prepares active tab
   */
  async connect() {
    const { browser, page } = await connectToBrowser({
      browserURL: this.browserURL
    });
    this.browser = browser;
    this.page = page;
    await this._applyStealthEvasion();

    // Enable automated background file downloads to safe downloads directory
    try {
      const downloadDir = this.downloadsDir || getSafeStoragePath('downloads');
      safeMkdir(downloadDir);
      if (this.browser) {
        try {
          const browserTarget = (typeof this.browser.targets === 'function' ? this.browser.targets().find(t => t.type() === 'browser') : null) || (typeof this.browser.target === 'function' ? this.browser.target() : null);
          if (browserTarget && typeof browserTarget.createCDPSession === 'function') {
            const browserClient = await browserTarget.createCDPSession();
            await browserClient.send('Browser.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: downloadDir,
              eventsEnabled: true
            }).catch(() => {});
          }
        } catch {}
      }
      const client = await this.page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir
      }).catch(() => {});
    } catch {}

    if (this.enableDisturbanceDetection) {
      await this._initHumanDisturbanceDetection(this.page);
    } else {
      await this._cleanupLingeringReplayGuard(this.page);
    }

    // Initialize intelligent tab tracking & dialog interception
    if (this.tabManager) {
      await this.tabManager.initialize(this.browser, this.page, this.recording);
      if (this.tabManager.getPrimaryPage()) {
        this.page = this.tabManager.getPrimaryPage();
      }
    }
    if (this.interruptionHandler && this.page) {
      this.interruptionHandler.attachToPage(this.page);
    }

    return this.browser;
  }

  /**
   * Helper to cleanup lingering replay guard UI and attached handlers from a page.
   */
  async _cleanupLingeringReplayGuard(page) {
    if (!page || page.isClosed()) return;
    try {
      await page.evaluate(() => {
        if (typeof window.__reflowStopReplayGuard === 'function') {
          window.__reflowStopReplayGuard();
        }
        const host = document.getElementById('__reflow-replay-guard');
        if (host) host.remove();
        window.__reflowInterventionAttached = false;
        window.__reflowReplayPaused = false;
        window.__reflowReplayLocked = false;
      }).catch(() => {});
    } catch {}
  }

  /**
   * Inject and initialize real-time human disturbance detection on the target page.
   * Tracks manual user mouse clicks, keystrokes, and touch events when automated replay is idle.
   */
  async _initHumanDisturbanceDetection(page) {
    if (!this.enableDisturbanceDetection) {
      await this._cleanupLingeringReplayGuard(page);
      return;
    }
    if (!page || page.isClosed() || this._guardPages.has(page)) return;

    try {
      await page.exposeFunction('__reflowReportIntervention', (eventDetail) => {
        this._handleHumanIntervention(eventDetail);
      });
    } catch (err) {
      if (!err.message || !err.message.includes('already exists')) {
        logger.warn(`[ReplayEngine] Intervention binding warning: ${err.message}`);
      }
    }

    for (const [name, handler] of [
      ['__reflowResumeReplay', () => this.resume()],
      ['__reflowStopReplay', () => this.abort()],
      ['__reflowSetReplayLock', (locked) => this.setLocked(locked)]
    ]) {
      try { await page.exposeFunction(name, handler); } catch {}
    }

    const injectionScript = `
      (function() {
        window.__reflowAutomatedActionActive = false;
        window.__reflowAutomatedSince = 0;
        window.__reflowReplayPaused = ${this.isPaused};
        window.__reflowReplayLocked = ${this.isLocked};
        if (window.__reflowInterventionAttached) { window.__reflowUpdateReplayGuard && window.__reflowUpdateReplayGuard(); return; }
        window.__reflowInterventionAttached = true;
        var host = null;
        if (window === window.top) {
          host = document.createElement('div');
          host.id = '__reflow-replay-guard';
          host.style.cssText = 'all:initial;position:fixed;top:18px;right:18px;z-index:2147483647;font:13px/1.4 Inter,system-ui,sans-serif;color:#eef2ff;';
          var shadow = host.attachShadow({mode:'open'});
          shadow.innerHTML = '<style>*{box-sizing:border-box} .card{width:270px;padding:12px 14px;background:#20283a;border:1px solid #39445b;border-radius:15px;box-shadow:0 12px 34px #10162655;display:flex;gap:10px;align-items:center}.dot{width:9px;height:9px;border-radius:50%;background:#42d392;box-shadow:0 0 12px #42d39288;flex:none}.paused .dot{background:#f5a742;box-shadow:0 0 12px #f5a74288}.copy{flex:1;min-width:0}.title{font-weight:700;font-size:12px}.sub{color:#aab5ca;font-size:11px;margin-top:2px}.actions{display:flex;gap:6px;margin-top:9px}.actions[hidden]{display:none}button{border:1px solid #46536e;border-radius:7px;background:#2b354b;color:#eef2ff;padding:5px 9px;font:600 11px system-ui;cursor:pointer}button:hover{background:#394660}.lock{margin-top:8px}.lock.on{border-color:#ed7777;color:#ffb3b3}.stop{color:#ffb3b3}</style><div class="card"><i class="dot"></i><div class="copy"><div class="title"></div><div class="sub"></div><button class="lock"></button><div class="actions" hidden><button class="resume">Resume</button><button class="stop">Stop</button></div></div></div>';
          if (document.documentElement) document.documentElement.appendChild(host);
          else document.addEventListener('DOMContentLoaded', function(){ if(document.documentElement) document.documentElement.appendChild(host); }, {once:true});
          shadow.querySelector('.resume').addEventListener('click', () => window.__reflowResumeReplay && window.__reflowResumeReplay());
          shadow.querySelector('.stop').addEventListener('click', () => window.__reflowStopReplay && window.__reflowStopReplay());
          shadow.querySelector('.lock').addEventListener('click', () => window.__reflowSetReplayLock && window.__reflowSetReplayLock(!window.__reflowReplayLocked));
          window.__reflowReplayGuardHost = host;
          window.__reflowUpdateReplayGuard = function() {
            var card=shadow.querySelector('.card'), actions=shadow.querySelector('.actions');
            card.classList.toggle('paused', !!window.__reflowReplayPaused);
            shadow.querySelector('.title').textContent=window.__reflowReplayPaused?'Workflow paused':'Automation running';
            shadow.querySelector('.sub').textContent=window.__reflowReplayPaused
              ? (window.__reflowReplayLocked?'Input blocked. Resume when ready.':'Workflow paused. Resume when ready.')
              : (window.__reflowReplayLocked?'Input lock is on':'Interact with the site to pause');
            var lock=shadow.querySelector('.lock');
            lock.textContent=window.__reflowReplayLocked?'Input lock: On':'Input lock: Off';
            lock.classList.toggle('on', !!window.__reflowReplayLocked);
            actions.hidden=!window.__reflowReplayPaused;
          };
          window.__reflowUpdateReplayGuard();
        }
        var onHumanInput = function(evt) {
          if (host && evt.composedPath().includes(host)) return;
          var expected = window.__reflowAutomatedTarget;
          var expectedKey = window.__reflowAutomatedKey;
          var now = Date.now();

          var isAutomated = false;
          if (window.__reflowAutomatedActionActive) {
            if (expected && (expected === evt.target || (expected.contains && expected.contains(evt.target)))) {
              isAutomated = true;
            } else if (!expected && expectedKey && (evt.key === expectedKey || evt.code === expectedKey)) {
              isAutomated = true;
            }
          }

          if (!isAutomated && window.__reflowAutomatedUntil && now < window.__reflowAutomatedUntil) {
            var recentTarget = window.__reflowAutomatedRecentTarget;
            var recentKey = window.__reflowAutomatedRecentKey;
            if (recentTarget && (recentTarget === evt.target || (recentTarget.contains && recentTarget.contains(evt.target)))) {
              isAutomated = true;
            } else if (!recentTarget && recentKey && (evt.key === recentKey || evt.code === recentKey)) {
              isAutomated = true;
            }
          }

          if (isAutomated) return;

          if (window.__reflowReplayLocked) {
            if (evt.cancelable) evt.preventDefault();
            evt.stopImmediatePropagation(); evt.stopPropagation();
          }
          if (window.__reflowReplayPaused) return;
          window.__reflowReplayPaused = true;
          window.__reflowUpdateReplayGuard && window.__reflowUpdateReplayGuard();
          var now = Date.now();
          if (typeof window.__reflowReportIntervention === 'function') {
            window.__reflowReportIntervention({
              type: evt.type,
              key: evt.key || null,
              tagName: evt.target && evt.target.tagName || null,
              locked: !!window.__reflowReplayLocked,
              time: now
            });
          }
        };
        window.__reflowReplayInputHandler=onHumanInput;
        ['pointerdown','mousedown','click','pointerup','mouseup','keydown','keypress','keyup','wheel','touchstart','touchmove','contextmenu','dragstart','dragover','drop'].forEach(function(type){window.addEventListener(type,onHumanInput,{capture:true,passive:false});});
        window.__reflowStopReplayGuard=function(){
          ['pointerdown','mousedown','click','pointerup','mouseup','keydown','keypress','keyup','wheel','touchstart','touchmove','contextmenu','dragstart','dragover','drop'].forEach(function(type){window.removeEventListener(type,onHumanInput,true);});
          if(host)host.remove(); window.__reflowInterventionAttached=false;
        };
      })();
    `;

    try {
      const script = await page.evaluateOnNewDocument(injectionScript);
      this._guardScriptIds.set(page, script.identifier);
      this._guardPages.add(page);
      for (const frame of page.frames()) {
        if (!frame || (typeof frame.isDetached === 'function' && frame.isDetached())) continue;
        await frame.evaluate(injectionScript).catch(() => {});
      }
    } catch {}
  }

  async _syncReplayGuard() {
    if (!this.enableDisturbanceDetection) return;
    for (const page of this._guardPages) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        if (!frame || (typeof frame.isDetached === 'function' && frame.isDetached())) continue;
        await frame.evaluate((state) => {
          window.__reflowReplayPaused=state.paused;
          window.__reflowReplayLocked=state.locked;
          window.__reflowUpdateReplayGuard && window.__reflowUpdateReplayGuard();
        }, { paused: this.isPaused, locked: this.isLocked }).catch(() => {});
      }
    }
  }

  async _teardownReplayGuard() {
    for (const page of this._guardPages) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        if (!frame || (typeof frame.isDetached === 'function' && frame.isDetached())) continue;
        await frame.evaluate(() => window.__reflowStopReplayGuard && window.__reflowStopReplayGuard()).catch(() => {});
      }
      const identifier = this._guardScriptIds.get(page);
      if (identifier) await page.removeScriptToEvaluateOnNewDocument(identifier).catch(() => {});
    }
    this._guardPages.clear();
    this._guardScriptIds.clear();
  }

  /**
   * Set flag in browser indicating automated action in progress (prevents bot synthetic actions from triggering disturbance alerts)
   */
  async _setAutomatedAction(isActive, targetOrOptions = null) {
    this.isAutomatedActionActive = !!isActive;
    if (!this.enableDisturbanceDetection) return;
    if (this.page && !this.page.isClosed()) {
      try {
        let targetHandle = null;
        let expectedKey = null;

        if (targetOrOptions) {
          if (typeof targetOrOptions === 'string') {
            expectedKey = targetOrOptions;
          } else if (typeof targetOrOptions === 'object') {
            if (typeof targetOrOptions.asElement === 'function') {
              targetHandle = targetOrOptions.asElement();
            } else if (targetOrOptions.nodeType) {
              targetHandle = targetOrOptions;
            } else {
              if (targetOrOptions.key) expectedKey = targetOrOptions.key;
              if (targetOrOptions.target) {
                targetHandle = typeof targetOrOptions.target.asElement === 'function'
                  ? targetOrOptions.target.asElement()
                  : targetOrOptions.target;
              }
            }
          }
        }

        await this.page.evaluate((active, target, key) => {
          window.__reflowAutomatedActionActive = active;
          if (active) {
            window.__reflowAutomatedTarget = target || null;
            window.__reflowAutomatedKey = key || null;
            window.__reflowAutomatedSince = Date.now();
          } else {
            window.__reflowAutomatedUntil = Date.now() + 150;
            window.__reflowAutomatedRecentTarget = window.__reflowAutomatedTarget || null;
            window.__reflowAutomatedRecentKey = window.__reflowAutomatedKey || null;
            window.__reflowAutomatedTarget = null;
            window.__reflowAutomatedKey = null;
          }
        }, !!isActive, targetHandle, expectedKey).catch(async () => {
          if (targetHandle) {
            await targetHandle.evaluate((el, active) => {
              window.__reflowAutomatedActionActive = active;
              if (active) {
                window.__reflowAutomatedTarget = el;
                window.__reflowAutomatedKey = null;
                window.__reflowAutomatedSince = Date.now();
              } else {
                window.__reflowAutomatedUntil = Date.now() + 150;
                window.__reflowAutomatedRecentTarget = el;
                window.__reflowAutomatedRecentKey = null;
                window.__reflowAutomatedTarget = null;
                window.__reflowAutomatedKey = null;
              }
            }, !!isActive).catch(() => {});
          }
        });
      } catch {}
    }
  }

  /**
   * Handle human disturbance reported from target page
   */
  _handleHumanIntervention(eventDetail) {
    if (!this.enableDisturbanceDetection) return;
    if (this.isPaused || this.isAborted) return;
    this.isPaused = true;
    this._syncReplayGuard();
    this.emit('paused', { reason: 'human_input' });
    const stepNumber = this.currentActionIndex + 1;
    const currentAction = (this.recording && this.recording.actions)
      ? this.recording.actions[this.currentActionIndex]
      : null;

    logger.warn(`⚠️ [Human Disturbance Detected] Manual user interaction (${eventDetail.type}${eventDetail.key ? ` '${eventDetail.key}'` : ''}) intercepted on Step #${stepNumber}!`);

    const payload = {
      stepIndex: stepNumber,
      action: currentAction,
      detail: eventDetail,
      timestamp: Date.now()
    };

    this.lastIntervention = payload;
    this.emit('human_intervention', payload);
  }

  /**
   * Execute a single recorded action on the active page
   */
  async executeAction(action, index = 0) {
    return await this.interruptionHandler.executeWithRecovery(this.page, action, async () => {
      if (this.tabManager) {
        await this.tabManager.reconcileActiveTab(action, this);
      }
      this.currentActionIndex = index;
      if (!this.page) throw new Error('ReplayEngine is not connected to a page.');

      // 1. Explicit step delay if requested
      if (this.stepDelayMs > 0) {
        await new Promise(r => setTimeout(r, this.stepDelayMs));
      }

      // 2. Wait for any active ExtJS/SPA loading masks or spinners to clear
      await this._waitForLoadingMasks(6000);

      if (this.isAborted) {
        throw new Error('Execution stopped by user');
      }

      // Apply pre-action delay if configured
      const preDelay = ActionDispatcher.calculatePreActionDelay(this.botConfig);
      if (preDelay > 0) {
        await new Promise(r => setTimeout(r, preDelay));
      }

      if (action.type === 'NAVIGATE' && action.url) {
        const navUrl = resolveTargetUrl(action.url) || action.url;
        await this.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._applyStealthEvasion();
        await new Promise(r => setTimeout(r, 500));
        return { success: true, type: 'NAVIGATE' };
      }

      // Check if action targets an ephemeral anchor injected by client download scripts
      if (isTransientProgrammaticDownloadAction(action)) {
        try {
          const probe = await this.page.$('body > a[href^="blob:"], a[download][href^="blob:"]');
          if (probe) {
            await probe.click();
            await probe.dispose();
            return { success: true, type: 'CLICK', skipped: false };
          }
        } catch { }
        logger.info(`[Replay] Action #${index + 1} targets a transient programmatic download anchor (dispatched automatically by website script). Skipping safely.`);
        return { success: true, type: 'CLICK', skipped: true };
      }

      if (action.type === 'SCROLL') {
        let elementHandle = null;
        if (!action.isWindow && action.target && Array.isArray(action.target.candidates) && action.target.candidates.length > 0) {
          try {
            const resolved = await this.waitForTargetElement(
              action.target || action.fingerprint,
              index,
              action.type,
              action,
              { timeout: 3000 }
            );
            elementHandle = resolved.elementHandle;
          } catch {
            // Container target not found, fall back to window scroll
          }
        }
        await this._waitWhilePaused();
        await this._setAutomatedAction(true, elementHandle);
        try {
          await dispatchAction(elementHandle, action, { page: this.page, botConfig: this.botConfig });
        } finally {
          await this._setAutomatedAction(false);
          if (elementHandle) await elementHandle.dispose().catch(() => {});
        }
        logger.action(index + 1, 'SCROLL', `x=${action.scrollX ?? 0}, y=${action.scrollY ?? action.scrollTop ?? 0}`);
        await new Promise(r => setTimeout(r, 200));
        return { success: true, type: 'SCROLL' };
      }

      const resolvedTarget = this._normalizeActionTarget(action.target || action.fingerprint, action);
      const { elementHandle, candidate, confidenceScore } = await this.waitForTargetElement(
        resolvedTarget,
        index,
        action.type,
        action
      );

      // Deep clone the action so we don't mutate the original recording
      const actionToDispatch = await ActionDispatcher.resolveActionSecrets(action, this.secretResolver, index);

      // Look ahead to check if the next action targets an option inside a dropdown
      const isNextActionOption = ActionDispatcher.isNextActionOption(this.recording, index + 1);

      await this._waitWhilePaused();
      await this._setAutomatedAction(true, elementHandle);
      try {
        await dispatchAction(elementHandle, actionToDispatch, {
          page: this.page,
          botConfig: this.botConfig,
          isNextActionOption,
          replayEngine: this,
          actionIndex: index
        });
      } finally {
        await this._setAutomatedAction(false);
      }
      await elementHandle.dispose().catch(() => {});

      // If this action opened a combobox/dropdown, allow overlay animation to settle
      if (action.type === 'CLICK' && isNextActionOption) {
        await new Promise(r => setTimeout(r, 300));
      }

      // Reconcile and return focus to the primary portal workflow
      if (this.tabManager) {
        if (action.type === 'CLICK') {
          await new Promise(r => setTimeout(r, 200));
        }
        await this.tabManager.cleanupAuxiliaryTabs();
        await this.tabManager.ensurePrimaryTabActive(this);
      }

      const scorePercent = Math.round(confidenceScore * 100);
      logger.action(index + 1, action.type, candidate.value, `score=${scorePercent}%`);

      // Calculate humanized post-action timing delay
      const postDelay = ActionDispatcher.calculatePostActionDelay(this.botConfig);
      await new Promise(r => setTimeout(r, postDelay));

      return { success: true, confidenceScore, candidate };
    });
  }

  /**
   * Execute a recorded action against an already-discovered collection item.
   * The original recorded target is not resolved globally; resolution is scoped
   * to the current item to avoid clicking the first matching record repeatedly.
   */
  async executeActionWithinItem(itemHandle, action, index = 0) {
    return await this.interruptionHandler.executeWithRecovery(this.page, action, async () => {
      if (this.tabManager) {
        await this.tabManager.reconcileActiveTab(action, this);
      }
      if (!this.page) throw new Error('ReplayEngine is not connected to a page.');
      if (!itemHandle) throw new Error('No collection item handle supplied.');

      await this._waitWhilePaused();
      await this._waitForLoadingMasks(6000);

      // Check if action targets an ephemeral anchor injected by client download scripts
      if (isTransientProgrammaticDownloadAction(action)) {
        logger.info(`[Replay] Action #${index + 1} within item targets a transient programmatic download anchor. Skipping safely.`);
        return { success: true, type: 'CLICK', skipped: true };
      }

      const targetHandle = await ActionDispatcher.resolveTargetWithinItem(itemHandle, action.target || action.fingerprint);

      const elementHandle = targetHandle ? (typeof targetHandle.asElement === 'function' ? targetHandle.asElement() : targetHandle) : null;
      if (!elementHandle) {
        if (targetHandle) await targetHandle.dispose().catch(() => {});
        throw new Error(`Could not resolve action target inside collection item #${index + 1}`);
      }

      try {
        const actionToDispatch = await ActionDispatcher.resolveActionSecrets(action, this.secretResolver, index);
        const isNextActionOption = ActionDispatcher.isNextActionOption(this.recording, index + 1);

        await elementHandle.scrollIntoViewIfNeeded().catch(() => {});
        await this._waitWhilePaused();
        await this._setAutomatedAction(true, elementHandle);
        try {
          await dispatchAction(elementHandle, actionToDispatch, {
            page: this.page,
            botConfig: this.botConfig,
            isNextActionOption,
            replayEngine: this,
            actionIndex: index
          });
        } finally {
          await this._setAutomatedAction(false, elementHandle);
        }

        // Reconcile and return focus to the primary portal workflow
        if (this.tabManager) {
          if (action.type === 'CLICK') {
            await new Promise(r => setTimeout(r, 200));
          }
          await this.tabManager.cleanupAuxiliaryTabs();
          await this.tabManager.ensurePrimaryTabActive(this);
        }

        return { success: true, scoped: true };
      } finally {
        await elementHandle.dispose().catch(() => {});
      }
    });
  }

  /**
   * Ensure selector resolver is loaded inside a specific frame or page context
   */
  async _ensureSelectorResolverInFrame(frame) {
    return ActionDispatcher.ensureSelectorResolverInFrame(frame, this.page);
  }

  /**
   * Resiliently normalize target into a complete Target object with candidates array and fingerprint
   */
  _normalizeActionTarget(target, action = null) {
    if (target && typeof target === 'object' && Array.isArray(target.candidates) && target.candidates.length > 0 && target.fingerprint) {
      return target;
    }

    const candidateStrings = [];
    if (typeof target === 'string' && target.trim()) {
      candidateStrings.push(target.trim());
    } else if (target && typeof target === 'object') {
      if (typeof target.selector === 'string' && target.selector.trim()) {
        candidateStrings.push(target.selector.trim());
      }
      if (Array.isArray(target.candidates)) {
        for (const c of target.candidates) {
          const val = typeof c === 'string' ? c : c?.value;
          if (val && typeof val === 'string' && val.trim() && !candidateStrings.includes(val.trim())) {
            candidateStrings.push(val.trim());
          }
        }
      }
    }

    if (action && typeof action === 'object') {
      if (typeof action.target === 'string' && action.target.trim() && !candidateStrings.includes(action.target.trim())) {
        candidateStrings.push(action.target.trim());
      }
      if (Array.isArray(action.candidates)) {
        for (const c of action.candidates) {
          const val = typeof c === 'string' ? c : c?.value;
          if (val && typeof val === 'string' && val.trim() && !candidateStrings.includes(val.trim())) {
            candidateStrings.push(val.trim());
          }
        }
      }
    }

    const normalizedCandidates = candidateStrings.map((sel, idx) => {
      const isXpath = sel.startsWith('//') || sel.startsWith('(') || sel.startsWith('/html');
      return {
        strategy: isXpath ? 'xpath' : 'css-path',
        value: sel,
        priority: idx + 1,
        uniqueness: 1,
      };
    });

    const fallbackFingerprint = (target && typeof target === 'object' && target.fingerprint)
      ? target.fingerprint
      : {
          tagName: null,
          isSynthetic: true,
          text: action?.value || action?.name || '',
          attributes: {},
          classes: [],
          dimensions: { width: 100, height: 40 },
          isCheckbox: Boolean(action?.isCheckbox || (action?.name && action.name.toLowerCase().includes('checkbox'))),
          isPassword: Boolean(action?.name && action.name.toLowerCase().includes('password')),
        };

    return {
      candidates: normalizedCandidates.length > 0 ? normalizedCandidates : [{ strategy: 'css-path', value: 'body', priority: 1, uniqueness: 1 }],
      fingerprint: fallbackFingerprint,
      elementName: action?.name || 'Target Element',
      friendlyName: action?.name || 'Target Element',
    };
  }

  /**
   * Condition-based in-page polling resolver loop across main page and all child frames (iframes)
   */
  async waitForTargetElement(target, actionIndex, actionType, action = null, options = {}) {
    target = this._normalizeActionTarget(target, action);
    const startTime = Date.now();
    let lastResolutionResult = null;
    let lastInterruptionCheck = startTime;
    let lastScrollProbeTime = startTime;
    let restoredRecordedScroll = false;

    // Adaptive timeout: if action had a large recorded wait time (e.g. generating a slow report or table query),
    // allow enough time for the real site to load the data rather than hard failing at standard timeout.
    const recordedDelta = (action && typeof action.timeDeltaMs === 'number') ? action.timeDeltaMs : 0;
    const effectiveTimeoutMs = options.timeout || Math.min(60000, Math.max(this.timeoutMs, recordedDelta + 8000));

    while (Date.now() - startTime < effectiveTimeoutMs) {
      if (this.isAborted) {
        throw new Error('Execution stopped by user');
      }
      await this._waitWhilePaused();

      // If element resolution has been blocked for >600ms, proactively clear any unexpected popups or alerts
      if (this.interruptionHandler && this.page && (Date.now() - lastInterruptionCheck > 600)) {
        lastInterruptionCheck = Date.now();
        await this.interruptionHandler.clearLingeringDialogs(this.page).catch(() => {});
        await this.interruptionHandler.dismissBlockingOverlays(this.page, { target }).catch(() => {});
      }

      // If target hasn't been found after 500ms, restore recorded scroll offset if available
      if (!restoredRecordedScroll && this.page && action?.scrollOffset && (action.scrollOffset.y > 0 || action.scrollOffset.x > 0) && (Date.now() - startTime > 500)) {
        restoredRecordedScroll = true;
        try {
          await this.page.evaluate((offset) => {
            window.scrollTo({ left: offset.x || 0, top: offset.y || 0, behavior: 'instant' });
          }, action.scrollOffset);
          await new Promise(r => setTimeout(r, 150));
        } catch {}
      }

      // If target is still not found after 1200ms, perform progressive auto-scroll probe (for virtualized lists/tables)
      if (this.page && (Date.now() - startTime > 1200) && (Date.now() - lastScrollProbeTime > 800)) {
        lastScrollProbeTime = Date.now();
        try {
          await this.page.evaluate(() => {
            const scrollableContainers = Array.from(document.querySelectorAll(
              '.ag-body-viewport, .ag-center-cols-viewport, .cdk-virtual-scroll-viewport, .ui-grid-viewport, [role="grid"], [role="table"], .data-table, .table-responsive, div[style*="overflow"]'
            )).filter(el => {
              const style = window.getComputedStyle(el);
              return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
            });

            let scrolledContainer = false;
            for (const container of scrollableContainers) {
              if (container.scrollTop + container.clientHeight < container.scrollHeight - 10) {
                container.scrollTop += 300;
                container.dispatchEvent(new Event('scroll', { bubbles: true }));
                scrolledContainer = true;
                break;
              }
            }

            if (!scrolledContainer) {
              const canScrollWindow = window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 10;
              if (canScrollWindow) {
                window.scrollBy({ top: 300, left: 0, behavior: 'instant' });
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
              }
            }
          });
          await new Promise(r => setTimeout(r, 150));
        } catch {}
      }
      try {
        let pagesToCheck = [this.page];
        if (this.tabManager) {
          pagesToCheck = await this.tabManager.getPagesToCheck();
        } else if (this.browser) {
          const allPages = await this.browser.pages().catch(() => []);
          for (const p of allPages) {
            if (p !== this.page && !p.isClosed()) {
              pagesToCheck.push(p);
            }
          }
        }

        for (const candidatePage of pagesToCheck) {
          const frames = [candidatePage.mainFrame(), ...candidatePage.frames().filter(f => f !== candidatePage.mainFrame())];

          for (const frame of frames) {
            if (!frame || (typeof frame.isDetached === 'function' && frame.isDetached())) continue;
            try {
              await this._ensureSelectorResolverInFrame(frame);

              // 1. Resolve and obtain direct JSHandle to the matched DOM element in this frame
              const handle = await frame.evaluateHandle((targetData) => {
                if (!window.SelectorResolver) return null;
                const res = window.SelectorResolver.resolveElement(targetData);
                window.__lastResolutionReport = res ? {
                  success: res.success,
                  confidenceScore: res.confidenceScore,
                  resolvedCandidate: res.resolvedCandidate || res.candidate || null,
                  reason: res.reason || null,
                  attempts: res.attempts || []
                } : null;
                return res && res.success && res.element ? res.element : null;
              }, target).catch(() => null);

              // 2. Fetch resolution report
              const report = await frame.evaluate(() => window.__lastResolutionReport).catch(() => null);

              if (report) {
                lastResolutionResult = report;
              }

              // 3. Validate element and check interactability
              if (handle) {
                const element = handle.asElement();
                if (element) {
                  const isAttached = await element.evaluate(el => el.isConnected && el.ownerDocument.contains(el)).catch(() => false);

                  if (isAttached) {
                    const matchedCandidate = (report && (report.resolvedCandidate || report.candidate))
                      ? (report.resolvedCandidate || report.candidate)
                      : (target.candidates && target.candidates[0]) || { strategy: 'css_id', value: target.targetId || 'unknown' };
                    const confidenceScore = (report && report.confidenceScore) || 1.0;

                    if (candidatePage !== this.page) {
                      await candidatePage.bringToFront().catch(() => {});
                      this.page = candidatePage;
                      if (this.enableDisturbanceDetection) {
                        await this._initHumanDisturbanceDetection(candidatePage);
                      } else {
                        await this._cleanupLingeringReplayGuard(candidatePage);
                      }
                      logger.info(`[ReplayEngine] Switched active tab/window to: ${candidatePage.url()}`);
                    }

                    return {
                      elementHandle: element,
                      frame,
                      candidate: matchedCandidate,
                      confidenceScore
                    };
                  }
                  await element.dispose().catch(() => {});
                } else {
                  await handle.dispose().catch(() => {});
                }
              }
            } catch {
              // Continue searching remaining frames
            }
          }
        }
      } catch {
        // Retry polling on frame detach
      }

      await new Promise(r => setTimeout(r, this.pollIntervalMs));
    }

    // Timeout exceeded
    const detailedReason = lastResolutionResult?.reason ||
      lastResolutionResult?.attempts?.find(a => a.reason)?.reason ||
      'No candidate matched within timeout';

    const failureReport = lastResolutionResult ? {
      ...lastResolutionResult,
      reason: detailedReason
    } : {
      bestScore: 0,
      candidatesTried: (target && target.candidates) ? target.candidates.length : 0,
      reason: detailedReason
    };

    throw new ElementResolutionTimeoutError(
      `Condition-based resolution timed out after ${effectiveTimeoutMs}ms for Action #${actionIndex + 1} [${actionType}]`,
      {
        actionIndex,
        actionType,
        target,
        timeoutMs: effectiveTimeoutMs,
        resolutionReport: failureReport
      }
    );
  }

  /**
   * Main replay execution entry point
   */
  async replay(recordingPathOrObject) {
    let recording;
    if (typeof recordingPathOrObject === 'string') {
      recording = this.loadRecording(recordingPathOrObject);
      logger.info(`Loaded recording from: ${recordingPathOrObject}`);
    } else if (recordingPathOrObject) {
      const actions = Array.isArray(recordingPathOrObject.actions)
        ? recordingPathOrObject.actions
        : (Array.isArray(recordingPathOrObject.steps) ? recordingPathOrObject.steps : []);
      recording = {
        metadata: recordingPathOrObject.metadata || {
          name: recordingPathOrObject.name || 'Workflow',
          startUrl: recordingPathOrObject.targetUrl || (recordingPathOrObject.metadata && recordingPathOrObject.metadata.startUrl) || ''
        },
        actions,
        targetUrl: recordingPathOrObject.targetUrl
      };
    } else {
      throw new AutomationError('Invalid recording parameter passed to ReplayEngine');
    }

    logger.info(`Initializing replay session: "${recording.metadata ? recording.metadata.name : 'workflow'}" (${recording.actions.length} actions)`);
    this.recording = recording;

    // Resolve cross-platform file:/// URLs or web URLs
    let targetStartUrl = extractWorkflowStartUrl(recording);

    // Connect to Chrome via CDP
    const { browser, page } = await connectToBrowser({
      browserURL: this.browserURL
    });
    this.browser = browser;
    this.page = page;

    // Apply anti-bot stealth scripts
    await this._applyStealthEvasion();
    if (this.enableDisturbanceDetection) {
      await this._initHumanDisturbanceDetection(this.page);
    } else {
      await this._cleanupLingeringReplayGuard(this.page);
    }

    // Initialize intelligent tab tracking & dialog interception
    if (this.tabManager) {
      await this.tabManager.initialize(this.browser, this.page, this.recording);
      if (this.tabManager.getPrimaryPage()) {
        this.page = this.tabManager.getPrimaryPage();
      }
    }
    if (this.interruptionHandler && this.page) {
      this.interruptionHandler.attachToPage(this.page);
      await this.interruptionHandler.clearLingeringDialogs(this.page).catch(() => {});
    }

    // 3. Auto-navigate or reset DOM state
    if (targetStartUrl) {
      const currentUrl = this.page.url();
      let needsNavigation = currentUrl === 'about:blank' || currentUrl.startsWith('chrome://');
      try {
        if (!needsNavigation) {
          const currentOrigin = new URL(currentUrl).origin;
          const targetOrigin = new URL(targetStartUrl).origin;
          if (currentOrigin !== targetOrigin) {
            needsNavigation = true;
          } else {
            // Same origin: do NOT navigate back to /login if current page is already authenticated past login
            const currentPath = currentUrl.split('#')[0].replace(/\/+$/, '');
            const targetPath = targetStartUrl.split('#')[0].replace(/\/+$/, '');
            const isTargetLogin = /\/login\b|\/signin\b|\/auth\b/i.test(targetStartUrl) || /#(.*)\/(login|signin)/i.test(targetStartUrl);
            const isCurrentLogin = /\/login\b|\/signin\b|\/auth\b/i.test(currentUrl) || /#(.*)\/(login|signin)/i.test(currentUrl);
            if (isTargetLogin && !isCurrentLogin) {
              needsNavigation = false;
              logger.info(`Session already active at "${currentUrl}". Skipping navigation to login URL: ${targetStartUrl}`);
            } else if (currentPath !== targetPath && isCurrentLogin) {
              needsNavigation = true;
            }
          }
        }
      } catch {
        needsNavigation = (currentUrl !== targetStartUrl);
      }

      if (needsNavigation) {
        logger.info(`Navigating tab to workflow starting URL: ${targetStartUrl}`);
        try {
          await this.page.goto(targetStartUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._applyStealthEvasion();
          await new Promise(r => setTimeout(r, 500));
        } catch (navErr) {
          logger.warn(`Auto-navigation note: ${navErr.message}`);
        }
      } else {
        // Reset forms cleanly
        try {
          await this.page.evaluate(() => {
            document.querySelectorAll('form').forEach(f => f.reset());
          });
          await new Promise(r => setTimeout(r, 200));
        } catch {}
      }
    }

    logger.success(`Replay attached to tab: ${this.page.url()}`);
    logger.divider();

    const replayStats = {
      startTime: Date.now(),
      executedCount: 0,
      skippedCount: 0,
      totalCount: recording.actions.length,
      failedAction: null
    };

    // Conditional Login Skip: If the portal is already authenticated, skip initial login steps
    let startIndex = 0;
    const loginSeq = detectLoginSequence(recording.actions);
    if (loginSeq.hasLoginSequence) {
      const isAuth = await isSessionAuthenticated(this.page, loginSeq);
      if (isAuth) {
        logger.info(`[ReplayEngine] Active session detected at "${this.page.url()}". Skipping ${loginSeq.loginActionCount} login step(s) (Steps 1-${loginSeq.firstPostLoginIndex}) and resuming at Step #${loginSeq.firstPostLoginIndex + 1}.`);
        startIndex = loginSeq.firstPostLoginIndex;
        replayStats.skippedCount = loginSeq.loginActionCount;
        this.emit('login_skipped', { count: loginSeq.loginActionCount, firstPostLoginIndex: startIndex });
      }
    }

    try {
      for (let i = startIndex; i < recording.actions.length; i++) {
        await this._waitWhilePaused();
        if (this.isAborted) {
          throw new Error('Execution stopped by user');
        }

        this.currentActionIndex = i;
        const action = recording.actions[i];

        // Apply explicit step delay or natural pacing from recording (up to 15s)
        if (this.stepDelayMs > 0) {
          logger.info(`Explicit step delay: waiting ${this.stepDelayMs}ms before step #${action.index + 1}...`);
          const end = Date.now() + this.stepDelayMs;
          while (Date.now() < end) {
            await this._waitWhilePaused();
            if (this.isAborted) throw new Error('Execution stopped by user');
            await new Promise(r => setTimeout(r, 100));
          }
        } else if (action.timeDeltaMs && this.speed > 0) {
          const delay = ActionDispatcher.calculatePacingDelay(action, this.speed, this.botConfig);
          if (delay > 0) {
            logger.info(`Pacing step #${action.index + 1}: waiting ${delay}ms for page/data to settle...`);
            const end = Date.now() + delay;
            while (Date.now() < end) {
              await this._waitWhilePaused();
              if (this.isAborted) throw new Error('Execution stopped by user');
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }

        if (this.isAborted) {
          throw new Error('Execution stopped by user');
        }

        // Check if action targets an ephemeral anchor injected by client download scripts
        if (isTransientProgrammaticDownloadAction(action)) {
          try {
            const probe = await this.page.$('body > a[href^="blob:"], a[download][href^="blob:"]');
            if (probe) {
              await probe.click();
              await probe.dispose();
            }
          } catch { }
          logger.info(`[Replay] Action #${action.index !== undefined ? action.index + 1 : i + 1} targets a transient programmatic download anchor (dispatched automatically by website script). Skipping safely.`);
          replayStats.skippedCount++;
          continue;
        }

        // 1. Condition-based wait & resolve element
        const { elementHandle, candidate, confidenceScore } = await this.waitForTargetElement(
          action.target,
          action.index,
          action.type,
          action
        );
        await this._waitWhilePaused();

        // Deep clone the action to safely inject secrets
        const actionToDispatch = await ActionDispatcher.resolveActionSecrets(
          action,
          this.secretResolver,
          action.index !== undefined ? action.index : i
        );

        // 2. Perform action via Puppeteer with humanization config
        await this._setAutomatedAction(true, elementHandle);
        try {
          await dispatchAction(elementHandle, actionToDispatch, {
            page: this.page,
            botConfig: this.botConfig
          });
        } finally {
          await this._setAutomatedAction(false);
        }

        // Clean up handle
        await elementHandle.dispose().catch(() => {});

        replayStats.executedCount++;

        // 3. Log progress
        const scorePercent = Math.round(confidenceScore * 100);
        const detail = `matched via [${candidate.strategy}] score=${scorePercent}%`;
        logger.action(action.index + 1, action.type, candidate.value, detail);

        // Calculate humanized post-action timing delay
        const postDelay = ActionDispatcher.calculatePostActionDelay(this.botConfig);
        await new Promise(r => setTimeout(r, postDelay));
      }

      const elapsed = ((Date.now() - replayStats.startTime) / 1000).toFixed(1);
      logger.divider();
      logger.success(`Replay completed successfully! ${replayStats.executedCount}/${replayStats.totalCount} actions reproduced in ${elapsed}s.`);

    } catch (err) {
      replayStats.failedAction = recording.actions[replayStats.executedCount];
      logger.divider();
      logger.error(`Replay halted at action #${replayStats.executedCount + 1}:`, err);
      throw err;
    } finally {
      await this.disconnect().catch(() => {});
    }

    return replayStats;
  }
}

ReplayEngine.isTransientProgrammaticDownloadAction = isTransientProgrammaticDownloadAction;

module.exports = ReplayEngine;
