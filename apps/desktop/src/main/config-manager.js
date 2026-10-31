const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveDefaultDownloadFolder() {
  return path.join(os.homedir(), 'Downloads', 'ReFlow');
}

class ConfigManager {
  constructor() {
    this.configDir = path.join(os.homedir(), '.reflow');
    this.configFile = path.join(this.configDir, 'config.json');
    this.defaultTargetFolder = resolveDefaultDownloadFolder();
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      try {
        fs.mkdirSync(this.configDir, { recursive: true });
      } catch (err) {
        console.error('Failed to create .reflow directory:', err);
      }
    }
  }

  getDefaults() {
    return {
      runnerToken: '',
      cloudUrl: 'https://reflowproject-web.vercel.app',
      browserMode: 'visible', // 'visible' | 'headless'
      targetFolder: this.defaultTargetFolder,
      autoStartRunner: true,
      minimizeToTray: true,
      lastConnected: null,
      organizationName: null,
    };
  }

  get() {
    this._ensureDir();
    if (!fs.existsSync(this.configFile)) {
      const defaults = this.getDefaults();
      try {
        fs.writeFileSync(this.configFile, JSON.stringify(defaults, null, 2), 'utf8');
      } catch (err) {
        console.warn('Could not write default config:', err);
      }
      return defaults;
    }

    try {
      const raw = fs.readFileSync(this.configFile, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return { ...this.getDefaults(), ...parsed };
    } catch (err) {
      console.warn('Failed to parse config file, returning defaults:', err);
      return this.getDefaults();
    }
  }

  save(newConfig) {
    this._ensureDir();
    try {
      let current = this.getDefaults();
      if (fs.existsSync(this.configFile)) {
        try {
          const raw = fs.readFileSync(this.configFile, 'utf8');
          current = { ...current, ...JSON.parse(raw) };
        } catch {}
      }
      const updated = { ...current, ...newConfig };
      fs.writeFileSync(this.configFile, JSON.stringify(updated, null, 2), 'utf8');
      return updated;
    } catch (err) {
      console.error('Failed to save config:', err);
      throw err;
    }
  }
}

module.exports = new ConfigManager();
