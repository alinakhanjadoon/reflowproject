/**
 * ReFlow — Dedicated Download Manager & Validation Engine
 * 
 * Enforces strict per-execution folder isolation:
 * downloads/<workflow-name>/<execution-id>/
 * 
 * Never mixes files across executions.
 * Validates actual file receipt (existence, size > 0, completion of .crdownload/.tmp).
 * Maintains execution metadata and per-item download receipts.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const logger = require('../utils/logger');
const { getSafeStorageBase } = require('../utils/storage-helper');

function formatRunTimestamp(date = new Date()) {
  if (typeof date === 'string') {
    const s = date.trim();
    if (/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
      return s.replace('T', '_').replace(/:/g, '-').split('.')[0];
    }
  }
  const d = (date instanceof Date) ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

function extractPortalDomain(inputUrl) {
  if (!inputUrl) return 'customerportal.usoil.com';
  const str = String(inputUrl).trim();
  try {
    const parsed = new URL(str.startsWith('http://') || str.startsWith('https://') ? str : `https://${str}`);
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return parsed.hostname;
    }
    if (parsed.hostname === 'localhost' && !str.includes('localhost')) {
      const domainPart = str.split('/')[0];
      if (domainPart.includes('.')) return domainPart;
    }
    return parsed.hostname || 'customerportal.usoil.com';
  } catch {
    const match = str.match(/([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z0-9]{2,}/);
    return match ? match[0] : 'customerportal.usoil.com';
  }
}

class DownloadManager {
  /**
   * @param {object} options
   * @param {string} options.workflowSlug - Sanitized workflow name
   * @param {string} options.executionId - Unique run / execution ID
   * @param {string} [options.workflowId] - Optional workflow ID
   * @param {string} [options.baseDownloadsDir] - Custom base downloads directory
   * @param {string} [options.portalDomain] - Portal domain / hostname (e.g. customerportal.usoil.com)
   * @param {string} [options.portalUrl] - Portal URL to extract domain from
   * @param {string} [options.runTimestamp] - Formatted execution timestamp (YYYY-MM-DD_HH-mm-ss)
   * @param {string} [options.baseRunDir] - Custom base Run/ directory
   */
  constructor(options = {}) {
    const opts = options || {};
    const rawSlug = String(opts.workflowSlug || opts.workflowName || 'workflow').toLowerCase();
    this.workflowSlug = rawSlug.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workflow';
    this.executionId = opts.executionId || opts.runId || `exec_${Date.now()}`;
    this.workflowId = opts.workflowId || null;

    // Dedicated per-execution downloads isolation: downloads/<workflow-slug>/<execution-id>/
    const baseDir = opts.baseDownloadsDir || getSafeStorageBase('downloads');
    this.executionDirectory = path.resolve(baseDir, this.workflowSlug, this.executionId);
    this.manifestPath = path.join(this.executionDirectory, 'manifest.json');

    // Structured Run/ hierarchy: Run/<YYYY-MM-DD_HH-mm-ss>/<portal_domain>/<Category>/
    this.runTimestamp = opts.runTimestamp || formatRunTimestamp(opts.startedAt || new Date());
    this.portalDomain = extractPortalDomain(opts.portalDomain || opts.portalUrl || opts.targetUrl || opts.startUrl || 'customerportal.usoil.com');
    this.baseRunDir = opts.baseRunDir || getSafeStorageBase('Run');
    this.runTimestampDir = path.resolve(this.baseRunDir, this.runTimestamp);
    this.runDomainDir = path.resolve(this.runTimestampDir, this.portalDomain);

    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.files = [];
    this.successCount = 0;
    this.failureCount = 0;

    this._initDirectory();
  }

  _initDirectory() {
    try {
      if (!fs.existsSync(this.executionDirectory)) {
        fs.mkdirSync(this.executionDirectory, { recursive: true });
      }
    } catch (err) {
      logger.warn(`Could not create execution directory ${this.executionDirectory}: ${err.message}. Falling back to tmp.`);
      this.executionDirectory = path.join(os.tmpdir(), 'ReFlow', 'downloads', this.workflowSlug, this.executionId);
      try { fs.mkdirSync(this.executionDirectory, { recursive: true }); } catch {}
      this.manifestPath = path.join(this.executionDirectory, 'manifest.json');
    }

    try {
      if (!fs.existsSync(this.runDomainDir)) {
        fs.mkdirSync(this.runDomainDir, { recursive: true });
      }
    } catch (err) {
      logger.warn(`Could not create run domain directory ${this.runDomainDir}: ${err.message}. Falling back to tmp.`);
      this.runDomainDir = path.join(os.tmpdir(), 'ReFlow', 'Run', this.runTimestamp, this.portalDomain);
      try { fs.mkdirSync(this.runDomainDir, { recursive: true }); } catch {}
    }

    try {
      this._saveManifest();
    } catch {}
  }

  /**
   * Get the isolated target directory for this execution.
   */
  getDirectory() {
    return this.executionDirectory;
  }

  /**
   * Get the Run/ category directory (ensuring it exists)
   * e.g. Run/2026-10-02_03-42-18/customerportal.usoil.com/Invoices/
   */
  getRunCategoryDirectory(category = 'Invoices') {
    const cat = category || 'Invoices';
    const catDir = path.join(this.runDomainDir, cat);
    if (!fs.existsSync(catDir)) {
      fs.mkdirSync(catDir, { recursive: true });
    }
    return catDir;
  }

  /**
   * Infer category folder name (e.g. "Invoices", "Payments", "Receipts") from item metadata
   */
  inferCategory(filename = '', itemFields = {}, defaultCategory = 'Invoices') {
    const rawType = (
      itemFields.category ||
      itemFields.Category ||
      itemFields['Document Type'] ||
      itemFields['Type'] ||
      itemFields.type ||
      itemFields.documentType ||
      ''
    ).trim();

    if (/invoice/i.test(rawType)) return 'Invoices';
    if (/payment/i.test(rawType)) return 'Payments';
    if (/receipt/i.test(rawType)) return 'Receipts';
    if (/statement/i.test(rawType)) return 'Statements';
    if (/voucher/i.test(rawType)) return 'Vouchers';
    if (/bill/i.test(rawType)) return 'Bills';
    if (/credit\s*memo/i.test(rawType)) return 'Credit Memos';
    if (/order/i.test(rawType)) return 'Orders';
    if (/report/i.test(rawType)) return 'Reports';

    const fn = String(filename || '');
    if (/^PAY-|^PAYMENT|payment/i.test(fn)) return 'Payments';
    if (/^INV-|^INVOICE|invoice/i.test(fn)) return 'Invoices';
    if (/^REC-|^RECEIPT|receipt/i.test(fn)) return 'Receipts';
    if (/^STMT-|^STATEMENT|statement/i.test(fn)) return 'Statements';
    if (/^VOUCH-|^VOUCHER|voucher/i.test(fn)) return 'Vouchers';
    if (/^BILL-|bill/i.test(fn)) return 'Bills';

    if (/payment/i.test(this.workflowSlug)) return 'Payments';
    if (/invoice/i.test(this.workflowSlug)) return 'Invoices';
    if (/voucher/i.test(this.workflowSlug)) return 'Vouchers';

    if (rawType) {
      const cleaned = rawType.replace(/[^a-zA-Z0-9_\s]/g, '').trim();
      if (cleaned) {
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      }
    }

    return defaultCategory;
  }

  /**
   * Determine if a filename is a generic reporting or default export name
   * (e.g. InvoiceMainReport.pdf, report.pdf, export.pdf)
   */
  isGenericFilename(filename = '') {
    const raw = String(filename || '').trim();
    const ext = path.extname(raw);
    const base = path.basename(raw, ext);
    return /^(invoicemainreport|mainreport|report|export|download|document|viewer|print|default|statement|invoice|invoices)(\s*\(\d+\))?$/i.test(base);
  }

  /**
   * Extract document metadata and text from file buffer (PDF streams / raw text)
   * to discover document numbers and compute content hash.
   */
  extractDocMetadataFromFile(sourcePathOrBuffer) {
    if (!sourcePathOrBuffer) return { docId: null, dateStr: null, fileHash: null };
    try {
      const buf = Buffer.isBuffer(sourcePathOrBuffer)
        ? sourcePathOrBuffer
        : (fs.existsSync(sourcePathOrBuffer) ? fs.readFileSync(sourcePathOrBuffer) : null);
      if (!buf || !buf.length) return { docId: null, dateStr: null, fileHash: null };

      const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
      const rawStr = buf.toString('latin1');
      const docIdRegex = /\b((?:SI|INV|DR|TX|CM)-\d+(?:[-_]\w+)*|\b\d{5,10}\b)/gi;

      let match = docIdRegex.exec(rawStr);
      if (match) {
        return { docId: match[1].toUpperCase(), dateStr: null, fileHash };
      }

      // Check uncompressed/inflated streams in PDF
      if (rawStr.startsWith('%PDF')) {
        const zlib = require('zlib');
        let offset = 0;
        while (true) {
          const streamIdx = buf.indexOf('stream', offset);
          if (streamIdx === -1) break;
          let start = streamIdx + 6;
          while (buf[start] === 13 || buf[start] === 10) start++;
          const endIdx = buf.indexOf('endstream', start);
          if (endIdx === -1) break;
          try {
            const unzipped = zlib.inflateSync(buf.slice(start, endIdx)).toString('latin1');
            docIdRegex.lastIndex = 0;
            match = docIdRegex.exec(unzipped);
            if (match) {
              return { docId: match[1].toUpperCase(), dateStr: null, fileHash };
            }
          } catch {}
          offset = endIdx + 9;
        }
      }

      return { docId: null, dateStr: null, fileHash };
    } catch {
      return { docId: null, dateStr: null, fileHash: null };
    }
  }

  /**
   * Format meaningful artifact filename from item fields:
   * e.g. INV-10234_ACME_2026-09-30.pdf, PAY-88321_2026-09-30.pdf
   */
  formatItemFilename(originalFilename = '', itemFields = {}, fallbackItemKey = '', sourcePathOrBuffer = null) {
    const raw = String(originalFilename || '').trim();
    const ext = path.extname(raw) || '.pdf';
    const base = path.basename(raw, ext);

    // If filename already matches the structured format <ID>_<ENTITY>_<DATE>.pdf or <ID>_<DATE>.pdf
    if (/^[A-Z0-9]+-[A-Z0-9]+(?:_[A-Z0-9]+)?_\d{4}-\d{2}-\d{2}$/i.test(base)) {
      return `${base}${ext}`;
    }

    // 1. Extract ID (e.g. INV-10234, PAY-88321, etc.)
    let docId = (
      itemFields['Invoice Number'] ||
      itemFields['Invoice No'] ||
      itemFields['Invoice'] ||
      itemFields['Payment ID'] ||
      itemFields['Payment No'] ||
      itemFields['Payment'] ||
      itemFields['Voucher ID'] ||
      itemFields['Voucher No'] ||
      itemFields['ID'] ||
      itemFields['id'] ||
      itemFields['Item ID'] ||
      itemFields['Number'] ||
      ''
    ).trim();

    if (!docId) {
      const match = (raw + ' ' + (fallbackItemKey || '')).match(/\b((?:INV|PAY|REC|STMT|VOUCH|SI|DR|TX|CM)-\d+(?:[-_]\w+)*|\b\d{5,10}\b)/i);
      if (match) {
        docId = match[1].toUpperCase();
      }
    }

    // 2. Extract Customer / Account / Vendor
    let customer = (
      itemFields['Customer'] ||
      itemFields['Customer Name'] ||
      itemFields['Account'] ||
      itemFields['Account Name'] ||
      itemFields['Vendor'] ||
      itemFields['Client'] ||
      itemFields['Company'] ||
      ''
    ).trim().replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();

    // 3. Extract or format Date (YYYY-MM-DD)
    let dateStr = (
      itemFields['Date'] ||
      itemFields['Invoice Date'] ||
      itemFields['Payment Date'] ||
      itemFields['Due Date'] ||
      ''
    ).trim();

    if (dateStr) {
      const dMatch = dateStr.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) ||
                     dateStr.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
      if (dMatch) {
        if (dMatch[1].length === 4) {
          dateStr = `${dMatch[1]}-${String(dMatch[2]).padStart(2, '0')}-${String(dMatch[3]).padStart(2, '0')}`;
        } else {
          dateStr = `${dMatch[3]}-${String(dMatch[1]).padStart(2, '0')}-${String(dMatch[2]).padStart(2, '0')}`;
        }
      }
    }

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      dateStr = this.runTimestamp.split('_')[0] || new Date().toISOString().split('T')[0];
    }

    // 4. If docId still missing and filename is generic, attempt in-file inspection
    let fileHash = null;
    if (!docId && sourcePathOrBuffer) {
      const extracted = this.extractDocMetadataFromFile(sourcePathOrBuffer);
      if (extracted.docId) {
        docId = extracted.docId;
      }
      fileHash = extracted.fileHash;
    }

    // 5. Assemble clean structured filename
    if (docId) {
      const cleanDocId = docId.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
      if (customer) {
        return `${cleanDocId}_${customer}_${dateStr}${ext}`;
      } else {
        return `${cleanDocId}_${dateStr}${ext}`;
      }
    }

    // 6. Generic filename differentiation:
    // If the filename is generic (e.g. InvoiceMainReport.pdf) and inside is different,
    // append short content hash so distinct files never overwrite each other
    if (this.isGenericFilename(raw)) {
      if (!fileHash && sourcePathOrBuffer) {
        try {
          const buf = Buffer.isBuffer(sourcePathOrBuffer)
            ? sourcePathOrBuffer
            : (fs.existsSync(sourcePathOrBuffer) ? fs.readFileSync(sourcePathOrBuffer) : null);
          if (buf) {
            fileHash = crypto.createHash('sha256').update(buf).digest('hex');
          }
        } catch {}
      }
      if (fileHash) {
        return `${base}_${fileHash.substring(0, 8)}${ext}`;
      }
    }

    return raw || `artifact_${Date.now()}${ext}`;
  }

  /**
   * Organize downloaded file into the exact Run/ hierarchy:
   * Run/<runTimestamp>/<portalDomain>/<Category>/<formattedFilename>
   */
  organizeRunArtifact(sourcePath, itemKey = null, itemLabel = null, itemFields = {}) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;

    const originalFilename = path.basename(sourcePath);
    if (originalFilename.endsWith('.crdownload') || originalFilename.endsWith('.tmp')) return null;

    // Support options object as 2nd arg or options passed via itemFields
    const options = (itemKey && typeof itemKey === 'object' && !Array.isArray(itemKey)) ? itemKey : (itemFields && typeof itemFields === 'object' ? itemFields : {});
    const effectiveItemKey = (itemKey && typeof itemKey === 'object') ? options.itemKey || null : itemKey;
    const effectiveItemLabel = (itemKey && typeof itemKey === 'object') ? options.itemLabel || null : itemLabel;
    const effectiveItemFields = (itemKey && typeof itemKey === 'object') ? options.itemFields || {} : (itemFields || {});

    const fileBuffer = options.fileBuffer || fs.readFileSync(sourcePath);
    const fileHash = options.fileHash || crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const category = this.inferCategory(originalFilename, effectiveItemFields);
    let targetFilename = this.formatItemFilename(originalFilename, effectiveItemFields, effectiveItemKey, fileBuffer);
    const categoryDir = path.join(this.runDomainDir, category);

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    let destPath = path.join(categoryDir, targetFilename);

    // Collision check: if a file already exists at destPath:
    if (fs.existsSync(destPath)) {
      try {
        const existingBuf = fs.readFileSync(destPath);
        const existingHash = crypto.createHash('sha256').update(existingBuf).digest('hex');
        if (existingHash !== fileHash) {
          // Inside content is DIFFERENT! Never overwrite.
          const ext = path.extname(targetFilename);
          const base = path.basename(targetFilename, ext);
          targetFilename = `${base}_${fileHash.substring(0, 8)}${ext}`;
          destPath = path.join(categoryDir, targetFilename);
          fs.copyFileSync(sourcePath, destPath);
        }
      } catch {
        fs.copyFileSync(sourcePath, destPath);
      }
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }

    const relativeRunPath = path.relative(process.cwd(), destPath).replace(/\\/g, '/');

    return {
      targetFilename,
      category,
      categoryDir,
      fullPath: destPath,
      relativeRunPath,
      fileHash
    };
  }

  /**
   * Save execution manifest metadata.
   */
  _saveManifest() {
    const metadata = {
      executionId: this.executionId,
      workflowId: this.workflowId,
      workflowSlug: this.workflowSlug,
      runTimestamp: this.runTimestamp,
      portalDomain: this.portalDomain,
      runDirectory: this.runDomainDir,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      directory: this.executionDirectory,
      successCount: this.successCount,
      failureCount: this.failureCount,
      files: this.files
    };

    try {
      fs.writeFileSync(this.manifestPath, JSON.stringify(metadata, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`[DownloadManager] Failed to write manifest: ${err.message}`);
    }
  }

  /**
   * Reads existing files in the execution directory.
   */
  listExistingFiles() {
    try {
      if (!fs.existsSync(this.executionDirectory)) return new Set();
      return new Set(fs.readdirSync(this.executionDirectory).filter(f => f !== 'manifest.json'));
    } catch {
      return new Set();
    }
  }

  /**
   * Waits for a download to complete after an action trigger and validates the downloaded file.
   * Handles .crdownload, .tmp, empty files, and timeouts.
   *
   * @param {object} options
   * @param {Set<string>} [options.knownFilesBefore] - Snapshot of directory before trigger
   * @param {number} [options.timeoutMs] - Timeout in milliseconds (default: 15000)
   * @param {string} [options.expectedName] - Optional expected filename
   * @returns {Promise<{
   *   success: boolean,
   *   filename: string|null,
   *   filePath: string|null,
   *   size: number,
   *   error: string|null
   * }>}
   */
  async waitForDownloadCompletion(options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const knownFiles = options.knownFilesBefore || new Set();
    const startTime = Date.now();
    const pollInterval = 250;

    let targetFile = null;

    while (Date.now() - startTime < timeoutMs) {
      let currentFiles = [];
      try {
        currentFiles = fs.readdirSync(this.executionDirectory).filter(f => f !== 'manifest.json');
      } catch {
        currentFiles = [];
      }

      // Check for temporary / in-progress browser download files
      const hasTempFiles = currentFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp') || f.endsWith('.download'));

      // Find any newly appeared file that is NOT temporary
      const newCompletedFiles = currentFiles.filter(f =>
        !knownFiles.has(f) &&
        !f.endsWith('.crdownload') &&
        !f.endsWith('.tmp') &&
        !f.endsWith('.download')
      );

      if (newCompletedFiles.length > 0 && !hasTempFiles) {
        // Pick the newest file
        targetFile = newCompletedFiles[newCompletedFiles.length - 1];
        const fullPath = path.join(this.executionDirectory, targetFile);

        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > 0) {
            return {
              success: true,
              filename: targetFile,
              filePath: fullPath,
              size: stats.size,
              error: null
            };
          }
        } catch {}
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    return {
      success: false,
      filename: null,
      filePath: null,
      size: 0,
      error: 'Download timeout: No completed non-temporary file detected within time limit'
    };
  }

  /**
   * Record a validated successful download for an item.
   *
   * @param {string} itemId
   * @param {object} fileInfo - { filename, size, filePath }
   * @param {object} [sourceData] - Item fields
   */
  recordSuccess(itemId, fileInfo = {}, sourceData = {}) {
    this.successCount++;
    const record = {
      itemId: String(itemId),
      filename: fileInfo.filename || 'unknown',
      size: fileInfo.size || 0,
      filePath: fileInfo.filePath || path.join(this.executionDirectory, fileInfo.filename || ''),
      runPath: fileInfo.runPath || null,
      portalDomain: this.portalDomain,
      runTimestamp: this.runTimestamp,
      category: fileInfo.category || null,
      status: 'success',
      downloadedAt: new Date().toISOString(),
      sourceData: sourceData || {}
    };

    this.files.push(record);
    this._saveManifest();

    logger.success(`[DownloadManager] Download verified: "${record.filename}" (${record.size} bytes)`);
    return record;
  }

  /**
   * Record a failed download attempt for an item.
   *
   * @param {string} itemId
   * @param {string} reason
   * @param {object} [sourceData]
   */
  recordFailure(itemId, reason = '', sourceData = {}) {
    this.failureCount++;
    const record = {
      itemId: String(itemId),
      filename: null,
      size: 0,
      status: 'failed',
      error: reason,
      failedAt: new Date().toISOString(),
      sourceData: sourceData || {}
    };

    this.files.push(record);
    this._saveManifest();
    logger.warn(`[DownloadManager] Download failed for item #${itemId}: ${reason}`);
    return record;
  }

  /**
   * Finalize the download session and produce a summary report.
   */
  finalize() {
    this.completedAt = new Date().toISOString();
    this._saveManifest();

    return {
      executionId: this.executionId,
      workflowId: this.workflowId,
      directory: this.executionDirectory,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      successCount: this.successCount,
      failureCount: this.failureCount,
      totalDownloads: this.files.length,
      files: this.files
    };
  }
}

module.exports = DownloadManager;
