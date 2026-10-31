/**
 * CDP Browser Connector Utility
 * 
 * Attaches puppeteer-core to an already running Chrome instance via CDP (e.g. localhost:9222).
 * Automatically launches Chrome with remote debugging enabled if not already running.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { CDPConnectionError } = require('./errors');
const { isDashboardUrl } = require('./url-helper');
const logger = require('./logger');

/**
 * Locate Google Chrome executable path for the current OS
 */
function getChromeExecutablePath() {
  const platform = process.platform;
  if (platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      path.join(os.homedir(), 'Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return macPaths.find(p => fs.existsSync(p)) || null;
  }
  if (platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    return winPaths.find(p => fs.existsSync(p)) || 'chrome.exe';
  }
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return linuxPaths.find(p => fs.existsSync(p)) || 'google-chrome';
}

/**
 * Quick check if CDP port is responding
 */
async function isCDPResponding(port = 9222) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 1000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Auto-launch Chrome with remote debugging enabled if not already running
 */
async function ensureChromeRunning(port = 9222, defaultUrl = 'about:blank') {
  const isUp = await isCDPResponding(port);
  if (isUp) return true;

  const chromePath = getChromeExecutablePath();
  if (!chromePath) {
    logger.warn('Could not locate Google Chrome executable for auto-launch.');
    return false;
  }

  const legacyProfile = path.join(os.homedir(), '.workflow-capture', 'chrome-profile');
  const defaultProfile = fs.existsSync(legacyProfile) ? legacyProfile : path.join(os.homedir(), '.reflow', 'chrome-profile');
  const profileDir = process.env.CHROME_PROFILE_DIR || defaultProfile;
  try {
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
  } catch {}
  logger.info(`Auto-launching Google Chrome with CDP on port ${port} (profile: ${profileDir})...`);

  // Clean stale lock files from previous runs to prevent Chrome from immediately exiting
  for (const dir of [profileDir, path.join(os.tmpdir(), 'chrome-capture-profile')]) {
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'RunningChromeVersion']) {
      try {
        const lockPath = path.join(dir, lock);
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

  try {
    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      defaultUrl
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Wait up to 6 seconds for Chrome CDP to become responsive
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await isCDPResponding(port)) {
        logger.success(`Google Chrome launched and CDP is active on port ${port}!`);
        return true;
      }
    }
  } catch (launchErr) {
    logger.error('Failed to auto-launch Chrome process:', launchErr);
  }

  return false;
}

/**
 * Connect to an existing Chrome browser via CDP (auto-launches Chrome if needed)
 * @param {Object} options
 * @param {string} [options.browserURL='http://localhost:9222']
 * @param {string} [options.targetUrlSubstring]
 * @returns {Promise<{ browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page }>}
 */
async function connectToBrowser(options = {}) {
  let browserURL = options.browserURL || process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
  browserURL = browserURL.replace('//localhost:', '//127.0.0.1:');
  const urlObj = new URL(browserURL);
  const port = parseInt(urlObj.port || '9222', 10);

  // 1. Ensure Chrome is running with CDP
  const isAvailable = await isCDPResponding(port);
  if (!isAvailable) {
    logger.info(`Chrome CDP not detected on port ${port}. Attempting auto-launch...`);
    await ensureChromeRunning(port);
  }

  logger.info(`Connecting to Chrome via CDP at ${browserURL}...`);

  let browser;
  try {
    browser = await Promise.race([
      puppeteer.connect({
        browserURL,
        defaultViewport: null, // Keep existing browser viewport
        targetFilter: (target) => {
          const type = typeof target?.type === 'function' ? target.type() : target?.type;
          const rawUrl = typeof target?.url === 'function' ? target.url() : target?.url;
          const url = typeof rawUrl === 'string' ? rawUrl : '';
          if (type === 'browser_ui' || type === 'other') return false;
          if (url && (url.startsWith('chrome://') || url.startsWith('devtools://'))) return false;
          return true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP connection timed out after 6000ms')), 6000))
    ]);
  } catch (err) {
    throw new CDPConnectionError(
      `Failed to connect to Chrome at ${browserURL}. Please ensure Chrome is running.\n` +
      `Original error: ${err.message}`,
      { originalError: err.message, browserURL }
    );
  }

  logger.success('Connected to Chrome via CDP.');

  // Helper to safely get URL without throwing "Requesting main frame too early!"
  const getSafeUrl = (p) => {
    try {
      return (typeof p?.url === 'function' ? p.url() : '') || '';
    } catch {
      return '';
    }
  };

  // Wait briefly for at least one target page to be known by Puppeteer
  let pages = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    pages = await browser.pages().catch(() => []);
    if (pages.length > 0) break;
    await new Promise(r => setTimeout(r, 200));
  }

  let targetPage = null;

  if (options.targetUrlSubstring) {
    targetPage = pages.find(p => getSafeUrl(p).includes(options.targetUrlSubstring));
    if (!targetPage) {
      logger.warn(`No tab found matching '${options.targetUrlSubstring}'. Falling back to active tab.`);
    }
  }

  if (!targetPage) {
    // Find all valid non-internal, non-dashboard portal pages
    const validPages = pages.filter(p => {
      const u = getSafeUrl(p);
      return !u.startsWith('devtools://') && !u.startsWith('chrome-extension://') && !u.startsWith('chrome://') && !isDashboardUrl(u);
    });

    if (validPages.length > 0) {
      // Find the portal tab the user is actively viewing (visibilityState === 'visible')
      for (const p of validPages) {
        try {
          const isVisible = await Promise.race([
            p.evaluate(() => document.visibilityState === 'visible'),
            new Promise(r => setTimeout(() => r(false), 150))
          ]);
          if (isVisible) {
            targetPage = p;
            break;
          }
        } catch {}
      }

      // If no portal tab explicitly claims visible, pick the most recent portal tab
      if (!targetPage) {
        targetPage = validPages[validPages.length - 1];
      }
    }
  }

  if (!targetPage) {
    if (pages.length > 0) {
      targetPage = pages[0];
    } else {
      logger.info('No open tabs found. Creating a new tab...');
      try {
        targetPage = await browser.newPage();
      } catch (npErr) {
        // If createTarget collided with Chrome startup window creation, wait and retry
        await new Promise(r => setTimeout(r, 500));
        pages = await browser.pages().catch(() => []);
        if (pages.length > 0) {
          targetPage = pages[0];
        } else {
          targetPage = await browser.newPage();
        }
      }
    }
  }

  // Ensure targetPage's main frame has initialized
  if (targetPage) {
    for (let i = 0; i < 20; i++) {
      try {
        if (targetPage.mainFrame && targetPage.mainFrame()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const attachedUrl = getSafeUrl(targetPage) || 'about:blank';
  logger.info(`Attached to tab: ${attachedUrl}`);

  return { browser, page: targetPage };
}

module.exports = {
  connectToBrowser,
  ensureChromeRunning,
  getChromeExecutablePath,
  isCDPResponding
};
