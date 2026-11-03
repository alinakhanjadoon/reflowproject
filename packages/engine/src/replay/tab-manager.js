/**
 * ReFlow — Intelligent Tab & Window Manager
 * 
 * Objectives:
 * 1. Maintain clear ownership of the Primary Workflow Tab (the portal page).
 * 2. Strictly protect the Dashboard tab and user's pre-existing tabs from being closed or corrupted.
 * 3. Intelligently detect, reuse, reconcile, and close duplicate workflow-created tabs/windows.
 * 4. Safely clean up auxiliary popup tabs (e.g., GUID document viewers, blob URLs, target="_blank" tabs)
 *    and ALWAYS return focus/activation to the primary portal workflow page.
 */

'use strict';

const logger = require('../utils/logger');
const { isDashboardUrl, isInternalBrowserUrl, extractWorkflowStartUrl } = require('../utils/url-helper');

class TabManager {
  constructor(options = {}) {
    this.browser = null;
    this.primaryPage = null;
    this.interruptionHandler = options.interruptionHandler || null;
    this.downloadsDir = options.downloadsDir || null;
    
    // Track pages present before execution started that are protected (dashboard & pre-existing user tabs)
    this.protectedPageIds = new Set();
    
    // Track auxiliary pages opened by workflow actions during execution
    this.auxiliaryPages = new Set();

    this._targetCreatedListener = null;
    this._targetDestroyedListener = null;
  }

  /**
   * Initialize TabManager with the active browser instance and starting page.
   * 
   * @param {import('puppeteer-core').Browser} browser
   * @param {import('puppeteer-core').Page} initialPage
   * @param {object} workflow
   */
  async initialize(browser, initialPage, workflow = null) {
    this.browser = browser;
    this.protectedPageIds.clear();
    this.auxiliaryPages.clear();

    if (!browser) return;

    // 1. Identify all currently open pages
    const existingPages = await browser.pages().catch(() => []);
    
    // 2. Resolve the primary workflow page first
    this.primaryPage = await this.resolvePrimaryPage(browser, workflow, initialPage);

    // 3. Classify existing tabs: Protect dashboard and real user tabs, but do NOT protect leftover auxiliary tabs
    for (const p of existingPages) {
      const id = this._getPageIdentifier(p);
      const u = this.getSafeUrl(p);

      if (this.interruptionHandler) {
        this.interruptionHandler.attachToPage(p);
      }

      if (p === this.primaryPage) {
        if (id) this.protectedPageIds.add(id);
      } else if (isDashboardUrl(u) || isInternalBrowserUrl(u)) {
        if (id) this.protectedPageIds.add(id);
      } else if (this._isAuxiliaryUrl(u)) {
        // Leftover auxiliary tab from previous run — mark for cleanup
        this.auxiliaryPages.add(p);
      } else {
        // User tab on other websites (e.g. Google, GitHub)
        if (id) this.protectedPageIds.add(id);
      }
    }

    // 4. Register lifecycle listeners on the browser
    this._setupBrowserLifecycleListeners();

    // 5. Clean up any leftover auxiliary tabs immediately and bring primary page to front
    await this.cleanupAuxiliaryTabs();
    await this.ensurePrimaryTabActive();

    logger.info(`[TabManager] Initialized. Primary tab: "${this.getSafeUrl(this.primaryPage)}", Protected tabs: ${this.protectedPageIds.size}`);
  }

