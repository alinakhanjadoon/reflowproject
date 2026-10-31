const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const configManager = require('./config-manager');
const runnerController = require('./runner-controller');
const chromeSpawner = require('./chrome-spawner');
const notifier = require('./notifier');
const httpBridge = require('./http-bridge');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownTrayBalloon = false;

function restoreMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function minimizeToTray() {
  if (!mainWindow) return;
  mainWindow.hide();

  // Show a clear balloon notification on Windows when minimized to tray
  if (!hasShownTrayBalloon) {
    hasShownTrayBalloon = true;
    if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
      try {
        const balloonIcon = path.join(__dirname, '../../assets/icon.png');
        tray.displayBalloon({
          title: 'ReFlow Local Worker',
          content: 'ReFlow is running in the background. Click this tray icon anytime to restore the control window.',
          icon: fs.existsSync(balloonIcon) ? balloonIcon : undefined,
          iconType: 'info',
        });
      } catch (err) {
        console.warn('[Main] Tray balloon notice:', err.message);
      }
    } else {
      notifier.notifyMinimizedToTray();
    }
  }
}

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    restoreMainWindow();
    // Parse protocol url on Windows if passed via command line
    const urlArg = (commandLine || []).find((arg) => arg.startsWith('reflow://'));
    if (urlArg) {
      console.log('[Main] Received protocol URL from second-instance:', urlArg);
    }
  });
}

// Register custom protocol client for deep linking (reflow://)
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('reflow', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('reflow');
  }
} catch (err) {
  console.warn('[Main] Protocol client registration warning:', err.message);
}

// macOS open-url event for protocol activation
app.on('open-url', (event, url) => {
  event.preventDefault();
  restoreMainWindow();
  console.log('[Main] Received protocol URL on macOS:', url);
});

function createWindow() {
  const appIconPath = path.join(__dirname, '../../assets/icon.png');

  mainWindow = new BrowserWindow({
    width: 440,
    height: 640,
    resizable: false,
    maximizable: false,
    frame: false,
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    backgroundColor: '#020617', // slate-950
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('close', (event) => {
    const config = configManager.get();
    if (!isQuitting && config.minimizeToTray !== false) {
      event.preventDefault();
      minimizeToTray();
    }
  });

  runnerController.onStatusChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status-update', state);
    }
    updateTrayMenu();
  });

  notifier.setFocusCallback((type) => {
    restoreMainWindow();
  });
}

