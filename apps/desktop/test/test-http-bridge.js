/**
 * Test Suite for Desktop Localhost HTTP Bridge (apps/desktop/src/main/http-bridge.js)
 * 
 * Verifies:
 * - Server lifecycle on 127.0.0.1:49152
 * - W3C Private Network Access (PNA) and permissive CORS preflight
 * - Health check endpoint GET /health and /api/health
 * - Recording status endpoint GET /record/status and /api/record/status
 * - Stop endpoint POST /record/stop
 * - 404 routing
 * - Re-entrancy protection
 * - Simulated recording completion and recipe extraction
 * - Clean server shutdown
 */

'use strict';

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Standard module resolution relative to workspace root
const candidatePaths = [
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../../../node_modules')
];
for (const p of candidatePaths) {
  try {
    if (require('fs').existsSync(p)) {
      if (!process.env.NODE_PATH || !process.env.NODE_PATH.includes(p)) {
        process.env.NODE_PATH = [p, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
      }
    }
  } catch {}
}
require('module').Module._initPaths();

const httpBridge = require('../src/main/http-bridge');
const runnerController = require('../src/main/runner-controller');
const chromeSpawner = require('../src/main/chrome-spawner');

function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 49152,
        ...options,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(resBody);
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: resBody,
            json,
          });
        });
      }
    );

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('>>> Running Test Suite for Desktop Localhost HTTP Bridge <<<\n');
  let passed = 0;
  let failed = 0;

  function test(desc, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`  ✓ ${desc}`);
        passed++;
      })
      .catch((err) => {
        console.error(`  ✕ ${desc}`);
        console.error(`    ${err.message}`);
        failed++;
      });
  }

  // 1. Initial State
  await test('Initial bridge state is valid and idle', () => {
    const status = httpBridge.getStatus();
    assert.strictEqual(status.status, 'ok');
    assert.strictEqual(status.isRecording, false);
    assert.strictEqual(status.actionCount, 0);
    assert.strictEqual(status.port, 49152);
  });

  // 2. Server Start
  await test('Server starts successfully on 127.0.0.1:49152', async () => {
    await httpBridge.start();
    assert.ok(httpBridge.server);
    assert.ok(httpBridge.server.listening);
  });

  // 3. Double start idempotency
  await test('Calling start() again while running is safe and idempotent', async () => {
    await httpBridge.start();
    assert.ok(httpBridge.server.listening);
  });

  // 4. CORS Preflight with Private Network Access from Vercel
  await test('OPTIONS preflight from https://reflowproject-web.vercel.app returns 204 with PNA headers', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/record/start',
      headers: {
        Origin: 'https://reflowproject-web.vercel.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://reflowproject-web.vercel.app');
    assert.strictEqual(res.headers['access-control-allow-private-network'], 'true');
    assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
    assert.ok(res.headers['access-control-allow-methods'].includes('POST'));
    assert.ok(res.headers['access-control-allow-methods'].includes('OPTIONS'));
  });

  // 5. CORS Preflight from localhost:3000
  await test('OPTIONS preflight from http://localhost:3000 returns 204 with PNA headers', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/health',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.strictEqual(res.headers['access-control-allow-private-network'], 'true');
  });

  // 5b. OPTIONS preflight from untrusted arbitrary Vercel domain
  await test('OPTIONS preflight from untrusted arbitrary Vercel domain does not allow the origin', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/health',
      headers: {
        Origin: 'https://arbitrary-attacker.vercel.app',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.notStrictEqual(res.headers['access-control-allow-origin'], 'https://arbitrary-attacker.vercel.app');
  });

  // 5c. OPTIONS preflight from an untrusted reflow.io subdomain
  await test('OPTIONS preflight from an untrusted reflow.io subdomain is not allowed', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/health',
      headers: {
        Origin: 'https://attacker.reflow.io',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.notStrictEqual(res.headers['access-control-allow-origin'], 'https://attacker.reflow.io');
  });

  // 5d. OPTIONS preflight from localhost on a non-app port
  await test('OPTIONS preflight from localhost on a non-app port is not allowed', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/health',
      headers: {
        Origin: 'http://localhost:8080',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.notStrictEqual(res.headers['access-control-allow-origin'], 'http://localhost:8080');
  });

  // 5e. OPTIONS preflight from the bridge's own origin
  await test('OPTIONS preflight from the bridge origin on 127.0.0.1:49152 is allowed', async () => {
    const res = await makeRequest({
      method: 'OPTIONS',
      path: '/health',
      headers: {
        Origin: 'http://127.0.0.1:49152',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://127.0.0.1:49152');
  });

  // 6. GET /health
  await test('GET /health returns 200 with status ok and CORS headers', async () => {
    const res = await makeRequest({
      method: 'GET',
      path: '/health',
      headers: {
        Origin: 'https://reflowproject-web.vercel.app',
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['access-control-allow-private-network'], 'true');
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://reflowproject-web.vercel.app');
    assert.deepStrictEqual(res.json, {
      status: 'ok',
      isRecording: false,
      actionCount: 0,
      completedRecording: false,
      port: 49152,
    });
  });

  // 7. GET /api/health alias
  await test('GET /api/health alias returns 200 with matching payload', async () => {
    const res = await makeRequest({
      method: 'GET',
      path: '/api/health',
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.strictEqual(res.json.port, 49152);
  });

  // 8. GET /record/status
  await test('GET /record/status returns 200 with recording state and actions array', async () => {
    const res = await makeRequest({
      method: 'GET',
      path: '/record/status',
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.strictEqual(res.json.isRecording, false);
    assert.strictEqual(res.json.actionCount, 0);
    assert.ok(Array.isArray(res.json.actions));
  });

  // 9. POST /record/stop when idle
  await test('POST /record/stop when idle returns gracefully with completedRecording: true', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/record/stop',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.success, true);
    assert.strictEqual(res.json.isRecording, false);
    assert.strictEqual(res.json.completedRecording, true);
    assert.ok(Array.isArray(res.json.actions));
  });

  // 9b. Oversized request body is rejected with 413
  await test('POST /record/start rejects a body over 1 MB with 413', async () => {
    const oversizedBody = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1024) });
    const res = await makeRequest({
      method: 'POST',
      path: '/record/start',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(oversizedBody),
      },
    }, oversizedBody);

    assert.strictEqual(res.statusCode, 413);
    assert.ok(res.json.error.includes('byte limit'));
  });

  // 10. 404 Route handling
  await test('GET /unknown-endpoint returns 404 JSON', async () => {
    const res = await makeRequest({
      method: 'GET',
      path: '/unknown-endpoint',
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json.error, 'Not Found');
    assert.strictEqual(res.json.path, '/unknown-endpoint');
  });

  // 10b. Verification that dead /record/reset is 404
  await test('POST /record/reset returns 404 (removed dead endpoint)', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/record/reset',
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json.error, 'Not Found');
  });

  // 11. Status Change Listener
  await test('onStatusChange fires callback on state transitions', () => {
    let fired = false;
    let receivedState = null;
    httpBridge.onStatusChange((s) => {
      fired = true;
      receivedState = s;
    });

    httpBridge.notifyStatus();
    assert.strictEqual(fired, true);
    assert.ok(receivedState);
    assert.strictEqual(receivedState.status, 'ok');
  });

  // 12. Re-entrancy protection
  await test('POST /record/start returns 400 if recording session is already active', async () => {
    // Manually mark isRecording = true to test guard
    httpBridge.isRecording = true;
    try {
      const res = await makeRequest(
        {
          method: 'POST',
          path: '/record/start',
          headers: { 'Content-Type': 'application/json' },
        },
        { name: 'duplicate-test', url: 'https://example.com' }
      );

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.json.error.includes('already active'));
    } finally {
      httpBridge.isRecording = false;
    }
  });

  // 13. Simulated Chrome finish and recipe compilation
  await test('Simulated Chrome finish flushes session, compiles recipe, and updates status', async () => {
    const mockActions = [
      { type: 'navigate', url: 'https://vendor.portal.com/login', timestamp: 1000 },
      { type: 'click', selector: '#login-btn', timestamp: 2000 },
      { type: 'click', selector: 'a[href="/invoices"]', timestamp: 3000 },
    ];

    // Mock active recorder
    httpBridge.activeRecorder = {
      name: 'invoice-download-flow',
      startUrl: 'https://vendor.portal.com/login',
      actions: mockActions,
      stop: async () => null,
    };
    httpBridge.sessionMeta = {
      name: 'invoice-download-flow',
      url: 'https://vendor.portal.com/login',
      startedAt: new Date(Date.now() - 5000).toISOString(),
    };
    httpBridge.isRecording = true;
    httpBridge.completedRecording = false;

    // Trigger Chrome save
    await httpBridge._handleChromeSave();

    assert.strictEqual(httpBridge.isRecording, false);
    assert.strictEqual(httpBridge.completedRecording, true);
    assert.strictEqual(httpBridge.actions.length, 3);
    assert.ok(httpBridge.lastRecipe);
    assert.strictEqual(httpBridge.lastRecipe.metadata.name, 'invoice-download-flow');
    assert.strictEqual(httpBridge.lastRecipe.actions.length, 3);

    // Verify GET /record/status returns the finished recipe and actions
    const res = await makeRequest({ method: 'GET', path: '/record/status' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.completedRecording, true);
    assert.strictEqual(res.json.actionCount, 3);
    assert.strictEqual(res.json.recipe.metadata.name, 'invoice-download-flow');
  });

  // 14. Server Shutdown
  await test('Server closes cleanly and releases port', async () => {
    await httpBridge.stop();
    assert.strictEqual(httpBridge.server, null);
  });

  // 15. Listen failure cleanup (EADDRINUSE must not leave a dead server object)
  await test('start() surfaces EADDRINUSE and clears the dead server object', async () => {
    const blocker = http.createServer((req, res) => res.end('blocked'));
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(49152, '127.0.0.1', resolve);
    });

    try {
      await assert.rejects(() => httpBridge.start(), /EADDRINUSE/);
      assert.strictEqual(httpBridge.server, null);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    await httpBridge.start();
    assert.ok(httpBridge.server.listening);
    await httpBridge.stop();
    assert.strictEqual(httpBridge.server, null);
  });

  // 16. Runner result status mapping
  await test('Runner results are mapped to completed, failed, and cancelled honestly', () => {
    const run = { id: 'run-1', workflow_id: 'wf-1' };

    const completed = runnerController._summarizeRunResult(run, {
      success: true,
      itemsDownloaded: 4,
    });
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.itemsDownloaded, 4);

    const cancelled = runnerController._summarizeRunResult(run, {
      success: false,
      status: 'cancelled',
    });
    assert.strictEqual(cancelled.status, 'cancelled');

    const failed = runnerController._summarizeRunResult(run, {
      success: false,
      itemsDownloaded: 2,
    });
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.itemsDownloaded, 2);
    assert.ok(failed.error);
  });

  // 17. recentRuns is bounded
  await test('recentRuns never grows beyond 20 entries', () => {
    const originalRuns = runnerController.recentRuns;
    runnerController.recentRuns = [];
    try {
      for (let i = 0; i < 30; i++) {
        runnerController._addRecentRun({ id: `run-${i}`, status: 'completed' });
      }
      assert.strictEqual(runnerController.recentRuns.length, 20);
      assert.strictEqual(runnerController.recentRuns[0].id, 'run-29');
    } finally {
      runnerController.recentRuns = originalRuns;
    }
  });

  // 18. Chrome ownership marker gates adoption
  await test('Chrome ownership marker only adopts a live ReFlow browser', () => {
    const originalProfileDir = chromeSpawner.profileDir;
    const originalPort = chromeSpawner.port;
    const tempProfile = path.join(os.tmpdir(), `reflow-marker-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempProfile, { recursive: true });
    chromeSpawner.profileDir = tempProfile;
    chromeSpawner.port = 49333;

    try {
      chromeSpawner._clearOwnershipMarker();
      assert.strictEqual(chromeSpawner._isOwnedBrowser(), false);

      chromeSpawner._writeOwnershipMarker(process.pid, 'visible');
      assert.strictEqual(chromeSpawner._isOwnedBrowser(), true);

      chromeSpawner._writeOwnershipMarker(999999, 'visible');
      assert.strictEqual(chromeSpawner._isOwnedBrowser(), false);
    } finally {
      chromeSpawner._clearOwnershipMarker();
      chromeSpawner.profileDir = originalProfileDir;
      chromeSpawner.port = originalPort;
      fs.rmSync(tempProfile, { recursive: true, force: true });
    }
  });

  console.log(`\n========================================`);
  console.log(`Tests Passed: ${passed}`);
  console.log(`Tests Failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
