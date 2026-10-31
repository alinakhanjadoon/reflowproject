/**
 * ReFlow Cloud Client
 * 
 * Authenticated HTTP communication layer connecting the desktop runner
 * to the ReFlow Next.js Cloud Control Plane (/api/v1/).
 * 
 * Zero external dependencies — uses Node.js global fetch and native primitives.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PKG_VERSION = (() => {
  try {
    return require('../../package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

class CloudClientError extends Error {
  constructor(message, status = 500, data = null, endpoint = '') {
    super(message);
    this.name = 'CloudClientError';
    this.status = status;
    this.data = data;
    this.endpoint = endpoint;
  }
}


class CloudClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - Base URL of ReFlow Cloud API (default: REFLOW_CLOUD_URL or http://localhost:3000)
   * @param {string} [options.token] - Runner Token rf_live_<org_id>_<secret> (default: REFLOW_RUNNER_TOKEN)
   * @param {number} [options.timeoutMs] - Request timeout in ms (default: 15000)
   * @param {Function} [options.fetch] - Custom fetch implementation (default: globalThis.fetch)
   */
  constructor(options = {}) {
    const rawUrl = options.baseUrl || process.env.REFLOW_CLOUD_URL || 'http://localhost:3000';
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    const rawToken = options.token || process.env.REFLOW_RUNNER_TOKEN || '';
    this.token = rawToken.replace(/[\.\s]+$/, '').trim();
    this.timeoutMs = options.timeoutMs || 15000;
    this.fetchFn = options.fetch || (typeof fetch !== 'undefined' ? fetch : globalThis.fetch);

    if (typeof this.fetchFn !== 'function') {
      throw new Error('CloudClient requires a global fetch or options.fetch function');
    }
  }

  /**
   * Set or update runner token
   * @param {string} token 
   */
  setToken(token) {
    this.token = (token || '').replace(/[\.\s]+$/, '').trim();
  }

  /**
   * Build request headers with runner token
   * @returns {Record<string, string>}
   */
  _getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
      headers['x-runner-token'] = this.token;
      try {
        const os = require('os');
        headers['x-runner-hostname'] = os.hostname();
        headers['x-runner-platform'] = `${process.platform} ${process.arch}`;
        headers['x-runner-version'] = `v${PKG_VERSION}`;
        headers['x-runner-cdp'] = 'true';
      } catch {}
    }
    return headers;
  }

  /**
   * Internal HTTP request helper
   * @param {string} endpoint 
   * @param {RequestInit} [options] 
   * @returns {Promise<any>}
   */
  async _request(endpoint, options = {}) {
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.baseUrl}${path}`;
    const headers = {
      ...this._getHeaders(),
      ...(options.headers || {}),
    };

    let controller;
    let timer;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    }

    try {
      const response = await this.fetchFn(url, {
        ...options,
        headers,
        signal: controller ? controller.signal : undefined,
      });

      let responseData = null;
      const contentType = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-type')
        : '';

      if (contentType && contentType.includes('application/json')) {
        try {
          responseData = await response.json();
        } catch {
          responseData = null;
        }
      } else {
        try {
          const text = await response.text();
          try {
            responseData = JSON.parse(text);
          } catch {
            responseData = text ? { message: text } : null;
          }
        } catch {
          responseData = null;
        }
      }

      if (!response.ok) {
        let rawError = responseData?.error || responseData?.message;
        if (typeof rawError === 'object' && rawError !== null) {
          rawError = rawError.message || rawError.error || JSON.stringify(rawError);
        }
        const errorMsg = rawError || `HTTP ${response.status} ${response.statusText}`;
        throw new CloudClientError(
          `Cloud API Error [${response.status}] ${path}: ${errorMsg}`,
          response.status,
          responseData,
          path
        );
      }

      return responseData;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new CloudClientError(`Cloud API Timeout (${this.timeoutMs}ms) requesting ${path}`, 408, null, path);
      }
      if (err instanceof CloudClientError) {
        throw err;
      }
      throw new CloudClientError(`Cloud API Network Failure on ${path}: ${err.message}`, 0, null, path);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Health check / ping endpoint
   * Validates server reachable and token acceptance
   * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string }>}
   */
  async checkHealth() {
    try {
      const res = await this._request('/api/v1/runs?status=pending', { method: 'GET' });
      return { ok: true, status: 200, data: res };
    } catch (err) {
      return {
        ok: false,
        status: err.status || 0,
        error: err.message,
        data: err.data,
      };
    }
  }

  /**
   * Get pending runs assigned to this runner's organization
   * GET /api/v1/runs?status=pending
   * @returns {Promise<Array<any>>} Array of ExecutionRun objects
   */
  async getPendingRuns() {
    const timestamp = Date.now();
    const data = await this._request(`/api/v1/runs?status=pending&_t=${timestamp}`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
    if (data && Array.isArray(data.runs)) {
      return data.runs;
    }
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  }

  /**
   * Atomically claim a pending run (pending -> running)
   * PATCH /api/v1/runs with status='running'
   * @param {string} runId 
   * @returns {Promise<any>} Claimed run object
   */
  async claimRun(runId) {
    if (!runId) throw new Error('claimRun requires runId');
    const data = await this._request('/api/v1/runs', {
      method: 'PATCH',
      body: JSON.stringify({
        run_id: runId,
        status: 'running',
      }),
    });
    return data?.run || data;
  }

  /**
   * Update run execution progress telemetry
   * PATCH /api/v1/runs
   * @param {string} runId 
   * @param {Object} data 
   * @param {number} [data.items_processed] 
   * @param {number} [data.items_downloaded] 
   * @returns {Promise<any>}
   */
  async updateRunProgress(runId, data = {}) {
    if (!runId) throw new Error('updateRunProgress requires runId');
    const payload = {
      run_id: runId,
      ...data,
    };
    const res = await this._request('/api/v1/runs', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return res?.run || res;
  }

  /**
   * Update run status (e.g. requires_action, completed, failed)
   * PATCH /api/v1/runs
   * @param {string} runId 
   * @param {'pending'|'running'|'requires_action'|'completed'|'failed'|'cancelled'} status 
   * @param {Object} [extra] - Additional fields like error_summary, completed_at, items_processed, items_downloaded
   * @returns {Promise<any>}
   */
  async updateRunStatus(runId, status, extra = {}) {
    if (!runId) throw new Error('updateRunStatus requires runId');
    if (!status) throw new Error('updateRunStatus requires status');
    const payload = {
      run_id: runId,
      status,
      ...extra,
    };
    const res = await this._request('/api/v1/runs', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return res?.run || res;
  }

  /**
   * Upload an artifact file to Cloud Storage endpoint
   * POST /api/v1/artifacts/upload (with fallback to POST /api/v1/artifacts)
   *
   * Returns `null` when the cloud cannot confirm storage (404 endpoint missing or network
   * failure). Callers must then record the artifact as local-only instead of inventing a
   * storage path that was never written.
   *
   * @param {string} runId
   * @param {string} filePath
   * @param {Object} [metadata]
   * @returns {Promise<{ cloud_storage_path: string|null, uploaded: boolean, path?: string, artifact?: any }|null>}
   */
  async uploadArtifact(runId, filePath, metadata = {}) {
    if (!runId) throw new Error('uploadArtifact requires runId');
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`uploadArtifact: local file not found at ${filePath}`);
    }

    const fileName = metadata.file_name || path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const fileSize = metadata.file_size_bytes || fileBuffer.length;
    const sha256Hash = metadata.sha256_hash;

    const payload = {
      run_id: runId,
      file_name: fileName,
      file_size_bytes: fileSize,
      sha256_hash: sha256Hash,
      file_data: base64Data,
      storage_path: filePath,
    };

    const resolveCloudPath = (res) => res?.cloud_storage_path || res?.path ||
      res?.artifact?.cloud_storage_path || null;

    let primaryError = null;
    try {
      const res = await this._request('/api/v1/artifacts/upload', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const cloudStoragePath = resolveCloudPath(res);
      return {
        ...res,
        cloud_storage_path: cloudStoragePath,
        uploaded: Boolean(cloudStoragePath),
      };
    } catch (err) {
      primaryError = err;
    }

    // If /api/v1/artifacts/upload is not available, try /api/v1/artifacts, which accepts
    // file_data and performs the upload server-side.
    try {
      const fallbackRes = await this._request('/api/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const artifact = fallbackRes?.artifact || fallbackRes;
      const cloudStoragePath = resolveCloudPath(artifact);
      return {
        cloud_storage_path: cloudStoragePath,
        uploaded: Boolean(cloudStoragePath),
        artifact,
      };
    } catch (fallbackErr) {
      const cloudUnavailable = primaryError?.status === 404 || fallbackErr?.status === 404 ||
        primaryError?.status === 0 || fallbackErr?.status === 0;
      if (cloudUnavailable) {
        return null;
      }
      throw primaryError;
    }
  }

  /**
   * Register a downloaded invoice or artifact in the cloud
   * POST /api/v1/artifacts
   * @param {string} runId 
   * @param {Object} artifact
   * @param {string} artifact.file_name
   * @param {number} [artifact.file_size_bytes]
   * @param {string} artifact.sha256_hash
   * @param {string} [artifact.storage_path]
   * @param {string} [artifact.cloud_storage_path]
   * @param {Object} [artifact.item_metadata]
   * @returns {Promise<any>} Created RunArtifact object
   */
  async registerArtifact(runId, artifact = {}) {
    if (!runId) throw new Error('registerArtifact requires runId');
    if (!artifact.file_name) throw new Error('registerArtifact requires artifact.file_name');
    if (!artifact.sha256_hash) throw new Error('registerArtifact requires artifact.sha256_hash');

    const payload = {
      run_id: runId,
      file_name: artifact.file_name,
      file_size_bytes: artifact.file_size_bytes || 0,
      sha256_hash: artifact.sha256_hash,
      storage_path: artifact.storage_path || null,
      cloud_storage_path: artifact.cloud_storage_path || null,
      item_metadata: artifact.item_metadata || {},
    };

    const res = await this._request('/api/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res?.artifact || res;
  }

  /**
   * Retrieve workflow definition from cloud
   * GET /api/v1/workflows
   * @param {string} [workflowId]
   * @returns {Promise<any>} Workflow object or array of workflows
   */
  async getWorkflow(workflowId) {
    if (!workflowId) {
      const data = await this._request('/api/v1/workflows', { method: 'GET' });
      return data?.workflows || data;
    }

    try {
      // Try querying with ID parameter
      const data = await this._request(`/api/v1/workflows?id=${encodeURIComponent(workflowId)}`, { method: 'GET' });
      if (data?.workflow) return data.workflow;
      if (data?.workflows && Array.isArray(data.workflows)) {
        const found = data.workflows.find(w => w.id === workflowId);
        if (found) return found;
      }
      if (data && data.id === workflowId) return data;
    } catch {
      // Fallback: fetch all and find by ID
      const data = await this._request('/api/v1/workflows', { method: 'GET' });
      const workflows = data?.workflows || (Array.isArray(data) ? data : []);
      const found = workflows.find(w => w.id === workflowId);
      if (found) return found;
      throw new CloudClientError(`Workflow not found: ${workflowId}`, 404, null, '/api/v1/workflows');
    }

    throw new CloudClientError(`Workflow not found: ${workflowId}`, 404, null, '/api/v1/workflows');
  }

  /**
   * Send heartbeat to Cloud API
   * @param {Object} [extra]
   * @returns {Promise<any>}
   */
  async sendHeartbeat(extra = {}) {
    try {
      const os = require('os');
      return await this._request('/api/v1/runners', {
        method: 'POST',
        body: JSON.stringify({
          hostname: os.hostname(),
          platform: `${process.platform} ${process.arch}`,
          version: `v${PKG_VERSION}`,
          cdp_active: extra.cdp_active !== false,
          ...extra,
        }),
      });
    } catch {
      return null;
    }
  }

  /**
   * Diagnostic test connection to Cloud API
   * @returns {Promise<{connected: boolean, url: string, pendingRunsCount?: number, error?: string}>}
   */
  async testConnection() {
    try {
      const res = await this._request('/api/v1/runs?status=pending', { method: 'GET' });
      void this.sendHeartbeat().catch(() => {});
      return {
        connected: true,
        url: this.baseUrl,
        pendingRunsCount: Array.isArray(res?.runs) ? res.runs.length : 0,
      };
    } catch (err) {
      return {
        connected: false,
        url: this.baseUrl,
        error: err.message,
      };
    }
  }
}

// Backward and forward compatibility: support both `require('./cloud-client')` and `require('./cloud-client').CloudClient`
CloudClient.CloudClient = CloudClient;
CloudClient.CloudClientError = CloudClientError;
module.exports = CloudClient;
module.exports.CloudClient = CloudClient;
module.exports.CloudClientError = CloudClientError;
