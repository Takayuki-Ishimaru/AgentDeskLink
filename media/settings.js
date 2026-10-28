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
    clientsList: $('clients-list'), clientsStatus: $('clients-status'), clientsError: $('clients-error'),
    originsList: $('origins-list'), originInput: $('origin-input'), originAdd: $('origin-add'), originsError: $('origins-error'),
    sessionIdleMinutes: $('session-idle-minutes'), browserHeadless: $('browser-headless'), browserProxyServer: $('browser-proxy-server'),
    sessionIdleEffective: $('session-idle-effective'), runtimeError: $('runtime-settings-error'), operationMode: $('operation-mode'), operationModeError: $('operation-mode-error')
  };

  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const setBusy = (el, busy) => { if (el) { el.disabled = busy || el.dataset.locked === 'true'; el.setAttribute('aria-busy', busy ? 'true' : 'false'); } };

  let busy = {};
  let currentOrigins = [];
  function markBusy(key, on) {
    busy[key] = on;
    const map = { enabled: ['enabled'], auto: ['autoUpdate'], check: ['checkUpdates'], checkNow: ['checkNow'], resume: ['resumeOperations'], clients: ['clientsEnable', 'clientsRefresh'], origins: ['originAdd'], runtime: ['sessionIdleMinutes','browserHeadless','browserProxyServer'], operationMode:['operationMode'] };
    (map[key] || []).forEach((name) => setBusy(els[name], on));
    // Emergency stop must stay clickable even while the stop itself runs.
    if (key === 'stop' && els.emergencyStop) els.emergencyStop.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function renderClients(state) {
    if (!state || !Array.isArray(state.rows) || !els.clientsList) return;
    els.clientsList.textContent = '';
    const labels = { enabled: '登録済み / Configured', disabled: '未登録 / Not configured', conflict: '同名設定あり / Name conflict', error: 'エラー / Error', 'not-detected': '未検出 / Not detected' };
    for (const client of state.rows) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = String(client.name);
      const status = document.createElement('span'); status.textContent = labels[client.status] || String(client.status);
      li.appendChild(name); li.appendChild(status);
      if (client.message) li.title = String(client.message);
      els.clientsList.appendChild(li);
    }
    set(els.clientsError, state.error || state.rows.filter(c => c.status === 'error' || c.status === 'conflict').map(c => `${c.name}: ${c.message}`).join('\n'));
    set(els.clientsStatus, state.busy ? 'AI クライアントを更新しています… / Updating AI clients…' : `${state.rows.filter(c => c.detected).length} 件を検出 / detected; ${state.rows.filter(c => c.status === 'enabled').length} 件に登録済み / configured`);
    setBusy(els.clientsEnable, !!state.busy || !!busy.clients);
    setBusy(els.clientsRefresh, !!state.busy || !!busy.clients);
    // Disabling remains available while another operation is preparing.
  }

  function renderOrigins(origins) {
    if (!els.originsList) return;
    currentOrigins = Array.isArray(origins) ? origins.filter(value => typeof value === 'string').slice() : [];
    els.originsList.textContent = '';
    for (const origin of currentOrigins) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = origin;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = '削除 / Remove';
      remove.setAttribute('aria-label', `許可元を削除 / Remove origin ${origin}`);
      remove.addEventListener('click', () => {
        const next = currentOrigins.slice(); next.splice(next.indexOf(origin), 1);
        send({ type: 'setBrowserOrigins', origins: next }, 'origins');
      });
      li.appendChild(name); li.appendChild(remove); els.originsList.appendChild(li);
    }
  }

  const PERMS = [['origins', 'ブラウザの許可元 / Browser origins'], ['app', 'ネイティブアプリ / Native app'], ['operations', '全操作 / All operations'], ['physical', '物理入力 / Physical input'], ['images', '無加工ネイティブ画像 / Unredacted native images'], ['loopback', 'ループバック / Loopback'], ['private', 'プライベート網 / Private network'], ['mode','操作段階 / Operation tier']];
  const OFF = {origins: 'なし / none', app: 'なし / none', operations: '許可リストのみ / allowlists only', physical: 'オフ / off', images: '無効 / disabled', loopback: 'オフ / off', private: 'オフ / off'};
  // Concise bilingual summary; all text lands through textContent.
  function renderPermissions(p) {
    if (!els.permissions || !p || typeof p !== 'object' || typeof document.createElement !== 'function') return;
    const requested = p.requested || p;
    p = p.effective || p;
    const flags = {'operations':'allowAllOperations','physical':'allowPhysicalInput','images':'allowUnredactedImages','loopback':'allowLoopback','private':'allowPrivateNetwork'};
    const value = (key) => key === 'mode' ? ({read_only:'読み取り専用 / read only',standard:'標準 / standard',ask:'都度承認 / ask each time',all:'すべて許可 / allow all (legacy)'}[p.operationMode] || 'unknown')
      : key === 'origins' ? (Array.isArray(p.browserOrigins) && p.browserOrigins.length ? p.browserOrigins.join(', ') : OFF.origins)
      : key === 'app' ? (p.desktopAppId || OFF.app)
      : p[flags[key]] ? '有効 / on' : OFF[key];
    els.permissions.textContent = '';
    for (const [key, label] of PERMS) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'perm-label'; a.textContent = label;
      const b = document.createElement('span'); b.className = 'perm-value'; b.textContent = String(value(key)) + (requested[flags[key]] === true && p[flags[key]] !== true ? '（要求 on / requested on）' : '');
      li.appendChild(a); li.appendChild(b); els.permissions.appendChild(li);
    }
    const hint = (Array.isArray(p.browserOrigins) && p.browserOrigins.length) || p.desktopAppId ? '許可された範囲のみ利用できます。 / Only granted scopes are usable.' : 'MCP を有効にしても権限は付きません。 / Enabling MCP alone grants nothing.';
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
  if (els.originAdd) els.originAdd.addEventListener('click', () => {
    const value = String(els.originInput?.value || '').trim();
    if (!value) return;
    send({ type: 'setBrowserOrigins', origins: [...currentOrigins, value] }, 'origins');
  });
  if (els.originInput) els.originInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); els.originAdd?.click(); } });
  if (els.sessionIdleMinutes) els.sessionIdleMinutes.addEventListener('change', () => {
    const minutes=Number(els.sessionIdleMinutes.value);
    if (Number.isInteger(minutes)) send({ type: 'setSessionIdleMinutes', minutes }, 'runtime');
  });
  if (els.browserHeadless) els.browserHeadless.addEventListener('change', () => send({type:'setBrowserHeadless',enabled:els.browserHeadless.checked},'runtime'));
  if (els.browserProxyServer) els.browserProxyServer.addEventListener('change', () => send({type:'setBrowserProxyServer',proxy:String(els.browserProxyServer.value)},'runtime'));
  if (els.operationMode) els.operationMode.addEventListener('change', () => send({type:'setOperationMode',mode:String(els.operationMode.value)},'operationMode'));

  window.addEventListener('message', (event) => {
    const s = event.data;
    if (!s || typeof s !== 'object' || s.type !== 'state') return;
    if (s.busy) Object.keys(s.busy).forEach((k) => markBusy(k, !!s.busy[k]));
    if (typeof s.trusted === 'boolean' || typeof s.hasFolder === 'boolean') {
      const workspaceOk = s.trusted !== false && s.hasFolder !== false;
      if (els.enabled) els.enabled.dataset.locked = workspaceOk ? 'false' : 'true';
      if (els.enabled) els.enabled.disabled = busy.enabled === true || !workspaceOk;
      if (els.clientsEnable) { els.clientsEnable.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.clientsEnable, !!busy.clients); }
      if (els.enabledHint) set(els.enabledHint, workspaceOk ? '変更はこのワークスペースに保存されます。 / Changes are saved to this workspace.' : '信頼済みワークスペースで利用できます。 / Open a trusted workspace to change this.');
      if (els.originAdd) { els.originAdd.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.originAdd, !!busy.origins); }
      if (els.originInput) els.originInput.disabled = !workspaceOk || busy.origins === true;
      if (els.sessionIdleMinutes) { els.sessionIdleMinutes.dataset.locked=workspaceOk?'false':'true'; setBusy(els.sessionIdleMinutes,!!busy.runtime); }
      if (els.browserHeadless) { els.browserHeadless.dataset.locked=workspaceOk?'false':'true'; setBusy(els.browserHeadless,!!busy.runtime); }
      if (els.browserProxyServer) { els.browserProxyServer.dataset.locked=workspaceOk?'false':'true'; setBusy(els.browserProxyServer,!!busy.runtime); }
      if (els.operationMode) { els.operationMode.dataset.locked=workspaceOk?'false':'true'; setBusy(els.operationMode,!!busy.operationMode); }
    }
    if (typeof s.stopped === 'boolean') {
      if (els.resumeOperations) els.resumeOperations.hidden = !s.stopped;
      if (els.stoppedStatus) els.stoppedStatus.hidden = !s.stopped;
    }
    if (s.settings) {
      if (els.enabled && typeof s.settings.enabled === 'boolean') els.enabled.checked = s.settings.enabled;
      if (els.autoUpdate && typeof s.settings.autoUpdate === 'boolean') els.autoUpdate.checked = s.settings.autoUpdate;
      if (els.checkUpdates && typeof s.settings.checkForUpdates === 'boolean') els.checkUpdates.checked = s.settings.checkForUpdates;
      renderOrigins(s.settings.browserOrigins);
      if (els.sessionIdleMinutes && typeof s.settings.sessionIdleMinutes === 'number') {
        els.sessionIdleMinutes.value = String(s.settings.sessionIdleMinutes);
      }
      if (els.browserHeadless && typeof s.settings.browserHeadless === 'boolean') els.browserHeadless.checked=s.settings.browserHeadless;
      if (els.browserProxyServer && typeof s.settings.browserProxyServer === 'string') els.browserProxyServer.value=s.settings.browserProxyServer;
      if (els.operationMode && typeof s.settings.operationMode==='string') {
        const effectiveMode=s.permissions?.effective?.operationMode;
        els.operationMode.value=effectiveMode==='all'?'all':s.settings.operationMode;
      }
      if (typeof s.settings.sessionIdleMinutes==='number'&&typeof s.settings.browserHeadless==='boolean') {
        const proxy=s.settings.browserProxyServer?'Proxy: '+s.settings.browserProxyServer:'Proxy: none';
        set(els.sessionIdleEffective,`有効値 / Effective: ${s.settings.sessionIdleMinutes} 分 / minutes; ${s.settings.browserHeadless?'headless':'headful'}; ${proxy}`);
      }
    }
    if (s.permissions) renderPermissions(s.permissions);
    if (s.clients) renderClients(s.clients);
    if (s.status) {
      set(els.version, s.status.version || '');
      set(els.mcpStatus, s.status.mcp || '');
      set(els.updateStatus, s.status.update || '');
      set(els.enabledError, s.status.enabledError || '');
      set(els.originsError, s.status.originsError || '');
      set(els.runtimeError, s.status.runtimeError || '');
      set(els.operationModeError,s.status.operationModeError||'');
      set(els.globalError, s.status.globalError || '');
      set(els.mcpError, s.status.mcpError || '');
    }
  });

  post({ type: 'ready' });
})();
