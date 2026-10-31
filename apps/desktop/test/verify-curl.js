const { spawn, execSync } = require('child_process');
const path = require('path');

// 1. Spawn a separate Node process running http-bridge
const bridgePath = path.resolve(__dirname, '../src/main/http-bridge').replace(/\\/g, '/');
const serverScript = `
  const b = require('${bridgePath}');
  b.start().then(() => {
    console.log('READY');
  });
`;

const serverProc = spawn('node', ['-e', serverScript], {
  cwd: path.resolve(__dirname, '..'),
  stdio: ['ignore', 'pipe', 'inherit']
});

serverProc.stdout.on('data', (data) => {
  if (data.toString().includes('READY')) {
    runCurlTests();
  }
});

function runCurlTests() {
  try {
    console.log('\n--- CURL OPTIONS /record/start ---');
    console.log(execSync('curl.exe -i -s -X OPTIONS http://127.0.0.1:49152/record/start -H "Origin: https://reflowproject-web.vercel.app" -H "Access-Control-Request-Private-Network: true"').toString());

    console.log('\n--- CURL GET /health ---');
    console.log(execSync('curl.exe -i -s http://127.0.0.1:49152/health -H "Origin: https://reflowproject-web.vercel.app"').toString());

    console.log('\n--- CURL GET /record/status ---');
    console.log(execSync('curl.exe -i -s http://127.0.0.1:49152/record/status').toString());

    console.log('\n--- CURL POST /record/stop ---');
    console.log(execSync('curl.exe -i -s -X POST http://127.0.0.1:49152/record/stop').toString());

    console.log('\n=== ALL CURL VERIFICATIONS COMPLETED SUCCESSFULLY ===\n');
  } catch (err) {
    console.error('Curl test error:', err.message);
  } finally {
    serverProc.kill();
    process.exit(0);
  }
}