  /**
   * Determine the primary workflow page, strictly avoiding the dashboard, internal tabs, or auxiliary viewer tabs.
   * 
   * @param {import('puppeteer-core').Browser} browser
   * @param {object} workflow
   * @param {import('puppeteer-core').Page} fallbackPage
   * @returns {Promise<import('puppeteer-core').Page>}
   */
  async resolvePrimaryPage(browser, workflow = null, fallbackPage = null) {
    if (!browser) return fallbackPage;

    const pages = await browser.pages().catch(() => []);
    if (pages.length === 0) return fallbackPage;

    const targetUrl = extractWorkflowStartUrl(workflow) || workflow?.targetUrl || workflow?.startUrl || workflow?.recordingData?.startUrl || '';
    let targetOrigin = '';
    let targetHash = '';
    try {
      if (targetUrl && !isInternalBrowserUrl(targetUrl)) {
        const parsed = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
        targetOrigin = parsed.origin;
        targetHash = parsed.hash || '';
      }
    } catch {}

    // Filter out dashboard, internal, and auxiliary pages
    const validPortalPages = pages.filter(p => {
      const u = this.getSafeUrl(p);
      return u && !isDashboardUrl(u) && !isInternalBrowserUrl(u) && !this._isAuxiliaryUrl(u);
    });

    // Strategy 1: Exact URL match (origin + path + hash)
    if (targetUrl && validPortalPages.length > 0) {
      const exactMatch = validPortalPages.find(p => {
        const u = this.getSafeUrl(p);
        return u === targetUrl || (targetHash && u.includes(targetHash));
      });
      if (exactMatch) return exactMatch;
    }

    // Strategy 2: Page on the same targetOrigin that has an active authenticated portal application
    if (targetOrigin && validPortalPages.length > 0) {
      const originMatches = validPortalPages.filter(p => this.getSafeUrl(p).startsWith(targetOrigin));
      if (originMatches.length > 0) {
        // Prefer an authenticated application subpage (e.g. #/message-center, #/invoices) over /home or /login
        const appPage = originMatches.find(p => {
          const u = this.getSafeUrl(p);
          return u.includes('/#/') && !/#(.*)\/(home|login|landing)/i.test(u);
        });
        if (appPage) return appPage;
        return originMatches[0];
      }
    }

    // Strategy 3: Visible portal page (non-auxiliary)
    for (const p of validPortalPages) {
      try {
        const isVisible = await Promise.race([
          p.evaluate(() => document.visibilityState === 'visible'),
          new Promise(r => setTimeout(() => r(false), 150))
        ]);
        if (isVisible) return p;
      } catch {}
    }

    // Strategy 4: Most recent non-auxiliary portal page
    if (validPortalPages.length > 0) {
      return validPortalPages[validPortalPages.length - 1];
    }

    // Fallback: If fallbackPage is non-dashboard and non-auxiliary, use it; otherwise first valid page
    if (fallbackPage && !isDashboardUrl(this.getSafeUrl(fallbackPage)) && !this._isAuxiliaryUrl(this.getSafeUrl(fallbackPage))) {
      return fallbackPage;
    }

    return pages.find(p => !isDashboardUrl(this.getSafeUrl(p)) && !this._isAuxiliaryUrl(this.getSafeUrl(p))) || pages[0] || fallbackPage;
  }

  /**
   * Ensure that replayEngine.page is set to primaryPage and primaryPage is brought to the front.
   * Restores focus to the main workflow.
   * 
   * @param {object} replayEngine
   */
  async ensurePrimaryTabActive(replayEngine = null) {
    if (!this.primaryPage || (typeof this.primaryPage.isClosed === 'function' && this.primaryPage.isClosed())) {
      if (this.browser) {
        this.primaryPage = await this.resolvePrimaryPage(this.browser);
      }
    }

    if (this.primaryPage && (typeof this.primaryPage.isClosed !== 'function' || !this.primaryPage.isClosed())) {
      if (replayEngine) {
        replayEngine.page = this.primaryPage;
      }
      try {
        if (typeof this.primaryPage.bringToFront === 'function') {
          await this.primaryPage.bringToFront().catch(() => {});
        }
      } catch {}
    }
  }

  /**
   * Reconcile active tab before an action executes.
   * - Ensures replayEngine is connected to an open, valid workflow tab.
   * - Does NOT aggressively close auxiliary tabs during action replay.
   * 
   * @param {object} action
   * @param {object} replayEngine
   */
  async reconcileActiveTab(action, replayEngine) {
    if (!replayEngine) return;

    // Only restore primary page if the current page is closed or pointed at dashboard/internal
    const currentPage = replayEngine.page;
    const isCurrentValid = currentPage &&
      (typeof currentPage.isClosed !== 'function' || !currentPage.isClosed()) &&
      !isDashboardUrl(this.getSafeUrl(currentPage));

    if (!isCurrentValid) {
      await this.ensurePrimaryTabActive(replayEngine);
    }
  }

