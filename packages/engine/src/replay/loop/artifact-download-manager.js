/**
 * src/replay/loop/artifact-download-manager.js
 * Manages CDP download interception, SHA-256 deduplication, structured directory
 * hierarchies, duplicate detection, and manifest synchronization.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const DownloadManager = require('../download-manager');
const DocumentDataExtractor = require('../../shared/document-data-extractor');
const logger = require('../../utils/logger');
const { getSafeStoragePath, safeMkdir } = require('../../utils/storage-helper');

class ArtifactDownloadManager {
  constructor(options = {}) {
    const opts = options || {};
    this.runId = opts.runId || `run_${Date.now()}`;
    this.workflowId = opts.workflowId || null;
    this.workflowName = opts.workflowName || 'workflow';
    this.userId = opts.userId || null;
    this.forceRedownload = opts.forceRedownload === true;
    this._downloadedRecords = [];

    const safeBaseRecordings = opts.baseRecordingsDir || (
      opts.structuredDownloadsDir ? path.join(path.dirname(opts.structuredDownloadsDir), 'recordings') : null
    ) || getSafeStoragePath('recordings');

    this.runsDir = opts.runsDir || path.join(safeBaseRecordings, 'runs', this.runId);
    this.downloadsDir = opts.downloadsDir || path.join(this.runsDir, 'downloads');

    // Structured downloads hierarchy: downloads/<workflow-slug>/<YYYY-MM-DD>/
    const rawSlug = (this.workflowName || this.workflowId || 'workflow').toLowerCase();
    this.workflowSlug = rawSlug.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workflow';
    this.dateStr = new Date().toISOString().split('T')[0];
    this.workflowDownloadsBaseDir = opts.baseDownloadsDir || getSafeStoragePath('downloads', this.workflowSlug);
    this.structuredDownloadsDir = opts.structuredDownloadsDir || path.resolve(this.workflowDownloadsBaseDir, this.dateStr);

    // Primary Run/ hierarchy: Run/<YYYY-MM-DD_HH-mm-ss>/<portalDomain>/<Category>/
    const targetUrl = opts.targetUrl || opts.portalUrl || '';
    let extractedDomain = opts.portalDomain || '';
    if (!extractedDomain && targetUrl) {
      try {
        const u = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
        extractedDomain = u.hostname;
      } catch {
        extractedDomain = targetUrl.replace(/https?:\/\//, '').split('/')[0];
      }
    }
    this.portalDomain = extractedDomain || 'customerportal.usoil.com';

    this.downloadManager = new DownloadManager({
      workflowSlug: this.workflowSlug,
      executionId: this.runId,
      workflowId: this.workflowId,
      portalDomain: this.portalDomain,
      portalUrl: targetUrl,
      runTimestamp: opts.runTimestamp,
      startedAt: opts.startedAt
    });

    this.runTimestamp = this.downloadManager.runTimestamp;
    this.runDomainDir = this.downloadManager.runDomainDir;
    this.executionDownloadsDir = this.downloadManager.getDirectory();
    this._replayTargetCreatedListener = null;
    this._activeItemContext = null;
    this.fallbackOsDownloads = opts.fallbackOsDownloads === true;
    this._diskFilesCache = null;
    this._diskFilesCacheTime = 0;
  }

  setPortalDomain(domain) {
    if (!domain) return;
    this.portalDomain = domain;
    if (this.downloadManager) {
      this.downloadManager.portalDomain = domain;
      if (this.downloadManager.runTimestampDir) {
        this.downloadManager.runDomainDir = path.resolve(this.downloadManager.runTimestampDir, domain);
        this.runDomainDir = this.downloadManager.runDomainDir;
        if (!fs.existsSync(this.runDomainDir)) {
          fs.mkdirSync(this.runDomainDir, { recursive: true });
        }
      }
    }
  }

  initDirectories() {
    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }
    if (!fs.existsSync(this.structuredDownloadsDir)) {
      fs.mkdirSync(this.structuredDownloadsDir, { recursive: true });
    }
    if (this.downloadManager) {
      this.downloadManager._initDirectory();
    }
  }

  processAndStoreDownload(sourcePath, itemKey = null, itemLabel = null, itemFields = {}) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    const filename = path.basename(sourcePath);
    if (filename.endsWith('.crdownload') || filename.endsWith('.tmp')) return null;

    // Fallback to active item context if itemKey or fields are missing
    if (!itemKey && this._activeItemContext) {
      itemKey = this._activeItemContext.itemKey;
      itemLabel = this._activeItemContext.itemLabel;
      itemFields = { ...(this._activeItemContext.fields || {}), ...itemFields };
    }

    try {
      this._diskFilesCache = null;
      this.initDirectories();
      const fileBuffer = fs.readFileSync(sourcePath);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fileSizeBytes = fileBuffer.length;

      // 1. Organize into primary Run/ hierarchy: Run/<runTimestamp>/<portalDomain>/<Category>/<formattedFilename>
      let runArtifact = null;
      if (this.downloadManager && typeof this.downloadManager.organizeRunArtifact === 'function') {
        runArtifact = this.downloadManager.organizeRunArtifact(sourcePath, { itemKey, itemLabel, itemFields, fileBuffer, fileHash });
      }

      let targetFilename = runArtifact ? runArtifact.targetFilename : filename;
      let destPath = path.join(this.structuredDownloadsDir, targetFilename);

      // Handle duplicate filename with different hash: append content hash or timestamp suffix
      if (fs.existsSync(destPath)) {
        try {
          const existingBuffer = fs.readFileSync(destPath);
          const existingHash = crypto.createHash('sha256').update(existingBuffer).digest('hex');
          if (existingHash !== fileHash) {
            const ext = path.extname(targetFilename);
            const base = path.basename(targetFilename, ext);
            targetFilename = `${base}_${fileHash.substring(0, 8)}${ext}`;
            destPath = path.join(this.structuredDownloadsDir, targetFilename);
            fs.copyFileSync(sourcePath, destPath);
          }
        } catch {
          fs.copyFileSync(sourcePath, destPath);
        }
      } else {
        fs.copyFileSync(sourcePath, destPath);
      }

      // Also copy to isolated per-execution downloads directory: downloads/<workflow-slug>/<execution-id>/
      if (this.executionDownloadsDir && fs.existsSync(this.executionDownloadsDir)) {
        const execDestPath = path.join(this.executionDownloadsDir, targetFilename);
        try {
          fs.copyFileSync(sourcePath, execDestPath);
        } catch {}
      }

      const relativeFilePath = path.relative(process.cwd(), destPath).replace(/\\/g, '/');
      const relativeRunPath = runArtifact ? runArtifact.relativeRunPath : null;

      // Extract PDF/CSV document fields and perform Web-to-Document amount reconciliation
      let docExtraction = { extractedFields: {}, reconciliationStatus: 'UNVERIFIED', reconciliationDelta: null };
      if (itemKey !== 'consolidated_table_export' && !targetFilename.includes('_extracted_data_')) {
        try {
          docExtraction = DocumentDataExtractor.extractFromFile(destPath, fileBuffer, itemFields);
        } catch (extractErr) {
          logger.warn(`[ArtifactDownloadManager] Document extraction notice for "${targetFilename}": ${extractErr.message}`);
        }
      }

      if (docExtraction.extractedFields && Object.keys(docExtraction.extractedFields).length > 0) {
        itemFields.Downloaded_File = targetFilename;
        Object.assign(itemFields, docExtraction.extractedFields);
        if (docExtraction.reconciliationStatus) {
          itemFields.Reconciliation_Status = docExtraction.reconciliationStatus;
        }
        if (docExtraction.reconciliationDelta !== undefined && docExtraction.reconciliationDelta !== null) {
          itemFields.Reconciliation_Delta = docExtraction.reconciliationDelta;
        }
      }

      if (this.downloadManager) {
        this.downloadManager.recordSuccess(itemKey || targetFilename, {
          filename: targetFilename,
          size: fileSizeBytes,
          filePath: destPath,
          runPath: relativeRunPath,
          category: runArtifact ? runArtifact.category : null
        }, { label: itemLabel, fields: itemFields });
      }

      const downloadRecord = {
        workflowId: this.workflowId,
        workflowName: this.workflowName,
        userId: this.userId,
        runId: this.runId,
        runTimestamp: this.runTimestamp,
        portalDomain: this.portalDomain,
        category: runArtifact ? runArtifact.category : 'Invoices',
        itemKey: itemKey || filename,
        itemLabel: itemLabel || filename,
        filename: targetFilename,
        fileHash,
        filePath: relativeFilePath,
        relativeFilePath: relativeFilePath,
        runPath: relativeRunPath,
        fileSizeBytes,
        itemFields: itemFields || {},
        extractedFields: docExtraction.extractedFields || {},
        reconciliationStatus: docExtraction.reconciliationStatus || 'UNVERIFIED',
        reconciliationDelta: docExtraction.reconciliationDelta,
        downloadedAt: new Date().toISOString()
      };

      const allRecords = this._getManifestDownloads();
      const existingRecord = allRecords.find(d =>
        d.workflowId === this.workflowId &&
        d.fileHash === fileHash &&
        (d.filePath === relativeFilePath || (relativeRunPath && d.runPath === relativeRunPath))
      );

      let savedRecord = existingRecord;
      if (!existingRecord) {
        if (!downloadRecord.id) {
          downloadRecord.id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        }
        this._downloadedRecords.push(downloadRecord);
        savedRecord = downloadRecord;
      }

      this.syncWorkflowDownloadsManifest(savedRecord || downloadRecord);

      logger.info(`[ArtifactDownloadManager] Download organized: "${targetFilename}" -> ${relativeRunPath || relativeFilePath} (${fileSizeBytes} bytes)`);

      return {
        id: (savedRecord || downloadRecord).id || `dl_${Date.now()}`,
        filename: targetFilename,
        path: destPath,
        relativePath: relativeFilePath,
        runPath: relativeRunPath,
        runDirectory: runArtifact ? runArtifact.categoryDir : null,
        portalDomain: this.portalDomain,
        runTimestamp: this.runTimestamp,
        category: runArtifact ? runArtifact.category : null,
        fileHash,
        sizeBytes: fileSizeBytes,
        itemKey: itemKey || filename,
        extractedFields: docExtraction.extractedFields || {},
        reconciliationStatus: docExtraction.reconciliationStatus || 'UNVERIFIED',
        reconciliationDelta: docExtraction.reconciliationDelta
      };
    } catch (err) {
      logger.error(`[ArtifactDownloadManager] Error organizing download "${sourcePath}": ${err.message}`);
      return {
        filename,
        path: sourcePath,
        sizeBytes: fs.existsSync(sourcePath) ? fs.statSync(sourcePath).size : 0
      };
    }
  }

  _getManifestDownloads() {
    const records = [...this._downloadedRecords];
    try {
      const manifestPath = path.join(this.workflowDownloadsBaseDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (Array.isArray(data.downloads)) {
          for (const d of data.downloads) {
            if (!records.some(r => r.fileHash === d.fileHash && r.filePath === d.filePath)) {
              records.push(d);
            }
          }
        }
      }
    } catch { }
    return records;
  }

  syncWorkflowDownloadsManifest(downloadRecord) {
    try {
      if (!fs.existsSync(this.workflowDownloadsBaseDir)) {
        fs.mkdirSync(this.workflowDownloadsBaseDir, { recursive: true });
      }
      const manifestPath = path.join(this.workflowDownloadsBaseDir, 'manifest.json');
      let manifestData = {
        workflowId: this.workflowId,
        workflowName: this.workflowName,
        lastUpdated: new Date().toISOString(),
        totalDownloads: 0,
        downloads: []
      };

      if (fs.existsSync(manifestPath)) {
        try {
          manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch { }
      }

      manifestData.lastUpdated = new Date().toISOString();
      manifestData.downloads = Array.isArray(manifestData.downloads) ? manifestData.downloads : [];

      const existsIdx = manifestData.downloads.findIndex(d =>
        d.fileHash === downloadRecord.fileHash || d.filePath === downloadRecord.filePath
      );

      if (existsIdx >= 0) {
        manifestData.downloads[existsIdx] = { ...manifestData.downloads[existsIdx], ...downloadRecord };
      } else {
        manifestData.downloads.push(downloadRecord);
      }
      manifestData.totalDownloads = manifestData.downloads.length;

      fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`[ArtifactDownloadManager] Could not update workflow download manifest: ${err.message}`);
    }
  }

  checkIfAlreadyDownloaded(itemKey, invoiceNumber = null, itemFields = {}, contentHash = null) {
    if (!itemKey && !invoiceNumber && !contentHash) return { isDuplicate: false };

    // 1. Manifest / in-memory check
    if (this.workflowId) {
      const records = this._getManifestDownloads().filter(d =>
        d.workflowId === this.workflowId && (
          (contentHash && d.fileHash === contentHash) ||
          (itemKey && d.itemKey === itemKey) ||
          (d.itemLabel && d.itemLabel === itemKey) ||
          (invoiceNumber && (
            (d.filename && d.filename.toLowerCase().includes(invoiceNumber.toLowerCase())) ||
            (d.itemLabel && d.itemLabel.toLowerCase().includes(invoiceNumber.toLowerCase())) ||
            (d.itemKey && d.itemKey.toLowerCase().includes(invoiceNumber.toLowerCase()))
          ))
        )
      );

      if (records && records.length > 0) {
        for (const rec of records) {
          if (rec.filePath) {
            const fullPath = path.resolve(process.cwd(), rec.filePath);
            if (fs.existsSync(fullPath)) {
              return { isDuplicate: true, inFolder: true, record: rec };
            }
          }
        }
      }
    }

    // 2. Physical disk scan in workflow downloads folder, run folder
    const targetInv = (invoiceNumber || (typeof itemKey === 'string' && itemKey.startsWith('invoice:') ? itemKey.replace(/^invoice:/, '') : null))?.trim();
    if (targetInv && targetInv.length >= 3 && this.workflowSlug && this.workflowSlug !== 'workflow') {
      const now = Date.now();
      if (!this._diskFilesCache || (now - this._diskFilesCacheTime > 10000)) {
        const candidateDirs = [
          this.structuredDownloadsDir,
          this.workflowDownloadsBaseDir,
          this.downloadsDir
        ].filter(Boolean);

        const cached = [];
        for (const dir of candidateDirs) {
          if (!fs.existsSync(dir)) continue;
          try {
            const files = fs.readdirSync(dir, { recursive: true });
            for (const file of files) {
              const fileName = typeof file === 'string' ? path.basename(file) : file;
              if (fileName && typeof fileName === 'string' && !fileName.endsWith('.crdownload') && !fileName.endsWith('.tmp')) {
                const fullPath = path.join(dir, fileName);
                cached.push({
                  fileName,
                  filePath: path.relative(process.cwd(), fullPath)
                });
              }
            }
          } catch {}
        }
        this._diskFilesCache = cached;
        this._diskFilesCacheTime = now;
      }

      for (const entry of this._diskFilesCache) {
        if (entry.fileName && entry.fileName.toLowerCase().includes(targetInv.toLowerCase())) {
          return {
            isDuplicate: true,
            inFolder: true,
            record: {
              filename: entry.fileName,
              filePath: entry.filePath
            }
          };
        }
      }
    }

    // 3. Due Date / Days Old evaluation for "old" data categorization
    const isOldData = (() => {
      if (itemFields && itemFields['Days Old'] && parseInt(itemFields['Days Old'], 10) > 0) {
        return true;
      }
      if (itemFields && itemFields['Due Date']) {
        const parsedDue = new Date(itemFields['Due Date']);
        if (!isNaN(parsedDue.getTime()) && parsedDue.getTime() <= Date.now()) {
          return true;
        }
      }
      return false;
    })();

    return { isDuplicate: false, isOldData };
  }

  async waitForDownload(previousSnapshot = [], timeoutMs = 10000) {
    const startedAt = Date.now();
    const previousRun = new Set(Array.isArray(previousSnapshot) ? previousSnapshot : (previousSnapshot.runFiles || []));
    const previousOs = new Set(Array.isArray(previousSnapshot) ? [] : (previousSnapshot.osFiles || []));
    const osDownloadsDir = path.join(os.homedir(), 'Downloads');
    let effectiveTimeoutMs = timeoutMs;

    while (Date.now() - startedAt < effectiveTimeoutMs) {
      // 1. Check primary isolated execution downloads directory
      const files = fs.existsSync(this.downloadsDir)
        ? fs.readdirSync(this.downloadsDir)
        : [];
      const candidates = files.filter(file => !previousRun.has(file) && !file.endsWith('.crdownload') && !file.endsWith('.tmp') && !file.endsWith('.download'));
      if (candidates.length) {
        return candidates.map(filename => ({
          filename,
          path: path.join(this.downloadsDir, filename),
          sizeBytes: fs.statSync(path.join(this.downloadsDir, filename)).size
        }));
      }

      // If a .crdownload file is active that was not there before, extend timeout to let it finish
      const inFlightCr = files.filter(file => !previousRun.has(file) && (file.endsWith('.crdownload') || file.endsWith('.download') || file.endsWith('.tmp')));
      if (inFlightCr.length && effectiveTimeoutMs < 45000) {
        effectiveTimeoutMs = 45000;
      }

      // 2. Fallback: Check if browser routed the download to OS default ~/Downloads
      if (fs.existsSync(osDownloadsDir)) {
        let currentOsFiles = [];
        try {
          currentOsFiles = fs.readdirSync(osDownloadsDir);
        } catch {
          currentOsFiles = [];
        }

        const inFlightOs = currentOsFiles.filter(file => !previousOs.has(file) && (file.endsWith('.crdownload') || file.endsWith('.download') || file.endsWith('.tmp')));
        if (inFlightOs.length && effectiveTimeoutMs < 45000) {
          effectiveTimeoutMs = 45000;
        }

        const newOsCompleted = currentOsFiles.filter(file =>
          !previousOs.has(file) &&
          !file.endsWith('.crdownload') &&
          !file.endsWith('.tmp') &&
          !file.endsWith('.download')
        );

        if (newOsCompleted.length > 0) {
          const copied = [];
          for (const osFile of newOsCompleted) {
            const osFilePath = path.join(osDownloadsDir, osFile);
            try {
              const stats = fs.statSync(osFilePath);
              if (stats.size > 0 && stats.mtimeMs >= startedAt - 2500) {
                this.initDirectories();
                const targetPath = path.join(this.downloadsDir, osFile);
                fs.copyFileSync(osFilePath, targetPath);
                copied.push({
                  filename: osFile,
                  path: targetPath,
                  sizeBytes: stats.size
                });
                logger.info(`[ArtifactDownloadManager] Captured download from OS downloads folder: "${osFile}" (${stats.size} bytes)`);
              }
            } catch {}
          }
          if (copied.length > 0) {
            return copied;
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return [];
  }

  snapshotDownloadedFiles() {
    const runFiles = fs.existsSync(this.downloadsDir)
      ? fs.readdirSync(this.downloadsDir).filter(file => !file.endsWith('.crdownload') && !file.endsWith('.tmp'))
      : [];
    let osFiles = [];
    if (this.fallbackOsDownloads === true) {
      try {
        const osDownloadsDir = path.join(os.homedir(), 'Downloads');
        if (fs.existsSync(osDownloadsDir)) {
          osFiles = fs.readdirSync(osDownloadsDir).filter(file => !file.endsWith('.crdownload') && !file.endsWith('.tmp'));
        }
      } catch {}
    }
    return {
      runFiles,
      osFiles,
      timestamp: Date.now()
    };
  }

  async configureDownloadInterception(page) {
    this.initDirectories();
    const configureTarget = async (target) => {
      try {
        const client = await target.createCDPSession();
        await client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: this.downloadsDir
        }).catch(() => { });
        return client;
      } catch {
        return null;
      }
    };

    try {
      // 1. Browser-level global download configuration across all frames & windows
      if (page.browser) {
        const browser = page.browser();
        try {
          const browserTarget = (typeof browser.targets === 'function' ? browser.targets().find(t => t.type() === 'browser') : null) || (typeof browser.target === 'function' ? browser.target() : null);
          if (browserTarget && typeof browserTarget.createCDPSession === 'function') {
            const browserClient = await browserTarget.createCDPSession();
            await browserClient.send('Browser.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: this.downloadsDir,
              eventsEnabled: true
            }).catch(() => { });
            logger.info(`[ArtifactDownloadManager] Configured browser-level CDP download path: ${this.downloadsDir}`);
          }
        } catch (bErr) {
          logger.warn(`[ArtifactDownloadManager] Note on Browser.setDownloadBehavior: ${bErr.message}`);
        }
      }

      const client = await configureTarget(page.target());
      logger.info(`[ArtifactDownloadManager] Configured CDP download path: ${this.downloadsDir}`);

      // Also configure across all other open pages
      if (page.browser) {
        const browser = page.browser();
        const pages = await browser.pages().catch(() => []);
        for (const p of pages) {
          if (p !== page && !p.isClosed()) {
            await configureTarget(p.target());
          }
        }

        // Auto-configure on any newly spawned window/tab during replay
        if (!this._replayTargetCreatedListener) {
          this._replayTargetCreatedListener = async (target) => {
            if (target.type() === 'page') {
              await configureTarget(target);
            }
          };
          browser.on('targetcreated', this._replayTargetCreatedListener);
        }
      }

      return client;
    } catch (err) {
      logger.warn(`[ArtifactDownloadManager] Warning configuring CDP download behavior: ${err.message}`);
      return null;
    }
  }

  teardownDownloadInterception(browser) {
    if (this._replayTargetCreatedListener && browser) {
      try {
        browser.off('targetcreated', this._replayTargetCreatedListener);
      } catch {}
      this._replayTargetCreatedListener = null;
    }
  }

  organizePendingDownloads(manifest, activeItemContext = null) {
    if (!fs.existsSync(this.downloadsDir)) return;
    try {
      const files = fs.readdirSync(this.downloadsDir)
        .filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (!Array.isArray(manifest.downloadedFiles)) {
        manifest.downloadedFiles = [];
      }
      for (const f of files) {
        const raw = path.join(this.downloadsDir, f);
        const stored = this.processAndStoreDownload(
          raw,
          activeItemContext?.itemKey || f,
          activeItemContext?.itemLabel || f,
          activeItemContext?.fields || {}
        );
        try { fs.unlinkSync(raw); } catch {}
        const itemToAdd = stored || { filename: f, path: raw, sizeBytes: fs.existsSync(raw) ? fs.statSync(raw).size : 0 };
        if (!manifest.downloadedFiles.some(existing => (existing.fileHash && existing.fileHash === itemToAdd.fileHash) || existing.path === itemToAdd.path)) {
          manifest.downloadedFiles.push(itemToAdd);
        }
      }
    } catch {}
  }

  /**
   * Automatically generates an Excel-compatible RFC 4180 CSV artifact with UTF-8 BOM
   * from manifest.extractedRows (or manifest.results items with fields).
   * @param {Object} manifest
   * @returns {Object|null} Created artifact record
   */
  generateStructuredDataArtifact(manifest) {
    if (!manifest) return null;

    let rows = [];
    if (Array.isArray(manifest.extractedRows) && manifest.extractedRows.length > 0) {
      rows = manifest.extractedRows;
    } else if (Array.isArray(manifest.results)) {
      rows = manifest.results
        .filter(r => r.fields && Object.keys(r.fields).length > 0)
        .map(r => ({
          Item_ID: r.itemKey || r.label || `item_${r.itemIndex ?? r.index}`,
          Page: r.page || 1,
          ...(r.fields || {})
        }));
    }

    if (!rows || rows.length === 0) {
      return null;
    }

    // Collect all unique column headers across all rows preserving column order:
    // Item_ID, Page, followed by discovered table columns and EXTRACT_TEXT fields
    const headerSet = new Set(['Item_ID', 'Page']);
    // First, table & detail fields
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!k || k.startsWith('__') || k === 'elementHandle' || k === 'asElement') continue;
        if (k === 'itemIdentifier' || k === 'page') continue;
        if (k.startsWith('Doc_') || k.startsWith('Reconciliation_') || k === 'Downloaded_File') continue;
        headerSet.add(k);
      }
    }
    // Then, document & reconciliation fields in structured finance order
    const financeDocHeaders = ['Downloaded_File', 'Doc_Invoice_Number', 'Doc_Date', 'Doc_Due_Date', 'Doc_Subtotal', 'Doc_Tax_Amount', 'Doc_Total_Amount', 'Doc_Row_Count', 'Reconciliation_Status', 'Reconciliation_Delta'];
    for (const dh of financeDocHeaders) {
      if (rows.some(r => r[dh] !== undefined)) {
        headerSet.add(dh);
      }
    }
    // Any remaining headers
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!k || k.startsWith('__') || k === 'elementHandle' || k === 'asElement') continue;
        if (k === 'itemIdentifier' || k === 'page') continue;
        headerSet.add(k);
      }
    }
    const headers = Array.from(headerSet);

    // Build Excel-compatible RFC 4180 CSV with UTF-8 BOM (\uFEFF)
    const escapeCsv = (val) => {
      if (val == null) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csvLines = [headers.map(escapeCsv).join(',')];
    for (const row of rows) {
      const line = headers.map(h => escapeCsv(row[h] ?? '')).join(',');
      csvLines.push(line);
    }
    const csvContent = '\uFEFF' + csvLines.join('\r\n');

    const targetDir = this.structuredDownloadsDir || this.downloadsDir || getSafeStoragePath('downloads');
    if (!fs.existsSync(targetDir)) {
      try { safeMkdir(targetDir); } catch {}
    }

    const dateTag = this.dateStr || new Date().toISOString().slice(0, 10);
    const slug = this.workflowSlug || 'workflow';
    const csvFileName = `${slug}_extracted_data_${dateTag}.csv`;
    const csvFilePath = path.join(targetDir, csvFileName);

    try {
      fs.writeFileSync(csvFilePath, csvContent, 'utf8');
      const fileBuffer = fs.readFileSync(csvFilePath);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const sizeBytes = fileBuffer.length;

      const csvArtifact = {
        filename: csvFileName,
        originalFilename: csvFileName,
        path: csvFilePath,
        relativePath: csvFileName,
        fileHash,
        sizeBytes,
        itemKey: 'consolidated_table_export',
        itemLabel: 'Consolidated Table Export (CSV)',
        category: 'Extracted_Data',
        portalDomain: this.portalDomain,
        rowCount: rows.length,
        columns: headers,
        timestamp: new Date().toISOString()
      };

      if (!Array.isArray(manifest.downloadedFiles)) {
        manifest.downloadedFiles = [];
      }
      if (!manifest.downloadedFiles.some(f => (f.fileHash && f.fileHash === fileHash) || f.path === csvFilePath)) {
        manifest.downloadedFiles.push(csvArtifact);
      }
      this._diskFilesCache = null;

      logger.success(`[ArtifactDownloadManager] Generated structured CSV data artifact: ${csvFileName} (${rows.length} rows, ${headers.length} columns)`);
      return csvArtifact;
    } catch (err) {
      logger.error(`[ArtifactDownloadManager] Failed to generate structured CSV data artifact: ${err.message}`);
      return null;
    }
  }
}

module.exports = ArtifactDownloadManager;
