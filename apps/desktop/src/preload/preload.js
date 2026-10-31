const { contextBridge, ipcRenderer } = require('electron');

const reflowBridge = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  startRunner: () => ipcRenderer.invoke('start-runner'),
  stopRunner: () => ipcRenderer.invoke('stop-runner'),
  stopActiveRun: () => ipcRenderer.invoke('stop-active-run'),
  testConnection: (customConfig) => ipcRenderer.invoke('test-connection', customConfig),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  checkCdpStatus: () => ipcRenderer.invoke('check-cdp-status'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, data) => callback(data));
  },
  startRecording: (options) => ipcRenderer.invoke('start-recording', options),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  getRecordingStatus: () => ipcRenderer.invoke('get-recording-status'),
  onRecordingUpdate: (callback) => {
    ipcRenderer.on('recorder-update', (event, data) => callback(data));
  },
  onDeeplinkRecord: (callback) => {
    ipcRenderer.on('deeplink-record', (event, data) => callback(data));
  },
  onRecordingStarted: (callback) => {
    ipcRenderer.on('recording-started', (event, data) => callback(data));
  },
};

// Expose canonical ReFlow API
contextBridge.exposeInMainWorld('reflow', reflowBridge);
