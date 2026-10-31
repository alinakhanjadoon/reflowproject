/**
 * URL Resolution and Normalization Utility
 */

const fs = require('fs');
const path = require('path');

/**
 * Checks if a given URL is an internal browser URL (not a navigable web/file page)
 * @param {string} url
 * @returns {boolean}
 */
function isInternalBrowserUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed === 'about:blank' ||
    trimmed === 'about:newtab' ||
    trimmed.startsWith('chrome://') ||
    trimmed.startsWith('chrome-search://') ||
    trimmed.startsWith('chrome-extension://') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('edge://') ||
    trimmed.startsWith('brave://') ||
    trimmed.startsWith('devtools://')
  );
}

/**
 * Checks if a given URL belongs to the ReFlow dashboard itself
 * @param {string} url
 * @returns {boolean}
 */
function isDashboardUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port;
    if ((host === '127.0.0.1' || host === 'localhost') && (port === '3000' || !port)) {
      const pathname = parsed.pathname;
      if (['/app', '/dashboard', '/workflows', '/console', '/login', '/landing', '/api', '/secrets', '/artifacts'].some(p => pathname.startsWith(p)) || pathname === '/' || pathname === '/index.html') {
        return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Resolves a workflow target URL to a valid navigable browser URL
 * @param {string} targetUrl - Raw target URL or file path from workflow metadata
 * @returns {string|null} Resolved navigable URL
 */
function resolveTargetUrl(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;
  targetUrl = targetUrl.trim();
  if (!targetUrl || isInternalBrowserUrl(targetUrl)) return null;

  // Handle local mock test files with file: protocol
  if (targetUrl.startsWith('file:')) {
    try {
      const parsed = new URL(targetUrl);
      const baseName = path.basename(parsed.pathname);
      const localFixturePath = path.resolve(process.cwd(), 'test', 'fixtures', baseName);
      if (fs.existsSync(localFixturePath)) {
        return `file:///${localFixturePath.replace(/\\/g, '/')}`;
      }
      const localTestPath = path.resolve(process.cwd(), 'test', baseName);
      if (fs.existsSync(localTestPath)) {
        return `file:///${localTestPath.replace(/\\/g, '/')}`;
      }
    } catch {
      const baseName = path.basename(targetUrl.replace(/^file:\/\/\/?/, ''));
      const localFixturePath = path.resolve(process.cwd(), 'test', 'fixtures', baseName);
      if (fs.existsSync(localFixturePath)) {
        return `file:///${localFixturePath.replace(/\\/g, '/')}`;
      }
      const localTestPath = path.resolve(process.cwd(), 'test', baseName);
      if (fs.existsSync(localTestPath)) {
        return `file:///${localTestPath.replace(/\\/g, '/')}`;
      }
    }
    return targetUrl;
  }

  // Handle local HTML filenames or relative test paths (e.g. test/ecommerce-portal.html)
  if (targetUrl.endsWith('.html') && !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    const directPath = path.resolve(process.cwd(), targetUrl);
    if (fs.existsSync(directPath)) {
      return `file:///${directPath.replace(/\\/g, '/')}`;
    }
    const fixturePath = path.resolve(process.cwd(), 'test', 'fixtures', path.basename(targetUrl));
    if (fs.existsSync(fixturePath)) {
      return `file:///${fixturePath.replace(/\\/g, '/')}`;
    }
    const testPath = path.resolve(process.cwd(), 'test', path.basename(targetUrl));
    if (fs.existsSync(testPath)) {
      return `file:///${testPath.replace(/\\/g, '/')}`;
    }
  }

  // Handle bare domain without protocol (e.g. google.com or news.ycombinator.com)
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('file://')) {
    if (targetUrl.includes('.') && !targetUrl.includes(' ')) {
      return `https://${targetUrl}`;
    }
  }

  return targetUrl;
}

/**
 * Robustly extracts the best starting URL from a workflow, recording, or action list
 * @param {Object} workflow
 * @returns {string|null}
 */
function extractWorkflowStartUrl(workflow) {
  if (!workflow) return null;

  // 1. Check actions and steps first for any real non-placeholder URL
  const actions = workflow.actions ||
    workflow.steps ||
    workflow.recordingData?.actions ||
    workflow.workflow_definition?.steps ||
    workflow.workflow_definition?.actions ||
    [];

  for (const act of actions) {
    if (!act) continue;
    const actionUrl = act.url || act.pageUrl || act.frame?.location;
    if (actionUrl && typeof actionUrl === 'string' && !isInternalBrowserUrl(actionUrl) && !actionUrl.includes('example.com')) {
      const resolved = resolveTargetUrl(actionUrl);
      if (resolved) return resolved;
    }
  }

  // 2. Check direct candidates for real non-placeholder URLs
  const directCandidates = [
    workflow.portal_url,
    workflow.targetUrl,
    workflow.startUrl,
    workflow.recordingData?.metadata?.startUrl,
    workflow.metadata?.startUrl,
    workflow.workflow_definition?.portal_url,
    workflow.workflow_definition?.start_url,
    workflow.workflow_definition?.metadata?.startUrl
  ];

  for (const candidate of directCandidates) {
    if (candidate && typeof candidate === 'string' && !isInternalBrowserUrl(candidate) && !candidate.includes('example.com')) {
      const resolved = resolveTargetUrl(candidate);
      if (resolved) return resolved;
    }
  }

  // 3. Fallback to any valid candidate (including placeholder if nothing else exists)
  for (const candidate of directCandidates) {
    if (candidate && typeof candidate === 'string' && !isInternalBrowserUrl(candidate)) {
      const resolved = resolveTargetUrl(candidate);
      if (resolved) return resolved;
    }
  }

  // 4. Fall back to scanning actions/steps for any valid URL or href attribute
  for (const act of actions) {
    if (!act) continue;
    const actionUrl = act.url || act.pageUrl || act.frame?.location;
    if (actionUrl && typeof actionUrl === 'string' && !isInternalBrowserUrl(actionUrl)) {
      const resolved = resolveTargetUrl(actionUrl);
      if (resolved) return resolved;
    }
    const href = act.target?.fingerprint?.attributes?.href;
    if (href && typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://'))) {
      const resolved = resolveTargetUrl(href);
      if (resolved) return resolved;
    }
  }

  return null;
}

module.exports = {
  isInternalBrowserUrl,
  isDashboardUrl,
  resolveTargetUrl,
  extractWorkflowStartUrl
};
