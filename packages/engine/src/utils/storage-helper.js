/**
 * src/utils/storage-helper.js
 * Centralized safe filesystem path resolver and directory initializer.
 * Prevents writing to root filesystem ('/' or '\') in packaged Electron environments,
 * which triggers OS security warnings (macOS App Management) and ENOENT errors.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

function isUnsafeCwd(cwd) {
  if (!cwd) return true;
  if (cwd === '/' || cwd === '\\') return true;
  if (/^[A-Za-z]:[\\\/]?$/.test(cwd)) return true;
  if (cwd.includes('Contents/MacOS') || cwd.includes('Contents/Frameworks')) return true;
  return false;
}

function getSafeStorageBase(sub = 'downloads') {
  try {
    const cwd = process.cwd();
    if (!isUnsafeCwd(cwd)) {
      return path.resolve(cwd, sub);
    }
  } catch {}
  return path.join(os.homedir(), 'Downloads', 'ReFlow', sub);
}

function getSafeStoragePath(...subparts) {
  try {
    const cwd = process.cwd();
    if (!isUnsafeCwd(cwd)) {
      return path.resolve(cwd, ...subparts);
    }
  } catch {}
  return path.join(os.homedir(), 'Downloads', 'ReFlow', ...subparts);
}

function safeMkdir(dirPath) {
  if (!dirPath) return null;
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
  } catch (err) {
    try {
      const fallbackDir = path.join(os.tmpdir(), 'ReFlow', path.basename(dirPath));
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      return fallbackDir;
    } catch {}
    return dirPath;
  }
}

module.exports = {
  getSafeStorageBase,
  getSafeStoragePath,
  safeMkdir,
  isUnsafeCwd,
};