  /**
   * Safely close auxiliary tabs opened by workflow actions (e.g. document viewers, GUID tabs).
   * Restores focus to the primary portal page.
   * NEVER closes the primary page or protected dashboard tabs.
   */
  async cleanupAuxiliaryTabs() {
    if (!this.browser) return;

    try {
      const allPages = await this.browser.pages().catch(() => []);
      const candidatePages = new Set([...allPages, ...this.auxiliaryPages]);

      for (const p of candidatePages) {
        if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;

        // NEVER close the primary workflow tab
        if (p === this.primaryPage) continue;

        const id = this._getPageIdentifier(p);
        const pUrl = this.getSafeUrl(p);

        // NEVER close dashboard tab or protected user tabs
        if (this.protectedPageIds.has(id) || isDashboardUrl(pUrl)) continue;

        // Check if auxiliary tab
        const isAux = this.auxiliaryPages.has(p) || this._isAuxiliaryUrl(pUrl);

        if (isAux) {
          logger.info(`[TabManager] Safely closing auxiliary workflow tab: "${pUrl || 'viewer'}"`);
          this.auxiliaryPages.delete(p);
          await p.close().catch(() => {});
        }
      }

      // Restore focus to the primary portal tab
      if (this.primaryPage && typeof this.primaryPage.isClosed === 'function' && !this.primaryPage.isClosed()) {
        await this.primaryPage.bringToFront().catch(() => {});
      }
    } catch (err) {
      logger.warn(`[TabManager] Warning during auxiliary tab cleanup: ${err.message}`);
    }
  }

  /**
   * Returns list of safe pages for element search (excludes dashboard, internal, and auxiliary viewer tabs).
   * 
   * @returns {Promise<Array<import('puppeteer-core').Page>>}
   */
  async getPagesToCheck() {
    if (!this.browser) return this.primaryPage ? [this.primaryPage] : [];

    const pages = await this.browser.pages().catch(() => []);
    const validPages = [];

    // Prioritize primaryPage first
    if (this.primaryPage && !this.primaryPage.isClosed()) {
      validPages.push(this.primaryPage);
    }

    // Add other valid non-dashboard, non-auxiliary pages if any
    for (const p of pages) {
      if (p === this.primaryPage || p.isClosed()) continue;
      const u = this.getSafeUrl(p);
      if (!isDashboardUrl(u) && !isInternalBrowserUrl(u) && !this._isAuxiliaryUrl(u)) {
        validPages.push(p);
      }
    }

    return validPages;
  }

