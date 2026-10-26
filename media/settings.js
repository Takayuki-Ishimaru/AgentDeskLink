// AgentDeskLink settings panel. All dynamic text goes through textContent.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const post = (message) => { if (vscode) vscode.postMessage(message); };
  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $('enabled'),
    autoUpdate: $('auto-update'),
    checkUpdates: $('check-updates'),
    checkNow: $('check-now'), openLogs: $('open-logs'), openSettings: $('open-settings'),
    emergencyStop: $('emergency-stop'), resumeOperations: $('resume-operations'), stoppedStatus: $('stopped-status'),
    version: $('version'), mcpStatus: $('mcp-status'), updateStatus: $('update-status'),
    enabledError: $('enabled-error'), globalError: $('global-error'), mcpError: $('mcp-error'),
    enabledHint: $('enabled-hint'),
    permissions: $('permissions'), permissionsHint: $('permissions-hint'),
    clientsEnable: $('clients-enable'), clientsDisable: $('clients-disable'), clientsRefresh: $('clients-refresh'),
    clientsList: $('clients-list'), clientsStatus: $('clients-status'), clientsError: $('clients-error')
  };

  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const setBusy = (el, busy) => { if (el) { el.disabled = busy || el.dataset.locked === 'true'; el.setAttribute('aria-busy', busy ? 'true' : 'false'); } };

  let busy = {};
  function markBusy(key, on) {
    busy[key] = on;
    const map = { enabled: ['enabled'], auto: ['autoUpdate'], check: ['checkUpdates'], checkNow: ['checkNow'], resume: ['resumeOperations'], clients: ['clientsEnable', 'clientsRefresh'] };
    (map[key] || []).forEach((name) => setBusy(els[name], on));
    // Emergency stop must stay clickable even while the stop itself runs.
    if (key === 'stop' && els.emergencyStop) els.emergencyStop.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function renderClients(state) {
    if (!state || !Array.isArray(state.rows) || !els.clientsList) return;
    els.clientsList.textContent = '';
    const labels = { enabled: '登録済み', disabled: '未登録', conflict: '同名設定あり', error: 'エラー', 'not-detected': '未検出' };
    for (const client of state.rows) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = String(client.name);
      const status = document.createElement('span'); status.textContent = labels[client.status] || String(client.status);
      li.appendChild(name); li.appendChild(status);
      if (client.message) li.title = String(client.message);
      els.clientsList.appendChild(li);
    }
    set(els.clientsError, state.error || state.rows.filter(c => c.status === 'error' || c.status === 'conflict').map(c => `${c.name}: ${c.message}`).join('\n'));
    set(els.clientsStatus, state.busy ? 'AIクライアントの設定を更新しています…' : `${state.rows.filter(c => c.detected).length}件を検出 / ${state.rows.filter(c => c.status === 'enabled').length}件に登録済み`);
    setBusy(els.clientsEnable, !!state.busy || !!busy.clients);
    setBusy(els.clientsRefresh, !!state.busy || !!busy.clients);
    // Disabling remains available while another operation is preparing.
  }

  const PERMS = [['origins', 'ブラウザの許可元 / Browser origins'], ['app', 'ネイティブアプリ / Native app'], ['operations', '全操作 / All operations'], ['physical', '物理入力 / Physical input'], ['images', '無加工ネイティブ画像 / Unredacted native images'], ['loopback', 'ループバック / Loopback'], ['private', 'プライベート網 / Private network']];
  const OFF = {origins: 'なし / none', app: 'なし / none', operations: '許可リストのみ / allowlists only', physical: 'オフ / off', images: '無効 / disabled', loopback: 'オフ / off', private: 'オフ / off'};
  // Concise bilingual summary; all text lands through textContent.
  function renderPermissions(p) {
    if (!els.permissions || !p || typeof p !== 'object' || typeof document.createElement !== 'function') return;
    const requested = p.requested || p;
    p = p.effective || p;
    const flags = {'operations':'allowAllOperations','physical':'allowPhysicalInput','images':'allowUnredactedImages','loopback':'allowLoopback','private':'allowPrivateNetwork'};
    const value = (key) => key === 'origins' ? (Array.isArray(p.browserOrigins) && p.browserOrigins.length ? p.browserOrigins.join(', ') : OFF.origins)
      : key === 'app' ? (p.desktopAppId || OFF.app)
      : p[flags[key]] ? 'on' : OFF[key];
    els.permissions.textContent = '';
    for (const [key, label] of PERMS) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'perm-label'; a.textContent = label;
      const b = document.createElement('span'); b.className = 'perm-value'; b.textContent = String(value(key)) + (requested[flags[key]] === true && p[flags[key]] !== true ? '（要求 on / requested on）' : '');
      li.appendChild(a); li.appendChild(b); els.permissions.appendChild(li);
    }
    const hint = (Array.isArray(p.browserOrigins) && p.browserOrigins.length) || p.desktopAppId ? '許可された範囲のみ利用できます。/ Only granted scopes are usable.' : 'MCP 有効だけでも権限は付きません。/ Enabling MCP alone grants nothing.';
    if (els.permissionsHint) set(els.permissionsHint, [hint, ...(Array.isArray(p.reasons) ? p.reasons : [])].join(' '));
  }
  function send(msg, busyKey) { if (busyKey) markBusy(busyKey, true); post(msg); }

  // Checkboxes save immediately; text inputs use an explicit Save button.
  if (els.enabled) els.enabled.addEventListener('change', () => send({ type: 'setEnabled', enabled: els.enabled.checked }, 'enabled'));
  if (els.autoUpdate) els.autoUpdate.addEventListener('change', () => send({ type: 'setAutoUpdate', enabled: els.autoUpdate.checked }, 'auto'));
  if (els.checkUpdates) els.checkUpdates.addEventListener('change', () => send({ type: 'setCheckForUpdates', enabled: els.checkUpdates.checked }, 'check'));
  if (els.emergencyStop) els.emergencyStop.addEventListener('click', () => post({ type: 'emergencyStop' }));
  if (els.resumeOperations) els.resumeOperations.addEventListener('click', () => { setBusy(els.resumeOperations, true); post({ type: 'resumeOperations' }); });
  if (els.checkNow) els.checkNow.addEventListener('click', () => { setBusy(els.checkNow, true); post({ type: 'checkForUpdates' }); });
  if (els.openLogs) els.openLogs.addEventListener('click', () => post({ type: 'openLogs' }));
  if (els.openSettings) els.openSettings.addEventListener('click', () => post({ type: 'openWorkspaceSettings' }));
  if (els.clientsEnable) els.clientsEnable.addEventListener('click', () => send({ type: 'enableAllClients' }, 'clients'));
  if (els.clientsDisable) els.clientsDisable.addEventListener('click', () => post({ type: 'disableAllClients' }));
  if (els.clientsRefresh) els.clientsRefresh.addEventListener('click', () => send({ type: 'refreshClients' }, 'clients'));

  window.addEventListener('message', (event) => {
    const s = event.data;
    if (!s || typeof s !== 'object' || s.type !== 'state') return;
    if (s.busy) Object.keys(s.busy).forEach((k) => markBusy(k, !!s.busy[k]));
    if (typeof s.trusted === 'boolean' || typeof s.hasFolder === 'boolean') {
      const workspaceOk = s.trusted !== false && s.hasFolder !== false;
      if (els.enabled) els.enabled.dataset.locked = workspaceOk ? 'false' : 'true';
      if (els.enabled) els.enabled.disabled = busy.enabled === true || !workspaceOk;
      if (els.clientsEnable) { els.clientsEnable.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.clientsEnable, !!busy.clients); }
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
    }
    if (s.permissions) renderPermissions(s.permissions);
    if (s.clients) renderClients(s.clients);
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
