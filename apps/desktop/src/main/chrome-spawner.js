const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_CDP_PORT = 9222;
const PORT_SCAN_LIMIT = 20;
const OWNERSHIP_MARKER = 'reflow-owner.json';

class ChromeSpawner {
  constructor() {
    this.port = DEFAULT_CDP_PORT;
    this.host = '127.0.0.1';
    this.spawnedProcess = null;
    this.profileDir = path.join(os.homedir(), '.chrome-reflow');
  }

  get browserURL() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Locate the Chrome executable across Windows, macOS, and Linux
   */
  findChromePath() {
    const platform = process.platform;
    let candidates = [];

    if (platform === 'win32') {
      candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
    } else if (platform === 'darwin') {
      candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        path.join(os.homedir(), 'Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    } else {
      candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ];
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Check if Chrome is already running with remote debugging on the given port
   * Returns open status, version string, and whether it is running in headless mode.
   */
  async isPortOpen(port = this.port) {
    return new Promise((resolve) => {
      const req = http.get(
        {
          host: this.host,
          port,
          path: '/json/version',
          timeout: 1500,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              const browserStr = data.Browser || '';
              const userAgentStr = data['User-Agent'] || '';
              const isHeadless = Boolean(
                browserStr.toLowerCase().includes('headless') ||
                userAgentStr.toLowerCase().includes('headless')
              );
              resolve({
                open: true,
                version: browserStr || 'Chrome',
                isHeadless,
                webSocketDebuggerUrl: data.webSocketDebuggerUrl,
              });
            } catch {
              resolve({ open: true, version: 'Chrome', isHeadless: false });
            }
          });
        }
      );

      req.on('error', () => resolve({ open: false, isHeadless: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ open: false, isHeadless: false });
      });
    });
  }

  /**
   * Find the PIDs listening on a TCP port.
   */
  _getListeningPids(port = this.port) {
    const pids = new Set();

    if (process.platform === 'win32') {
      try {
        const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const portPattern = new RegExp(`:${port}$`);
        for (const line of output.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && portPattern.test(parts[1]) && parts[3] === 'LISTENING') {
            const pid = parseInt(parts[4], 10);
            if (pid > 0) pids.add(pid);
          }
        }
      } catch {}
    } else {
      try {
        const output = execSync(`lsof -ti tcp:${port}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        for (const raw of output.split(/\s+/)) {
          const pid = parseInt(raw, 10);
          if (pid > 0) pids.add(pid);
        }
      } catch {}
    }

    return [...pids];
  }

  _isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  _readOwnershipMarker() {
    try {
      const raw = fs.readFileSync(path.join(this.profileDir, OWNERSHIP_MARKER), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  _writeOwnershipMarker(pid, mode) {
    if (!pid) return;
    try {
      fs.writeFileSync(
        path.join(this.profileDir, OWNERSHIP_MARKER),
        JSON.stringify({ pid, port: this.port, mode, startedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch (err) {
      console.warn('[ChromeSpawner] Could not write ownership marker:', err.message);
    }
  }

  _clearOwnershipMarker() {
    try {
      const markerPath = path.join(this.profileDir, OWNERSHIP_MARKER);
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    } catch {}
  }

  /**
   * Determine whether the browser on the current port was started by ReFlow.
   * A browser is only ours when the PID recorded in the profile marker (or the
   * in-process spawned child) is the process currently listening on the port.
   */
  _isOwnedBrowser(port = this.port) {
    const marker = this._readOwnershipMarker();
    const spawnedPid = this.spawnedProcess && !this.spawnedProcess.killed
      ? this.spawnedProcess.pid
      : null;
    const markerPid = marker && marker.port === port ? marker.pid : null;
    const candidatePids = [spawnedPid, markerPid].filter((pid) => Number.isInteger(pid) && pid > 0);
    if (candidatePids.length === 0) return false;

    const listeningPids = this._getListeningPids(port);
    if (listeningPids.length > 0) {
      return candidatePids.some((pid) => listeningPids.includes(pid));
    }

    // Fall back to liveness only when the OS listener lookup is unavailable.
    return candidatePids.some((pid) => this._isProcessAlive(pid));
  }

  _isPortBindable(port) {
    return new Promise((resolve) => {
      const tester = http.createServer();
      const finish = (result) => {
        tester.removeAllListeners();
        resolve(result);
      };
      tester.once('error', () => finish(false));
      tester.listen(port, this.host, () => {
        tester.close(() => finish(true));
      });
    });
  }

  async _findFreePort(startPort) {
    for (let offset = 0; offset < PORT_SCAN_LIMIT; offset++) {
      const candidate = startPort + offset;
      if (await this._isPortBindable(candidate)) return candidate;
    }
    throw new Error(
      `Could not find a free CDP port between ${startPort} and ${startPort + PORT_SCAN_LIMIT - 1}.`
    );
  }

  /**
   * Close any running Chrome instance on the current port cleanly.
   * Only call this for a browser ReFlow owns.
   */
  async closeChrome() {
    const current = await this.isPortOpen();
    if (current.open && !this._isOwnedBrowser(this.port)) {
      console.warn(
        `[ChromeSpawner] Refusing to close Chrome on port ${this.port}: ` +
        'it was not started by ReFlow.'
      );
      return false;
    }

    // 1. Try closing cleanly via CDP Browser.close with puppeteer-core
    try {
      const puppeteer = require('puppeteer-core');
      const browser = await Promise.race([
        puppeteer.connect({
          browserURL: `http://${this.host}:${this.port}`,
          defaultViewport: null,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connect timeout')), 1500)),
      ]);
      await Promise.race([
        browser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Close timeout')), 2500)),
      ]);
    } catch {
      // Graceful CDP close failed or timed out, will fallback to process termination
    }

    // 2. Kill spawnedProcess reference if still active
    this.stopSpawned();

    // 3. Fallback: terminate any lingering process listening on the debugging port
    for (const pid of this._getListeningPids()) {
      if (pid === process.pid) continue;
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {}
    }

    // 4. Wait for the CDP port to fully release
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
      const check = await this.isPortOpen();
      if (!check.open) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // 5. Clean lock files from profile directory so next spawn doesn't fail
    this._cleanLocks();
    this._clearOwnershipMarker();
    return true;
  }

  _cleanLocks() {
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'RunningChromeVersion']) {
      try {
        const lockPath = path.join(this.profileDir, lock);
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== 'ENOENT') {
            try { fs.rmSync(lockPath, { force: true }); } catch {}
          }
        }
      } catch {}
    }
  }

  /**
   * Ensure Chrome is active on the CDP port in the requested mode.
   * Only a browser ReFlow started is adopted or restarted; a foreign Chrome
   * owning the default port is left alone and a free port is used instead.
   * @param {'visible' | 'headless'} mode
   */
  async ensureChrome(mode = 'visible') {
    // If a previous ReFlow session left its browser running on a fallback port,
    // keep using that browser instead of spawning another one.
    const previousMarker = this._readOwnershipMarker();
    if (previousMarker && Number.isInteger(previousMarker.port) && previousMarker.port !== this.port) {
      const previousStatus = await this.isPortOpen(previousMarker.port);
      if (previousStatus.open && this._getListeningPids(previousMarker.port).includes(previousMarker.pid)) {
        this.port = previousMarker.port;
      }
    }

    let status = await this.isPortOpen(this.port);

    if (status.open && !this._isOwnedBrowser(this.port)) {
      const foreignPort = this.port;
      this.port = await this._findFreePort(foreignPort + 1);
      console.warn(
        `[ChromeSpawner] Port ${foreignPort} is owned by a Chrome session ReFlow did not start. ` +
        `Leaving it untouched and using port ${this.port} instead.`
      );
      status = { open: false, isHeadless: false };
    }

    if (status.open) {
      const isCurrentlyHeadless = Boolean(status.isHeadless);
      const wantsHeadless = mode === 'headless';

      if (isCurrentlyHeadless === wantsHeadless) {
        // ReFlow owns this browser; make sure the marker survives an app restart.
        const ownedPid = this.spawnedProcess?.pid || this._readOwnershipMarker()?.pid;
        this._writeOwnershipMarker(ownedPid, isCurrentlyHeadless ? 'headless' : 'visible');
        return {
          alreadyRunning: true,
          version: status.version,
          port: this.port,
          mode: isCurrentlyHeadless ? 'headless' : 'visible',
        };
      }

      console.log(
        `[ChromeSpawner] Mode mismatch: running=${isCurrentlyHeadless ? 'headless' : 'visible'}, requested=${mode}. Restarting Chrome...`
      );
      await this.closeChrome();
    }

    const chromePath = this.findChromePath();
    if (!chromePath) {
      throw new Error(
        'Google Chrome was not found on this system. Please ensure Google Chrome is installed.'
      );
    }

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    this._cleanLocks();

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
    ];

    if (mode === 'headless') {
      args.push('--headless=new', '--disable-gpu');
    }

    this.spawnedProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });

    this.spawnedProcess.unref();
    this._writeOwnershipMarker(this.spawnedProcess.pid, mode);

    // Poll until Chrome CDP responds (up to 8 seconds)
    const startTime = Date.now();
    while (Date.now() - startTime < 8000) {
      await new Promise((r) => setTimeout(r, 400));
      const check = await this.isPortOpen();
      if (check.open) {
        return {
          alreadyRunning: false,
          version: check.version,
          port: this.port,
          mode,
        };
      }
    }

    this.stopSpawned();
    throw new Error(`Chrome started but CDP failed to respond on port ${this.port} within 8 seconds.`);
  }

  /**
   * Stop the Chrome instance if it was spawned by this app
   */
  stopSpawned() {
    if (this.spawnedProcess) {
      try {
        if (!this.spawnedProcess.killed) {
          this.spawnedProcess.kill();
        }
      } catch (err) {
        console.warn('Could not kill spawned Chrome process:', err);
      }
      this.spawnedProcess = null;
      this._clearOwnershipMarker();
    }
  }
}

module.exports = new ChromeSpawner();
