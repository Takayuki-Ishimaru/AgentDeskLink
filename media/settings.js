// AgentDeskLink settings panel. All dynamic text goes through textContent.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const post = (message) => { if (vscode) vscode.postMessage(message); };
  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $('enabled'),
    autoUpdate: $('auto-update'),
    checkUpdates: $('check-updates'),
    manifestUrl: $('manifest-url'), manifestSave: $('manifest-save'),
    checkNow: $('check-now'), openLogs: $('open-logs'), openSettings: $('open-settings'),
    emergencyStop: $('emergency-stop'), resumeOperations: $('resume-operations'), stoppedStatus: $('stopped-status'),
    version: $('version'), mcpStatus: $('mcp-status'), updateStatus: $('update-status'),
    enabledError: $('enabled-error'), globalError: $('global-error'), mcpError: $('mcp-error'),
    enabledHint: $('enabled-hint')
  };

  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const setBusy = (el, busy) => { if (el) { el.disabled = busy || el.dataset.locked === 'true'; el.setAttribute('aria-busy', busy ? 'true' : 'false'); } };

  let busy = {};
  function markBusy(key, on) {
    busy[key] = on;
    const map = { enabled: ['enabled'], auto: ['autoUpdate'], check: ['checkUpdates'], manifest: ['manifestUrl', 'manifestSave'], checkNow: ['checkNow'], resume: ['resumeOperations'] };
    (map[key] || []).forEach((name) => setBusy(els[name], on));
    // Emergency stop must stay clickable even while the stop itself runs.
    if (key === 'stop' && els.emergencyStop) els.emergencyStop.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function send(msg, busyKey) { if (busyKey) markBusy(busyKey, true); post(msg); }

  // Checkboxes save immediately; text inputs use an explicit Save button.
  if (els.enabled) els.enabled.addEventListener('change', () => send({ type: 'setEnabled', enabled: els.enabled.checked }, 'enabled'));
  if (els.autoUpdate) els.autoUpdate.addEventListener('change', () => send({ type: 'setAutoUpdate', enabled: els.autoUpdate.checked }, 'auto'));
  if (els.checkUpdates) els.checkUpdates.addEventListener('change', () => send({ type: 'setCheckForUpdates', enabled: els.checkUpdates.checked }, 'check'));
  const saveText = (el, type) => () => send({ type, value: el.value }, 'manifest');
  if (els.manifestUrl) els.manifestSave.addEventListener('click', saveText(els.manifestUrl, 'setUpdateManifestUrl'));
  if (els.emergencyStop) els.emergencyStop.addEventListener('click', () => post({ type: 'emergencyStop' }));
  if (els.resumeOperations) els.resumeOperations.addEventListener('click', () => { setBusy(els.resumeOperations, true); post({ type: 'resumeOperations' }); });
  if (els.checkNow) els.checkNow.addEventListener('click', () => { setBusy(els.checkNow, true); post({ type: 'checkForUpdates' }); });
  if (els.openLogs) els.openLogs.addEventListener('click', () => post({ type: 'openLogs' }));
  if (els.openSettings) els.openSettings.addEventListener('click', () => post({ type: 'openWorkspaceSettings' }));

  window.addEventListener('message', (event) => {
    const s = event.data;
    if (!s || typeof s !== 'object' || s.type !== 'state') return;
    if (s.busy) Object.keys(s.busy).forEach((k) => markBusy(k, !!s.busy[k]));
    if (typeof s.trusted === 'boolean' || typeof s.hasFolder === 'boolean') {
      const workspaceOk = s.trusted !== false && s.hasFolder !== false;
      if (els.enabled) els.enabled.dataset.locked = workspaceOk ? 'false' : 'true';
      if (els.enabled) els.enabled.disabled = busy.enabled === true || !workspaceOk;
      if (els.enabledHint) set(els.enabledHint, workspaceOk ? '変更はこのワークスペースに保存されます。' : '信頼するフォルダーを開くと有効にできます。');
    }
    if (typeof s.stopped === 'boolean') {
      if (els.resumeOperations) els.resumeOperations.hidden = !s.stopped;
      if (els.stoppedStatus) els.stoppedStatus.hidden = !s.stopped;
    }
    if (s.settings) {
      if (els.enabled && typeof s.settings.enabled === 'boolean') els.enabled.checked = s.settings.enabled;
      if (els.autoUpdate && typeof s.settings.autoUpdate === 'boolean') els.autoUpdate.checked = s.settings.autoUpdate;
      if (els.checkUpdates && typeof s.settings.checkForUpdates === 'boolean') els.checkUpdates.checked = s.settings.checkForUpdates;
      if (els.manifestUrl && typeof s.settings.updateManifestUrl === 'string' && document.activeElement !== els.manifestUrl) els.manifestUrl.value = s.settings.updateManifestUrl;
    }
    if (s.status) {
      set(els.version, s.status.version || '');
      set(els.mcpStatus, s.status.mcp || '');
      set(els.updateStatus, s.status.update || '');
      set(els.enabledError, s.status.enabledError || '');
      set(els.globalError, s.status.globalError || '');
      set(els.mcpError, s.status.mcpError || '');
    }
  });

  post({ type: 'ready' });
})();