function setupApplicationMenu() {
  if (process.platform === 'darwin') {
    const appName = app.name || 'ReFlow Worker';
    const template = [
      {
        label: appName,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
}

function createTray() {
  const trayIconPath = path.join(__dirname, '../../assets/tray-icon.png');
  let icon;
  if (fs.existsSync(trayIconPath)) {
    icon = nativeImage.createFromPath(trayIconPath);
  } else {
    icon = nativeImage.createEmpty();
  }

  if (process.platform === 'darwin' && typeof icon.setTemplateImage === 'function') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip('ReFlow Local Worker');

  // Single click toggles or restores the window
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      restoreMainWindow();
    }
  });

  // Double click restores and focuses
  tray.on('double-click', () => {
    restoreMainWindow();
  });

  // Clicking balloon notification restores the window
  if (process.platform === 'win32') {
    tray.on('balloon-click', () => {
      restoreMainWindow();
    });
  }

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const state = runnerController.getState();
  const isRunning = state.status === 'active';
  const statusLabel = isRunning ? 'Active (Processing)' : 'Idle (Ready)';

  tray.setToolTip(`ReFlow Local Worker - ${statusLabel}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `ReFlow Local Worker (${statusLabel})`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => {
        restoreMainWindow();
      },
    },
    {
      label: isRunning ? 'Stop Local Worker' : 'Start Local Worker',
      click: async () => {
        try {
          if (isRunning) {
            await runnerController.stop();
          } else {
            await runnerController.start();
          }
        } catch (err) {
          console.error('Tray toggle error:', err);
        }
      },
    },
    {
      label: 'Open Cloud Console (Web)',
      click: () => {
        const config = configManager.get();
        shell.openExternal(`${config.cloudUrl || 'https://reflowproject-web.vercel.app'}/dashboard`);
      },
    },
    {
      label: 'Open Downloads Folder',
      click: () => {
        const config = configManager.get();
        shell.openPath(config.targetFolder);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit ReFlow Worker',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// App lifecycle
app.whenReady().then(async () => {
  setupApplicationMenu();
  createWindow();
  createTray();

  try {
    await httpBridge.start();
  } catch (err) {
    console.error('[Main] Failed to start HTTP bridge on port 49152:', err.message);
  }

  httpBridge.onStatusChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recorder-update', state);
    }
  });

  // Auto-start runner if token is configured
  const initialConfig = configManager.get();
  if (initialConfig.runnerToken && initialConfig.autoStartRunner !== false) {
    runnerController.start().catch((err) => {
      console.warn('[Main] Auto-start runner notice:', err.message);
    });
  }

  // Handle IPC calls
  ipcMain.handle('get-config', () => configManager.get());
  ipcMain.handle('get-system-info', () => ({
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
  }));
  ipcMain.handle('save-config', async (event, config) => {
    const previous = configManager.get();
    const updated = configManager.save(config);

    // If browser mode changed and Chrome is running (and no run is active), update Chrome immediately
    if (config.browserMode && config.browserMode !== previous.browserMode) {
      const activeState = runnerController.getState();
      if (!activeState.activeRun) {
        try {
          const portStatus = await chromeSpawner.isPortOpen();
          if (portStatus.open) {
            console.log(`[Main] Browser mode switched from ${previous.browserMode} to ${config.browserMode}. Updating Chrome...`);
            await chromeSpawner.closeChrome();
            if (config.browserMode === 'visible') {
              await chromeSpawner.ensureChrome('visible');
            }
          }
        } catch (err) {
          console.warn('[Main] Browser mode switch on save error:', err.message);
        }
      }
    }

    if (updated.runnerToken && updated.autoStartRunner !== false && runnerController.getState().status === 'idle') {
      runnerController.start().catch((err) => {
        console.warn('[Main] Runner auto-start on save error:', err.message);
      });
    }
    return updated;
  });
  ipcMain.handle('get-status', () => runnerController.getState());
  ipcMain.handle('start-runner', () => runnerController.start());
  ipcMain.handle('stop-runner', () => runnerController.stop());
  ipcMain.handle('stop-active-run', () => runnerController.stopActiveRun());

  // Workflow Recording IPC handlers
  ipcMain.handle('start-recording', (event, options) => httpBridge.startRecording(options));
  ipcMain.handle('stop-recording', () => httpBridge.stopRecording());
  ipcMain.handle('get-recording-status', () => httpBridge.getStatus());

  ipcMain.handle('test-connection', async (event, customConfig) => {
    try {
      const current = configManager.get();
      const cfg = { ...current, ...(customConfig || {}) };
      const engineResolver = require('./engine-resolver');
      const CloudClientModule = engineResolver.requireEngine('src/runner/cloud-client');
      const CloudClient = CloudClientModule.CloudClient || CloudClientModule;
      const client = new CloudClient({
        baseUrl: cfg.cloudUrl || 'https://reflowproject-web.vercel.app',
        token: cfg.runnerToken,
      });
      return await client.testConnection();
    } catch (err) {
      console.error('[Main] test-connection error:', err);
      return {
        connected: false,
        error: err.message || 'Unknown connection error',
      };
    }
  });

  ipcMain.handle('open-external', (event, url) => shell.openExternal(url));
  ipcMain.handle('open-folder', (event, folderPath) => {
    const target = folderPath || configManager.get().targetFolder;
    shell.openPath(target);
  });
  ipcMain.handle('select-folder', async () => {
    if (!mainWindow) return null;
    const current = configManager.get();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Invoices Download Directory',
      defaultPath: current.targetFolder,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });
  ipcMain.handle('check-cdp-status', async () => {
    return await chromeSpawner.isPortOpen();
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-close', () => {
    const config = configManager.get();
    if (config.minimizeToTray !== false) {
      minimizeToTray();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      restoreMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    try { tray.destroy(); } catch {}
  }
  httpBridge.stop().catch(() => {});
  runnerController.stop().catch(() => {});
  chromeSpawner.stopSpawned();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    const config = configManager.get();
    if (config.minimizeToTray === false) {
      app.quit();
    }
  }
});
