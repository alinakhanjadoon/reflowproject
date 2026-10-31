const clientBridge = window.reflow;
document.addEventListener('DOMContentLoaded', async () => {
  // -------------------------------------------------------------
  // SVG ICONS CONSTANTS
  // -------------------------------------------------------------
  const SVG_ICONS = {
    eye: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    zap: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    pause: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    check: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    fail: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    stop: `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>`,
  };

  // -------------------------------------------------------------
  // DOM ELEMENTS
  // -------------------------------------------------------------
  // Views
  const viewSetup = document.getElementById('viewSetup');
  const viewDashboard = document.getElementById('viewDashboard');

  // Titlebar
  const deviceBadge = document.getElementById('deviceBadge');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnMinimize = document.getElementById('btnMinimize');
  const btnClose = document.getElementById('btnClose');

  // Setup Screen
  const setupForm = document.getElementById('setupForm');
  const inputSetupToken = document.getElementById('inputSetupToken');
  const inputSetupCloudUrl = document.getElementById('inputSetupCloudUrl');
  const btnToggleTokenMask = document.getElementById('btnToggleTokenMask');
  const btnConnectWorkspace = document.getElementById('btnConnectWorkspace');
  const setupFeedback = document.getElementById('setupFeedback');
  const btnGetTokenHelp = document.getElementById('btnGetTokenHelp');

  // Dashboard Screen
  const displayOrgName = document.getElementById('displayOrgName');
  const connectionPill = document.getElementById('connectionPill');
  const runnerPulseDot = document.getElementById('runnerPulseDot');
  const runnerStatusHeading = document.getElementById('runnerStatusHeading');
  const runnerStatusDetail = document.getElementById('runnerStatusDetail');
  const btnToggleRunner = document.getElementById('btnToggleRunner');
  const btnToggleIcon = document.getElementById('btnToggleIcon');
  const btnToggleRunnerText = document.getElementById('btnToggleRunnerText');
  const cloudStatusLabel = document.getElementById('cloudStatusLabel');
  const browserDot = document.getElementById('browserDot');
  const browserStatusLabel = document.getElementById('browserStatusLabel');

  // Active Task Banner
  const activeRunBanner = document.getElementById('activeRunBanner');
  const activeTaskTitle = document.getElementById('activeTaskTitle');
  const activeTaskMeta = document.getElementById('activeTaskMeta');
  const btnStopActiveTask = document.getElementById('btnStopActiveTask');

  // Activity Feed & Footer
  const btnOpenDownloads = document.getElementById('btnOpenDownloads');
  const recentActivityList = document.getElementById('recentActivityList');
  const btnOpenRecordModal = document.getElementById('btnOpenRecordModal');
  const btnOpenWebDashboard = document.getElementById('btnOpenWebDashboard');

  // Settings Drawer
  const drawerOverlay = document.getElementById('drawerOverlay');
  const drawerSettings = document.getElementById('drawerSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnModeVisible = document.getElementById('btnModeVisible');
  const btnModeHeadless = document.getElementById('btnModeHeadless');
  const prefTargetFolder = document.getElementById('prefTargetFolder');
  const btnBrowseFolder = document.getElementById('btnBrowseFolder');
  const chkAutoStart = document.getElementById('chkAutoStart');
  const chkMinimizeTray = document.getElementById('chkMinimizeTray');
  const prefCloudUrl = document.getElementById('prefCloudUrl');
  const btnSavePreferences = document.getElementById('btnSavePreferences');
  const btnSavePreferencesText = document.getElementById('btnSavePreferencesText');
  const savePreferencesFeedback = document.getElementById('savePreferencesFeedback');
  const maskedTokenDisplay = document.getElementById('maskedTokenDisplay');
  const btnDisconnectWorker = document.getElementById('btnDisconnectWorker');

  // Recorder Modal
  const recorderModalOverlay = document.getElementById('recorderModalOverlay');
  const btnCloseRecorderModal = document.getElementById('btnCloseRecorderModal');
  const recorderIdleView = document.getElementById('recorderIdleView');
  const recorderActiveView = document.getElementById('recorderActiveView');
  const recStartUrl = document.getElementById('recStartUrl');
  const btnStartCapture = document.getElementById('btnStartCapture');
  const btnStopCapture = document.getElementById('btnStopCapture');
  const recLiveStepCount = document.getElementById('recLiveStepCount');

  // -------------------------------------------------------------
  // STATE INITIALIZATION
  // -------------------------------------------------------------
  let currentConfig = await clientBridge.getConfig();
  let currentStatus = await clientBridge.getStatus();
  let systemInfo = { hostname: 'Local Machine' };

  try {
    if (typeof clientBridge.getSystemInfo === 'function') {
      systemInfo = await clientBridge.getSystemInfo();
    }
  } catch (err) {
    console.warn('System info probe:', err);
  }

  // Set device name badge
  if (deviceBadge) {
    deviceBadge.innerText = systemInfo.hostname || 'Local Machine';
    deviceBadge.title = `Host: ${systemInfo.hostname} (${systemInfo.platform || 'Desktop'})`;
  }

  // Ensure active banner starts strictly hidden
  if (activeRunBanner) {
    activeRunBanner.classList.add('hidden');
    activeRunBanner.style.display = 'none';
  }

  // Determine active view (Setup vs Dashboard)
  updateViewSwitch();
  applyConfigToUI(currentConfig);
  applyStatusToUI(currentStatus);
  checkChromeStatus();

  // -------------------------------------------------------------
  // VIEW SWITCHING (SETUP VS DASHBOARD)
  // -------------------------------------------------------------
  function updateViewSwitch() {
    const hasToken = Boolean(currentConfig.runnerToken && currentConfig.runnerToken.trim().length > 0);
    if (!hasToken) {
      viewSetup.classList.remove('hidden');
      viewSetup.classList.add('active');
      viewDashboard.classList.add('hidden');
      viewDashboard.classList.remove('active');
      btnOpenSettings.style.display = 'none';
    } else {
      viewSetup.classList.add('hidden');
      viewSetup.classList.remove('active');
      viewDashboard.classList.remove('hidden');
      viewDashboard.classList.add('active');
      btnOpenSettings.style.display = 'inline-flex';
    }
  }

  // -------------------------------------------------------------
  // WINDOW CONTROLS
  // -------------------------------------------------------------
  btnMinimize.addEventListener('click', () => clientBridge.minimizeWindow());
  btnClose.addEventListener('click', () => clientBridge.closeWindow());

  // -------------------------------------------------------------
  // SETUP SCREEN: LINK WORKSPACE
  // -------------------------------------------------------------
  btnToggleTokenMask.addEventListener('click', () => {
    if (inputSetupToken.type === 'password') {
      inputSetupToken.type = 'text';
      btnToggleTokenMask.innerHTML = SVG_ICONS.eyeOff;
    } else {
      inputSetupToken.type = 'password';
      btnToggleTokenMask.innerHTML = SVG_ICONS.eye;
    }
  });

  btnGetTokenHelp.addEventListener('click', () => {
    const cloudUrl = (inputSetupCloudUrl && inputSetupCloudUrl.value.trim()) || currentConfig.cloudUrl || 'https://reflowproject-web.vercel.app';
    clientBridge.openExternal(`${cloudUrl}/dashboard`);
  });

  setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = inputSetupToken.value.trim().replace(/[\.\s]+$/, '');
    if (!token) return;

    const targetCloudUrl = (inputSetupCloudUrl && inputSetupCloudUrl.value.trim()) || currentConfig.cloudUrl || 'https://reflowproject-web.vercel.app';

    btnConnectWorkspace.disabled = true;
    btnConnectWorkspace.innerText = 'Verifying Token...';
    hideFeedback();

    try {
      // 1. Test token connection
      const testRes = await clientBridge.testConnection({
        runnerToken: token,
        cloudUrl: targetCloudUrl,
      });

      if (!testRes || !testRes.connected) {
        showFeedback(testRes?.error || 'Could not verify token. Please check endpoint and token.', 'error');
        return;
      }

      // 2. Save config & auto-start runner
      currentConfig = await clientBridge.saveConfig({
        runnerToken: token,
        cloudUrl: targetCloudUrl,
      });

      applyConfigToUI(currentConfig);
      updateViewSwitch();

      // Start runner daemon
      try {
        const nextStatus = await clientBridge.startRunner();
        applyStatusToUI(nextStatus);
      } catch (err) {
        console.warn('Runner start notice:', err.message);
      }
    } catch (err) {
      showFeedback(`Connection failed: ${err.message}`, 'error');
    } finally {
      btnConnectWorkspace.disabled = false;
      btnConnectWorkspace.innerText = 'Connect Worker';
    }
  });

  function showFeedback(msg, type = 'error') {
    setupFeedback.innerText = msg;
    setupFeedback.className = `feedback-box ${type}`;
    setupFeedback.classList.remove('hidden');
  }

  function hideFeedback() {
    setupFeedback.classList.add('hidden');
  }

  // -------------------------------------------------------------
  // DASHBOARD ACTIONS
  // -------------------------------------------------------------
  btnToggleRunner.addEventListener('click', async () => {
    btnToggleRunner.disabled = true;
    try {
      if (currentStatus.status === 'active' || currentStatus.status === 'starting') {
        const next = await clientBridge.stopRunner();
        applyStatusToUI(next);
      } else {
        if (!currentConfig.runnerToken) {
          updateViewSwitch();
          return;
        }
        const next = await clientBridge.startRunner();
        applyStatusToUI(next);
      }
    } catch (err) {
      alert(`Could not toggle worker: ${err.message}`);
    } finally {
      btnToggleRunner.disabled = false;
    }
  });

  if (btnStopActiveTask) {
    btnStopActiveTask.addEventListener('click', async () => {
      btnStopActiveTask.disabled = true;
      btnStopActiveTask.innerHTML = `<span>Stopping...</span>`;
      try {
        await clientBridge.stopActiveRun();
      } catch (err) {
        console.warn('Could not stop run:', err.message);
      } finally {
        activeRunBanner.classList.add('hidden');
        activeRunBanner.style.display = 'none';
        btnStopActiveTask.disabled = false;
        btnStopActiveTask.innerHTML = `${SVG_ICONS.stop} <span>Stop</span>`;
      }
    });
  }

  btnOpenDownloads.addEventListener('click', () => {
    clientBridge.openFolder(currentConfig.targetFolder);
  });

  btnOpenWebDashboard.addEventListener('click', () => {
    const cloudUrl = currentConfig.cloudUrl || 'https://reflowproject-web.vercel.app';
    clientBridge.openExternal(`${cloudUrl}/dashboard`);
  });

  // -------------------------------------------------------------
  // DRAWER: SETTINGS & PREFERENCES
  // -------------------------------------------------------------
  function openSettings() {
    drawerOverlay.classList.remove('hidden');
    drawerSettings.classList.remove('hidden');
    populateSettingsDrawer();
  }

  function closeSettings() {
    drawerOverlay.classList.add('hidden');
    drawerSettings.classList.add('hidden');
  }

  btnOpenSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', closeSettings);
  drawerOverlay.addEventListener('click', closeSettings);

  function populateSettingsDrawer() {
    prefTargetFolder.value = currentConfig.targetFolder || '';
    chkAutoStart.checked = currentConfig.autoStartRunner !== false;
    chkMinimizeTray.checked = currentConfig.minimizeToTray !== false;
    prefCloudUrl.value = currentConfig.cloudUrl || 'https://reflowproject-web.vercel.app';

    // Masked token
    if (currentConfig.runnerToken) {
      const len = currentConfig.runnerToken.length;
      const preview = len > 10
        ? `${currentConfig.runnerToken.slice(0, 8)}••••${currentConfig.runnerToken.slice(-4)}`
        : '••••••••••••';
      maskedTokenDisplay.innerText = preview;
    } else {
      maskedTokenDisplay.innerText = 'None';
    }

    // Browser Mode Selection
    selectedBrowserMode = currentConfig.browserMode || 'visible';
    applyModeControl(selectedBrowserMode);

    if (savePreferencesFeedback) {
      savePreferencesFeedback.classList.add('hidden');
      savePreferencesFeedback.style.display = 'none';
    }
  }

  let selectedBrowserMode = 'visible';

  function applyModeControl(mode) {
    selectedBrowserMode = mode;
    if (mode === 'headless') {
      btnModeHeadless.classList.add('active');
      btnModeVisible.classList.remove('active');
    } else {
      btnModeVisible.classList.add('active');
      btnModeHeadless.classList.remove('active');
    }
  }

  btnModeVisible.addEventListener('click', () => {
    applyModeControl('visible');
  });

  btnModeHeadless.addEventListener('click', () => {
    applyModeControl('headless');
  });

  // Folder Picker
  btnBrowseFolder.addEventListener('click', async () => {
    try {
      const chosen = await clientBridge.selectFolder();
      if (chosen) {
        prefTargetFolder.value = chosen;
      }
    } catch (err) {
      console.warn('Folder selection notice:', err);
    }
  });

  // Save Preferences Handler
  let feedbackTimer = null;
  function showSaveFeedback(message, isError = false) {
    if (!savePreferencesFeedback) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    savePreferencesFeedback.innerText = message;
    savePreferencesFeedback.className = `pref-feedback-msg ${isError ? 'error' : 'success'}`;
    savePreferencesFeedback.classList.remove('hidden');
    savePreferencesFeedback.style.display = 'flex';

    feedbackTimer = setTimeout(() => {
      savePreferencesFeedback.classList.add('hidden');
      savePreferencesFeedback.style.display = 'none';
    }, 4000);
  }

  if (btnSavePreferences) {
    btnSavePreferences.addEventListener('click', async () => {
      btnSavePreferences.disabled = true;
      if (btnSavePreferencesText) btnSavePreferencesText.innerText = 'Saving...';

      try {
        const payload = {
          browserMode: selectedBrowserMode,
          targetFolder: prefTargetFolder.value.trim() || currentConfig.targetFolder,
          autoStartRunner: chkAutoStart.checked,
          minimizeToTray: chkMinimizeTray.checked,
          cloudUrl: prefCloudUrl.value.trim() || currentConfig.cloudUrl,
        };

        currentConfig = await clientBridge.saveConfig(payload);
        applyConfigToUI(currentConfig);
        await checkChromeStatus();

        const modeLabel = selectedBrowserMode === 'visible' ? 'Visible (2FA)' : 'Headless';
        showSaveFeedback(`✓ Preferences saved! (${modeLabel} mode)`);
      } catch (err) {
        showSaveFeedback(`Failed to save: ${err.message}`, true);
      } finally {
        btnSavePreferences.disabled = false;
        if (btnSavePreferencesText) btnSavePreferencesText.innerText = 'Save Preferences';
      }
    });
  }

  // Disconnect & Unlink Worker
  btnDisconnectWorker.addEventListener('click', async () => {
    if (confirm('Disconnect this local worker from your ReFlow workspace?')) {
      try {
        await clientBridge.stopRunner();
      } catch {}

      currentConfig = await clientBridge.saveConfig({
        runnerToken: '',
      });

      closeSettings();
      updateViewSwitch();
      applyStatusToUI({ status: 'idle', activeRun: null, recentRuns: [] });
    }
  });

  // -------------------------------------------------------------
  // MODAL: WORKFLOW RECORDER
  // -------------------------------------------------------------
  btnOpenRecordModal.addEventListener('click', () => {
    recorderModalOverlay.classList.remove('hidden');
    checkRecordingState();
  });

  btnCloseRecorderModal.addEventListener('click', () => {
    recorderModalOverlay.classList.add('hidden');
  });

  recorderModalOverlay.addEventListener('click', (e) => {
    if (e.target === recorderModalOverlay) {
      recorderModalOverlay.classList.add('hidden');
    }
  });

  btnStartCapture.addEventListener('click', async () => {
    const url = recStartUrl.value.trim() || 'https://google.com';
    btnStartCapture.disabled = true;
    btnStartCapture.innerText = 'Booting Chrome...';

    try {
      const res = await clientBridge.startRecording({
        url,
        name: `portal-workflow-${Date.now()}`,
      });
      updateRecorderModalUI(res);
    } catch (err) {
      alert(`Recording error: ${err.message}`);
    } finally {
      btnStartCapture.disabled = false;
      btnStartCapture.innerText = 'Launch Chrome & Record';
    }
  });

  btnStopCapture.addEventListener('click', async () => {
    btnStopCapture.disabled = true;
    btnStopCapture.innerText = 'Saving...';

    try {
      const res = await clientBridge.stopRecording();
      updateRecorderModalUI(res);
      recorderModalOverlay.classList.add('hidden');
    } catch (err) {
      alert(`Could not stop recording: ${err.message}`);
    } finally {
      btnStopCapture.disabled = false;
      btnStopCapture.innerHTML = `${SVG_ICONS.stop} <span>Finish & Save Recording</span>`;
    }
  });

  async function checkRecordingState() {
    try {
      const state = await clientBridge.getRecordingStatus();
      updateRecorderModalUI(state);
    } catch {}
  }

  function updateRecorderModalUI(state) {
    if (!state) return;
    if (state.isRecording) {
      recorderIdleView.classList.add('hidden');
      recorderActiveView.classList.remove('hidden');
      const count = typeof state.actionCount === 'number'
        ? state.actionCount
        : (Array.isArray(state.actions) ? state.actions.length : 0);
      recLiveStepCount.innerText = count;
    } else {
      recorderActiveView.classList.add('hidden');
      recorderIdleView.classList.remove('hidden');
    }
  }

  if (typeof clientBridge.onRecordingUpdate === 'function') {
    clientBridge.onRecordingUpdate((state) => {
      updateRecorderModalUI(state);
    });
  }

  // -------------------------------------------------------------
  // REAL-TIME STATUS UPDATES
  // -------------------------------------------------------------
  clientBridge.onStatusUpdate((state) => {
    currentStatus = state;
    applyStatusToUI(state);
    checkChromeStatus();
  });

  async function checkChromeStatus() {
    try {
      if (typeof clientBridge.checkCdpStatus === 'function') {
        const cdp = await clientBridge.checkCdpStatus();
        if (cdp && cdp.open) {
          const modeStr = cdp.isHeadless ? 'Headless' : 'Visible (2FA)';
          browserStatusLabel.innerText = `Chrome: ${modeStr}`;
          if (browserDot) browserDot.className = 'chip-dot dot-blue';
        } else {
          browserStatusLabel.innerText = 'Chrome: Standby';
          if (browserDot) browserDot.className = 'chip-dot dot-slate';
        }
      }
    } catch {}
  }

  function applyConfigToUI(cfg) {
    if (cfg.runnerToken) {
      const tokenPreview = cfg.runnerToken.slice(0, 12);
      displayOrgName.innerText = `Workspace (${tokenPreview}...)`;
    }
    if (inputSetupCloudUrl) {
      inputSetupCloudUrl.value = cfg.cloudUrl || 'https://reflowproject-web.vercel.app';
    }
  }

  function applyStatusToUI(state) {
    currentStatus = state;

    // Reset Pulse Classes
    runnerPulseDot.className = 'status-pulse';

    switch (state.status) {
      case 'active':
        runnerPulseDot.classList.add('pulse-active');
        runnerStatusHeading.innerText = 'Worker Active';
        runnerStatusDetail.innerText = 'Listening for portal jobs...';
        btnToggleRunner.className = 'hero-toggle-btn btn-stop';
        btnToggleRunnerText.innerText = 'Pause Worker';
        btnToggleIcon.innerHTML = SVG_ICONS.pause;
        connectionPill.className = 'badge-status badge-online';
        connectionPill.innerText = '● Active';
        cloudStatusLabel.innerText = 'Cloud: Online';
        break;

      case 'starting':
        runnerPulseDot.classList.add('pulse-starting');
        runnerStatusHeading.innerText = 'Starting...';
        runnerStatusDetail.innerText = 'Connecting to cloud control plane...';
        btnToggleRunner.className = 'hero-toggle-btn btn-start';
        btnToggleRunnerText.innerText = 'Starting...';
        btnToggleIcon.innerHTML = SVG_ICONS.zap;
        break;

      case 'stopping':
        runnerPulseDot.classList.add('pulse-starting');
        runnerStatusHeading.innerText = 'Pausing...';
        runnerStatusDetail.innerText = 'Completing active operations...';
        btnToggleRunner.className = 'hero-toggle-btn btn-stop';
        btnToggleRunnerText.innerText = 'Pausing...';
        btnToggleIcon.innerHTML = SVG_ICONS.pause;
        break;

      case 'error':
        runnerPulseDot.classList.add('pulse-idle');
        runnerStatusHeading.innerText = 'Worker Error';
        runnerStatusDetail.innerText = state.lastError ? state.lastError.slice(0, 38) : 'Error occurred';
        btnToggleRunner.className = 'hero-toggle-btn btn-start';
        btnToggleRunnerText.innerText = 'Start Worker';
        btnToggleIcon.innerHTML = SVG_ICONS.zap;
        connectionPill.className = 'badge-status';
        connectionPill.innerText = '● Error';
        break;

      default: // 'idle'
        runnerPulseDot.classList.add('pulse-idle');
        runnerStatusHeading.innerText = 'Worker Paused';
        runnerStatusDetail.innerText = 'Paused. Click Start to listen for jobs.';
        btnToggleRunner.className = 'hero-toggle-btn btn-start';
        btnToggleRunnerText.innerText = 'Start Worker';
        btnToggleIcon.innerHTML = SVG_ICONS.zap;
        connectionPill.className = 'badge-status';
        connectionPill.innerText = '● Standby';
        cloudStatusLabel.innerText = 'Cloud: Standby';
        break;
    }

    // Active Task Banner (Only displayed when there is a real running task!)
    if (state && state.activeRun) {
      activeRunBanner.classList.remove('hidden');
      activeRunBanner.style.display = 'flex';
      activeTaskTitle.innerText = state.activeRun.workflowName || state.activeRun.workflowId || 'Portal Automation';
      const items = state.activeRun.itemsDownloaded || 0;
      activeTaskMeta.innerText = items > 0 ? `Downloaded: ${items} files` : 'Processing portal steps...';
    } else {
      activeRunBanner.classList.add('hidden');
      activeRunBanner.style.display = 'none';
    }

    // Activity Feed
    renderActivityFeed(state.recentRuns || []);
  }

  function renderActivityFeed(runs) {
    if (!runs || runs.length === 0) {
      recentActivityList.innerHTML = '<div class="empty-activity">No workflow runs yet. Started worker will process incoming jobs.</div>';
      return;
    }

    recentActivityList.innerHTML = runs
      .slice(0, 5)
      .map((r) => {
        const isSuccess = r.status === 'completed';
        const isCancelled = r.status === 'cancelled';
        const tagClass = isSuccess ? 'tag-success' : 'tag-failed';
        const timeStr = r.completedAt ? new Date(r.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';
        
        let labelContent = '';
        if (isSuccess) {
          const countText = typeof r.itemsDownloaded === 'number' && r.itemsDownloaded > 0
            ? `${r.itemsDownloaded} items`
            : 'Completed';
          labelContent = `${SVG_ICONS.check} <span>${countText}</span>`;
        } else if (isCancelled) {
          labelContent = `${SVG_ICONS.fail} <span>Cancelled</span>`;
        } else {
          labelContent = `${SVG_ICONS.fail} <span>Failed</span>`;
        }

        return `
          <div class="activity-row">
            <div class="activity-info">
              <span class="activity-name">${escapeHtml(r.workflowName || 'Portal Automation')}</span>
              <span class="activity-time">${timeStr}</span>
            </div>
            <span class="activity-tag ${tagClass}">${labelContent}</span>
          </div>
        `;
      })
      .join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});
