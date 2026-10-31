/**
 * Desktop Localhost HTTP Bridge
 * 
 * Runs on 127.0.0.1:49152 to bridge Web Dashboard (Vercel / Localhost)
 * with the Desktop Automation and Chrome CDP Recorder engine.
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chromeSpawner = require('./chrome-spawner');
const configManager = require('./config-manager');
const notifier = require('./notifier');

// Engine and runtime module resolution strategy:
// Standard npm workspace resolution handles dev dependencies. In packaged Electron
// apps or monorepo development, engine-resolver.js configures module search paths
// relative to process.resourcesPath or the monorepo root packages/engine directory.

const engineResolver = require('./engine-resolver');
const RecorderBridge = engineResolver.requireEngine('src/recorder/recorder-bridge');

// Maximum accepted JSON request body. Anything larger is rejected with 413
// before it is fully buffered.
const MAX_BODY_BYTES = 1024 * 1024;

// Local web dashboard ports this bridge is allowed to accept requests from.
// The bridge's own port is added separately.
const LOCAL_DASHBOARD_PORTS = [3000];

class HttpBridge {
  constructor() {
    this.port = 49152;
    this.host = '127.0.0.1';
    this.server = null;
    this.activeRecorder = null;
    this.isRecording = false;
    this.isStopping = false;
    this.completedRecording = false;
    this.actions = [];
    this.lastRecipe = null;
    this.sessionMeta = null;
    this.statusListeners = [];
    this._stoppingPromise = null;
  }

  onStatusChange(cb) {
    if (typeof cb === 'function') this.statusListeners.push(cb);
  }

  notifyStatus() {
    const status = this.getStatus();
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        console.warn('[HTTPBridge] Listener error:', err);
      }
    }
  }

  getStatus() {
    const activeActions = this.activeRecorder?.actions || this.actions || [];
    return {
      status: 'ok',
      isRecording: this.isRecording,
      actionCount: activeActions.length,
      actions: activeActions,
      completedRecording: this.completedRecording,
      sessionMeta: this.sessionMeta,
      recipe: this.lastRecipe,
      syncedWorkflow: this.lastSyncedWorkflow || null,
      port: this.port
    };
  }

  _getConfiguredOrigin() {
    const configuredCloudUrl = (this.configManager?.get?.()?.cloudUrl) || (configManager?.get?.()?.cloudUrl) || '';
    try {
      return configuredCloudUrl ? new URL(configuredCloudUrl).origin : '';
    } catch {
      return '';
    }
  }

  _getLocalOrigins() {
    const ports = new Set([...LOCAL_DASHBOARD_PORTS, this.port]);
    const origins = new Set();
    for (const port of ports) {
      origins.add(`http://127.0.0.1:${port}`);
      origins.add(`http://localhost:${port}`);
    }
    return origins;
  }

  setCorsHeaders(req, res) {
    const rawOrigin = req.headers.origin;
    let allowedOrigin = 'http://localhost:3000';
    if (!rawOrigin) {
      allowedOrigin = '*';
    } else {
      const configuredOrigin = this._getConfiguredOrigin();
      const isTrusted = this._getLocalOrigins().has(rawOrigin) ||
        (configuredOrigin && rawOrigin === configuredOrigin);

      if (isTrusted) {
        allowedOrigin = rawOrigin;
      }
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (allowedOrigin !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }

  sendJson(req, res, statusCode, data) {
    this.setCorsHeaders(req, res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _bodyTooLargeError() {
    const err = new Error(`Request body exceeds the ${MAX_BODY_BYTES} byte limit`);
    err.statusCode = 413;
    return err;
  }

  parseBody(req) {
    return new Promise((resolve, reject) => {
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        req.resume();
        reject(this._bodyTooLargeError());
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      let settled = false;

      req.on('data', (chunk) => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BODY_BYTES) {
          settled = true;
          chunks.length = 0;
          reject(this._bodyTooLargeError());
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => {
        if (settled) return;
        settled = true;
        resolve({});
      });
    });
  }

  async readJsonBody(req, res) {
    try {
      return await this.parseBody(req);
    } catch (err) {
      if (err.statusCode === 413) {
        this.sendJson(req, res, 413, { error: err.message });
        return null;
      }
      throw err;
    }
  }

  async start() {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const pathname = (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/'))
          ? urlObj.pathname.slice(0, -1)
          : urlObj.pathname;

        // 1. CORS Preflight
        if (req.method === 'OPTIONS') {
          this.setCorsHeaders(req, res);
          res.writeHead(204);
          res.end();
          return;
        }

        // 2. Reject oversized request bodies before any handler buffers them.
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
          req.resume();
          return this.sendJson(req, res, 413, { error: this._bodyTooLargeError().message });
        }

        // 3. Health Endpoint
        if ((pathname === '/health' || pathname === '/api/health') && req.method === 'GET') {
          const activeActions = this.activeRecorder?.actions || this.actions || [];
          return this.sendJson(req, res, 200, {
            status: 'ok',
            isRecording: this.isRecording,
            actionCount: activeActions.length,
            completedRecording: this.completedRecording,
            port: this.port
          });
        }

        // 4. Status Endpoint
        if ((pathname === '/record/status' || pathname === '/api/record/status') && req.method === 'GET') {
          const activeActions = this.activeRecorder?.actions || this.actions || [];
          return this.sendJson(req, res, 200, {
            status: 'ok',
            isRecording: this.isRecording,
            completedRecording: this.completedRecording,
            actionCount: activeActions.length,
            actions: activeActions,
            name: this.sessionMeta?.name || null,
            url: this.sessionMeta?.url || null,
            startedAt: this.sessionMeta?.startedAt || null,
            completedAt: this.sessionMeta?.completedAt || null,
            recipe: this.lastRecipe || null,
            port: this.port
          });
        }

        // 5. Start Recording Endpoint
        if ((pathname === '/record/start' || pathname === '/api/record/start') && req.method === 'POST') {
          const body = await this.readJsonBody(req, res);
          if (body === null) return;
          try {
            const result = await this.startRecording(body);
            return this.sendJson(req, res, 200, result);
          } catch (err) {
            return this.sendJson(req, res, 400, { error: err.message });
          }
        }

        // 6. Stop Recording Endpoint
        if ((pathname === '/record/stop' || pathname === '/api/record/stop') && req.method === 'POST') {
          try {
            const result = await this.stopRecording();
            return this.sendJson(req, res, 200, result);
          } catch (err) {
            return this.sendJson(req, res, 500, { error: err.message });
          }
        }

        // 7. Stop Active Execution Run Endpoint
        if ((pathname === '/run/stop' || pathname === '/api/run/stop') && req.method === 'POST') {
          try {
            const runnerController = require('./runner-controller');
            const result = await runnerController.stopActiveRun();
            return this.sendJson(req, res, 200, result);
          } catch (err) {
            return this.sendJson(req, res, 500, { error: err.message });
          }
        }

        // 8. Live Page and Table Item Discovery Endpoint
        if ((pathname === '/discover' || pathname === '/api/discover') && (req.method === 'POST' || req.method === 'GET')) {
          try {
            const body = req.method === 'POST' ? await this.readJsonBody(req, res) : {};
            if (body === null) return;
            const workflow = body.workflow || null;
            const targetUrl = body.url || workflow?.portal_url || workflow?.start_url || workflow?.targetUrl;

            const { connectToBrowser } = engineResolver.requireEngine('src/utils/cdp-connector');
            const { PageInspector } = engineResolver.requireEngine('src/shared/page-inspector');
            const ItemDiscovery = engineResolver.requireEngine('src/shared/item-discovery');
            const LoopReplayRunner = engineResolver.requireEngine('src/replay/loop-replay-runner');

            const { browser, page } = await connectToBrowser({
              browserURL: chromeSpawner.browserURL,
              autoLaunch: false
            }).catch(() => ({ browser: null, page: null }));
            if (!page) {
              return this.sendJson(req, res, 200, {
                success: false,
                reason: `No active Chrome browser session on port ${chromeSpawner.port}`,
                availableFields: [],
                fieldValues: {},
                itemCount: 0,
                items: []
              });
            }

            try {
              const currentUrl = page.url ? page.url() : '';
            if (targetUrl && (currentUrl === 'about:blank' || !currentUrl)) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }

            const inspection = await PageInspector.inspectPage(page).catch(() => ({ collections: [] }));
            const discoveredCols = new Set();
            const fieldValuesMap = {};

            const addVal = (field, val) => {
              if (!field || val === null || val === undefined) return;
              const f = String(field).trim();
              let v = String(val).trim();
              if (!f || !v) return;
              if (/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+$/i.test(v)) return;
              v = v.replace(/^[▸►▶▼▽▾+\-±›❯»⮞⌄v><\u25B6\u25BC\u25B8\u25BE\u276F\u203A\s]+/, '').trim();
              if (!v) return;
              if (!fieldValuesMap[f]) fieldValuesMap[f] = [];
              if (!fieldValuesMap[f].includes(v)) {
                fieldValuesMap[f].push(v);
              }
            };

            let primaryItems = [];
            let totalItemCount = 0;

            if (inspection && Array.isArray(inspection.collections) && inspection.collections.length > 0) {
              const primaryCollection = inspection.collections[0];
              totalItemCount = primaryCollection.rowCount || (primaryCollection.items?.length ?? 0);
              (primaryCollection.columns || []).forEach(c => {
                if (c && typeof c === 'string' && c.trim()) discoveredCols.add(c.trim());
              });

              if (Array.isArray(primaryCollection.items)) {
                primaryItems = primaryCollection.items;
                primaryCollection.items.forEach(row => {
                  Object.entries(row).forEach(([col, val]) => {
                    if (col && !col.startsWith('_')) {
                      discoveredCols.add(col.trim());
                      addVal(col.trim(), val);
                    }
                  });
                });
              }
            }

            // Also inspect workflow steps for target elements and ItemDiscovery
            const steps = workflow?.steps || workflow?.workflow_definition?.steps || [];
            if (steps.length > 0) {
              const stepIdx = Number.isInteger(body.loopStepIndex) ? body.loopStepIndex : 0;
              const targetStep = steps[stepIdx] || steps[0];
              if (targetStep) {
                const discovery = await ItemDiscovery.discover(page, targetStep.target || targetStep.fingerprint, {
                  minItems: 1,
                  minScore: 0.4
                }).catch(() => null);

                if (discovery && discovery.success) {
                  totalItemCount = Math.max(totalItemCount, discovery.itemCount || 0);
                  if (typeof LoopReplayRunner.extractDiscoveredItems === 'function') {
                    const extracted = await LoopReplayRunner.extractDiscoveredItems(page, discovery).catch(() => []);
                    if (Array.isArray(extracted)) {
                      extracted.forEach(it => {
                        if (it.fields) {
                          Object.entries(it.fields).forEach(([k, v]) => {
                            if (k && typeof k === 'string') {
                              discoveredCols.add(k.trim());
                              addVal(k.trim(), v);
                            }
                          });
                        }
                      });
                    }
                  }
                }
              }
            }

            const cleanFieldValues = {};
            Object.entries(fieldValuesMap).forEach(([k, vals]) => {
              cleanFieldValues[k] = vals.slice(0, 30);
            });

            return this.sendJson(req, res, 200, {
              success: true,
              availableFields: Array.from(discoveredCols),
              fieldValues: cleanFieldValues,
              itemCount: totalItemCount,
              items: primaryItems.slice(0, 50),
              url: page.url ? page.url() : '',
              title: (typeof page.title === 'function') ? await page.title().catch(() => '') : ''
            });
            } finally {
              if (browser) await browser.disconnect().catch(() => {});
            }
          } catch (err) {
            console.warn('[HTTPBridge] Discovery handler error:', err.message);
            return this.sendJson(req, res, 500, {
              success: false,
              error: err.message,
              availableFields: [],
              fieldValues: {},
              itemCount: 0
            });
          }
        }

        // 404 Fallback
        return this.sendJson(req, res, 404, { error: 'Not Found', path: pathname });
      } catch (err) {
        console.error('[HTTPBridge] Uncaught request error:', err);
        return this.sendJson(req, res, 500, { error: err.message });
      }
    });

    const server = this.server;
    return new Promise((resolve, reject) => {
      let settled = false;

      server.on('error', (err) => {
        console.error(`[HTTPBridge] Server error on port ${this.port}:`, err.message);
        if (!server.listening) {
          // Do not leave a dead server object behind: a later start() would
          // otherwise treat the bridge as running while it cannot accept requests.
          if (this.server === server) this.server = null;
          try { server.close(); } catch {}
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      });

      try {
        server.listen(this.port, this.host, () => {
          settled = true;
          console.log(`[HTTPBridge] Desktop Localhost Bridge listening on http://${this.host}:${this.port}`);
          resolve();
        });
      } catch (err) {
        if (this.server === server) this.server = null;
        try { server.close(); } catch {}
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  async startRecording(options = {}) {
    if (this.isRecording) {
      throw new Error('A recording session is already active');
    }

    const sessionName = options.name || `workflow-${Date.now()}`;
    const targetUrl = options.url || 'https://google.com';

    // Ensure Chrome is active on the CDP port
    await chromeSpawner.ensureChrome('visible');

    const config = configManager.get();
    const outputDir = path.join(
      config.targetFolder || path.join(os.homedir(), 'Downloads', 'ReFlow'),
      'Recordings'
    );
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.isRecording = true;
    this.completedRecording = false;
    this.actions = [];
    this.lastRecipe = null;
    this.sessionMeta = {
      name: sessionName,
      url: targetUrl,
      startedAt: new Date().toISOString()
    };

    this.activeRecorder = new RecorderBridge({
      name: sessionName,
      browserURL: chromeSpawner.browserURL,
      outputDir,
      onSave: async () => {
        await this._handleChromeSave();
      }
    });

    const origHandle = this.activeRecorder._handleCapturedAction.bind(this.activeRecorder);
    this.activeRecorder._handleCapturedAction = (rawAction) => {
      const added = origHandle(rawAction);
      if (added && this.activeRecorder) {
        this.actions = this.activeRecorder.actions || [];
        this.notifyStatus();
      }
      return added;
    };

    await this.activeRecorder.start();

    // Navigate to initial target URL if specified
    if (targetUrl && !targetUrl.startsWith('about:')) {
      try {
        let page = this.activeRecorder.page;
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
          const pages = (this.activeRecorder.browser && typeof this.activeRecorder.browser.pages === 'function')
            ? await this.activeRecorder.browser.pages().catch(() => [])
            : [];
          page = pages.find((p) => p && !p.isClosed()) || (await this.activeRecorder.browser.newPage());
          this.activeRecorder.page = page;
        }

        if (page) {
          await page.bringToFront().catch(() => {});
          const currentUrl = typeof page.url === 'function' ? page.url() : '';
          const normTarget = targetUrl.replace(/\/$/, '');
          const normCurrent = currentUrl.replace(/\/$/, '');
          if (normCurrent !== normTarget) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          }
        }
      } catch (e) {
        console.warn('[HTTPBridge] Page navigate notice:', e.message);
      }
    }

    this.notifyStatus();

    return {
      success: true,
      isRecording: true,
      name: sessionName,
      url: targetUrl,
      startedAt: this.sessionMeta?.startedAt || this.activeRecorder?.startedAt || new Date().toISOString()
    };
  }

  async _handleChromeSave() {
    if (this._stoppingPromise) {
      return this._stoppingPromise;
    }
    if (this.isStopping) return;
    this.isStopping = true;

    this._stoppingPromise = (async () => {
      try {
        if (this.activeRecorder) {
          const recorder = this.activeRecorder;
          let filePath = null;
          try {
            filePath = await recorder.stop();
          } catch (stopErr) {
            console.warn('[HTTPBridge] Recorder stop warning:', stopErr.message);
          }
          this.actions = recorder.actions || [];

          let recipeData = null;
          if (filePath && fs.existsSync(filePath)) {
            try {
              recipeData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (readErr) {
              console.warn('[HTTPBridge] Could not parse recipe file:', readErr.message);
            }
          }

          this.lastRecipe = recipeData || {
            metadata: {
              name: this.sessionMeta?.name || recorder.name,
              startUrl: recorder.startUrl || this.sessionMeta?.url,
              startedAt: this.sessionMeta?.startedAt,
              completedAt: new Date().toISOString(),
              isLoop: false,
              mode: 'STANDARD',
              version: '1.0.0'
            },
            actions: this.actions
          };

          this.activeRecorder = null;
          this.isRecording = false;
          this.completedRecording = true;
          if (this.sessionMeta) {
            this.sessionMeta.completedAt = new Date().toISOString();
          }

          if (this.lastRecipe && !this.lastRecipe._syncedToCloud) {
            this.lastRecipe._syncedToCloud = true;
            await this.syncWorkflowToCloud(this.lastRecipe);
          }

          try {
            notifier.notifyRecordingSaved(this.sessionMeta?.name || 'Recorded Workflow', this.actions.length);
          } catch {}
          this.notifyStatus();
        }
      } catch (err) {
        console.error('[HTTPBridge] Chrome finish error:', err);
      } finally {
        this.isStopping = false;
        this._stoppingPromise = null;
      }
    })();

    return this._stoppingPromise;
  }

  async syncWorkflowToCloud(recipe) {
    if (!recipe) return null;
    const config = configManager.get();
    const cloudUrl = config.cloudUrl || 'https://reflowproject-web.vercel.app';
    if (!config.runnerToken) {
      console.warn('[HTTPBridge] Cannot sync workflow to cloud: runnerToken or cloudUrl not configured');
      return null;
    }

    try {
      const rawActions = Array.isArray(recipe.actions) && recipe.actions.length > 0
        ? recipe.actions
        : (Array.isArray(this.actions) && this.actions.length > 0 ? this.actions : []);
      const workflowName = recipe.metadata?.name || this.sessionMeta?.name || `Recorded Workflow - ${new Date().toLocaleDateString()}`;
      const portalUrl = recipe.metadata?.startUrl || this.sessionMeta?.url || (rawActions.find(a => a && a.url)?.url) || 'https://google.com';

      const actions = rawActions.length > 0 ? rawActions : [
        { type: 'navigate', url: portalUrl, description: 'Open vendor portal URL' }
      ];

      const payload = {
        name: workflowName,
        portal_url: portalUrl,
        workflow_definition: {
          ...recipe,
          steps: actions,
          schedule: 'manual',
          target_folder: config.targetFolder || '',
          upload_to_cloud: true,
        },
        filter_rules: recipe.filter_rules || {},
        upload_to_cloud: true,
        target_folder: config.targetFolder || '',
      };

      const endpoint = `${cloudUrl.replace(/\/$/, '')}/api/v1/workflows`;
      console.log(`[HTTPBridge] Syncing recorded workflow "${workflowName}" (${actions.length} actions) to ${endpoint}...`);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.runnerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`[HTTPBridge] Successfully synced workflow to cloud! ID: ${data.workflow?.id}`);
        this.lastSyncedWorkflow = data.workflow;
        return data.workflow;
      } else {
        const errText = await res.text();
        console.warn(`[HTTPBridge] Failed to sync workflow to cloud (${res.status}): ${errText}`);
        return null;
      }
    } catch (err) {
      console.warn('[HTTPBridge] Network error syncing workflow to cloud:', err.message);
      return null;
    }
  }

  async stopRecording() {
    if (this._stoppingPromise) {
      await this._stoppingPromise;
    } else if (this.activeRecorder && (this.activeRecorder.isRecording || this.isRecording)) {
      await this._handleChromeSave();
    }

    if (this.lastRecipe && !this.lastRecipe._syncedToCloud) {
      this.lastRecipe._syncedToCloud = true;
      await this.syncWorkflowToCloud(this.lastRecipe);
    }

    this.isRecording = false;
    this.isStopping = false;
    this._stoppingPromise = null;
    this.completedRecording = true;
    this.notifyStatus();

    return {
      success: true,
      isRecording: false,
      completedRecording: true,
      actionCount: this.actions.length,
      actions: this.actions,
      recipe: this.lastRecipe
    };
  }

  async stop() {
    if (this.activeRecorder && this.activeRecorder.isRecording) {
      try {
        await this.activeRecorder.stop();
      } catch {}
      this.activeRecorder = null;
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }
}

module.exports = new HttpBridge();