  /**
   * Checks if a URL represents an auxiliary tab (document viewer, GUID tab, blob, export).
   * 
   * @param {string} url
   * @param {string} title
   * @returns {boolean}
   */
  _isAuxiliaryUrl(url, title = '') {
    if (!url) return false;
    if (isDashboardUrl(url) || isInternalBrowserUrl(url)) return false;

    // NEVER treat the primary page as auxiliary
    if (this.primaryPage) {
      const primaryUrl = this.getSafeUrl(this.primaryPage);
      if (primaryUrl && (url === primaryUrl || this._isDuplicateOfPrimary(url))) {
        return false;
      }
    }

    // Blob URLs
    if (url.startsWith('blob:')) return true;

    // GUID in URL or Title (e.g. "a2f87723-04ee-4092-b858-..." or "c211a36e-b133-466c-a32d-...")
    const guidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
    if (guidRegex.test(url) || (title && guidRegex.test(title))) return true;

    // Document viewers and export endpoints
    const lower = url.toLowerCase();
    if (
      lower.includes('/viewer') ||
      lower.includes('/document/') ||
      lower.includes('/export/') ||
      lower.includes('/report/view') ||
      lower.includes('/download/') ||
      lower.endsWith('.pdf') ||
      lower.endsWith('.csv') ||
      lower.endsWith('.xlsx')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Checks if a URL is an exact duplicate of the primary portal page.
   * 
   * @param {string} url
   * @returns {boolean}
   */
  _isDuplicateOfPrimary(url) {
    if (!url || !this.primaryPage) return false;
    if (url === 'about:blank' || isInternalBrowserUrl(url) || isDashboardUrl(url)) return false;

    const primaryUrl = this.getSafeUrl(this.primaryPage);
    if (!primaryUrl) return false;

    try {
      const u1 = new URL(url);
      const u2 = new URL(primaryUrl);
      if (u1.origin !== u2.origin) return false;

      // Search parameters must match. A different query string represents a distinct view/document.
      if (u1.search !== u2.search) return false;

      const normPath1 = (u1.pathname + u1.hash).replace(/\/+$/, '');
      const normPath2 = (u2.pathname + u2.hash).replace(/\/+$/, '');

      return normPath1 === normPath2;
    } catch {
      return url === primaryUrl;
    }
  }

  /**
   * Get safe string URL of a page without throwing.
   */
  getSafeUrl(page) {
    if (!page) return '';
    try {
      return (typeof page.url === 'function' ? page.url() : '') || '';
    } catch {
      return '';
    }
  }

  getPrimaryPage() {
    return this.primaryPage;
  }

  destroy() {
    if (this.browser) {
      if (this._targetCreatedListener) {
        this.browser.off('targetcreated', this._targetCreatedListener);
        this._targetCreatedListener = null;
      }
      if (this._targetDestroyedListener) {
        this.browser.off('targetdestroyed', this._targetDestroyedListener);
        this._targetDestroyedListener = null;
      }
    }
    this.auxiliaryPages.clear();
    this.protectedPageIds.clear();
    this.primaryPage = null;
    this.browser = null;
  }

  /* -------------------------------------------------------------
     Internal Lifecycle Helpers
     ------------------------------------------------------------- */

  _setupBrowserLifecycleListeners() {
    if (!this.browser) return;

    this._targetCreatedListener = async (target) => {
      try {
        if (!target || target.type() !== 'page') return;
        const page = await target.page().catch(() => null);
        if (!page) return;

        // Configure CDP downloads on new page immediately so files don't block
        if (this.downloadsDir && target.createCDPSession) {
          const client = await target.createCDPSession().catch(() => null);
          if (client) {
            await client.send('Page.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: this.downloadsDir
            }).catch(() => {});
            await client.detach().catch(() => {});
          }
        }

        // Attach interruption handler to this new page immediately
        if (this.interruptionHandler) {
          this.interruptionHandler.attachToPage(page);
        }

        // Inspector function to handle duplicate or auxiliary tab
        const checkAndHandleNewPage = async () => {
          if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
          const pUrl = this.getSafeUrl(page);

          // Duplicate of primary page -> close and focus primary
          if (this.primaryPage && this._isDuplicateOfPrimary(pUrl)) {
            logger.info(`[TabManager] Detected duplicate tab opened for "${pUrl}". Focusing primary tab and closing duplicate.`);
            await page.close().catch(() => {});
            await this.ensurePrimaryTabActive();
            return;
          }

          // Auxiliary tab (GUID viewer, blob, document export) -> track safely without forcibly defocusing
          if (this._isAuxiliaryUrl(pUrl)) {
            logger.info(`[TabManager] Tracked auxiliary workflow tab: "${pUrl}".`);
            this.auxiliaryPages.add(page);
            return;
          }
        };

        // Check immediately
        await checkAndHandleNewPage();

        // Also check when page navigates past initial blank
        if (typeof page.once === 'function') {
          page.once('framenavigated', async () => {
            await new Promise(r => setTimeout(r, 150));
            await checkAndHandleNewPage();
          });
        }
      } catch (err) {
        logger.warn(`[TabManager] targetcreated note: ${err.message}`);
      }
    };

    this._targetDestroyedListener = async (target) => {
      try {
        if (!target || target.type() !== 'page') return;
        // Clean up references if an auxiliary tab closed
        for (const p of this.auxiliaryPages) {
          if (p.isClosed()) this.auxiliaryPages.delete(p);
        }
      } catch {}
    };

    this.browser.on('targetcreated', this._targetCreatedListener);
    this.browser.on('targetdestroyed', this._targetDestroyedListener);
  }

  async _reconcileDuplicateTabs() {
    if (!this.browser || !this.primaryPage) return;
    const primaryUrl = this.getSafeUrl(this.primaryPage);
    if (!primaryUrl || isInternalBrowserUrl(primaryUrl) || isDashboardUrl(primaryUrl)) return;

    try {
      const pages = await this.browser.pages().catch(() => []);
      for (const p of pages) {
        if (p === this.primaryPage || p.isClosed()) continue;
        const u = this.getSafeUrl(p);
        if (this._isDuplicateOfPrimary(u) && !this.protectedPageIds.has(this._getPageIdentifier(p))) {
          logger.info(`[TabManager] Closing duplicate tab of primary portal: "${u}"`);
          this.auxiliaryPages.delete(p);
          await p.close().catch(() => {});
        }
      }
    } catch {}
  }

  _getPageIdentifier(page) {
    if (!page) return null;
    try {
      const target = typeof page.target === 'function' ? page.target() : null;
      return target ? (target._targetId || target.url?.() || page.url?.()) : (page.url?.() || null);
    } catch {
      return null;
    }
  }
}

module.exports = TabManager;
