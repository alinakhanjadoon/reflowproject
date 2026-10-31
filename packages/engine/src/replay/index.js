#!/usr/bin/env node

/**
 * Replay CLI Entry Point
 * 
 * Usage:
 *   npm run replay -- recordings/my-recording.json
 *   npm run replay -- --file recordings/my-recording.json --speed 1.5
 */

const fs = require('fs');
const path = require('path');
const ReplayEngine = require('./replay-engine');
const logger = require('../utils/logger');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    file: null,
    speed: 1.0,
    port: '9222',
    timeout: 5000
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      options.file = args[i + 1];
      i++;
    } else if (args[i] === '--speed' && args[i + 1]) {
      options.speed = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      options.port = args[i + 1];
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      options.timeout = parseInt(args[i + 1], 10);
      i++;
    } else if ((args[i] === '--delay' || args[i] === '--step-delay') && args[i + 1]) {
      options.stepDelay = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith('--') && !options.file) {
      options.file = args[i];
    }
  }

  // If no file argument given, check recordings/ folder for newest file
  if (!options.file) {
    const { getSafeStoragePath } = require('../utils/storage-helper');
    const recordingsDir = getSafeStoragePath('recordings');
    if (fs.existsSync(recordingsDir)) {
      const files = fs.readdirSync(recordingsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(recordingsDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      if (files.length > 0) {
        options.file = path.join('recordings', files[0].name);
        logger.info(`No file specified. Using most recent recording: ${options.file}`);
      }
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (!options.file) {
    logger.error('No recording file specified and no recordings found in recordings/ directory.');
    console.log('\nUsage: npm run replay -- <path-to-recording.json> [--delay <ms>]\n');
    process.exit(1);
  }

  const engine = new ReplayEngine({
    browserURL: `http://localhost:${options.port}`,
    speed: options.speed,
    timeoutMs: options.timeout,
    stepDelayMs: options.stepDelay || 0
  });

  try {
    await engine.replay(options.file);
    process.exit(0);
  } catch (err) {
    logger.error('Replay failed:', err);
    process.exit(1);
  }
}

main();