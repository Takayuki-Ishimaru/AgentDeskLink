// AgentDeskLink settings panel. All dynamic text goes through textContent.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const post = (message) => { if (vscode) vscode.postMessage(message); };
  const $ = (id) => document.getElementById(id);
  let uiLanguage = document.documentElement?.lang === 'ja' ? 'ja' : 'en';
  const localizedNodes = new Map();
  const localizedAttributes = new Map();
  const localizedOptions = new Map();
  const localize = (value) => {
    let text = String(value ?? '');
    let suffix = '';
    const requested = '（要求 on / requested on）';
    if (text.endsWith(requested)) {
      text = text.slice(0, -requested.length);
      suffix = uiLanguage === 'ja' ? '（要求 on）' : ' (requested on)';
    }
    const separator = text.indexOf(' / ');
    if (separator < 0) return text + suffix;
    return (uiLanguage === 'ja' ? text.slice(0, separator) : text.slice(separator + 3)) + suffix;
  };
  function setText(el, value) {
    if (!el) return;
    const text = String(value ?? ''); localizedNodes.set(el, () => localize(text));
    const rendered = localize(text); if (el.textContent !== rendered) el.textContent = rendered;
  }
  function setTextParts(el, values) {
    if (!el) return;
    const parts = values.map(value => String(value ?? '')); localizedNodes.set(el, () => parts.map(localize).join(' '));
    el.textContent = parts.map(localize).join(' ');
  }
  function setLocalizedAttribute(el, key, value) {
    if (!el) return;
    let attrs = localizedAttributes.get(el); if (!attrs) { attrs = new Map(); localizedAttributes.set(el, attrs); }
    attrs.set(key, String(value)); el.setAttribute(key, localize(value));
  }
  function applyLanguage(value) {
    uiLanguage = value === 'ja' ? 'ja' : 'en';
    if (document.documentElement) document.documentElement.lang = uiLanguage;
    for (const [el, render] of localizedNodes) el.textContent = render();
    for (const [el, attrs] of localizedAttributes) for (const [key, text] of attrs) el.setAttribute(key, localize(text));
    for (const [option, text] of localizedOptions) option.textContent = localize(text);
    if (els.language) els.language.value = uiLanguage;
  }

  const els = {
    enabled: $('enabled'),
    autoUpdate: $('auto-update'),
    checkUpdates: $('check-updates'),
    checkNow: $('check-now'), openLogs: $('open-logs'), openSettings: $('open-settings'),
    emergencyStop: $('emergency-stop'), resumeOperations: $('resume-operations'), stoppedStatus: $('stopped-status'),
    version: $('version'), mcpStatus: $('mcp-status'), updateStatus: $('update-status'), language: $('ui-language'),
    enabledError: $('enabled-error'), globalError: $('global-error'), mcpError: $('mcp-error'),
    enabledHint: $('enabled-hint'),
    permissions: $('permissions'), permissionsHint: $('permissions-hint'),
    clientsEnable: $('clients-enable'), clientsDisable: $('clients-disable'), clientsRefresh: $('clients-refresh'),
    clientsList: $('clients-list'), clientsStatus: $('clients-status'), clientsError: $('clients-error'),
    originsList: $('origins-list'), originInput: $('origin-input'), originAdd: $('origin-add'), originsError: $('origins-error'),
    resourceOriginsList: $('resource-origins-list'), resourceOriginInput: $('resource-origin-input'), resourceOriginAdd: $('resource-origin-add'),
    loopbackSuggestion: $('loopback-suggestion'), allowAllBrowserOrigins: $('allow-all-browser-origins'), allowAllApplications: $('allow-all-applications'), allowLoopback: $('allow-loopback'), allowPrivateNetwork: $('allow-private-network'), allowPersonalData: $('allow-personal-data'),
    sessionIdleMinutes: $('session-idle-minutes'), browserHeadless: $('browser-headless'), browserProxyServer: $('browser-proxy-server'),
    sessionIdleEffective: $('session-idle-effective'), runtimeError: $('runtime-settings-error'), operationMode: $('operation-mode'), operationModeError: $('operation-mode-error'),
    privateNetworkSuggestion: $('private-network-suggestion'), browserProxyConnectHostname: $('browser-proxy-connect-hostname'),
    browserSetup: $('browser-setup'), browserSetupStatus: $('browser-setup-status'), browserHosts: $('browser-hosts'), browserRetry: $('browser-retry'),
    browserInstalled: $('browser-installed'), browserInstalledEmpty: $('browser-installed-empty'), browserCompat: $('browser-compat'), browserUseAuto: $('browser-use-auto'),
    desktopOsHint: $('desktop-os-hint'), desktopAppId: $('desktop-app-id'), desktopAppPath: $('desktop-app-path'), desktopBrowse: $('desktop-browse'), desktopSave: $('desktop-save'),
    desktopClear: $('desktop-clear'), desktopNotice: $('desktop-notice'), desktopError: $('desktop-error'), allowPhysicalInput: $('allow-physical-input'), allowUnredactedImages: $('allow-unredacted-images'),
    aiSummary: $('ai-summary'), aiSummaryExtra: $('ai-summary-extra'), siteGrants: $('site-grants'),
    setupChecklist: $('setup-checklist'), setupProgress: $('setup-progress'), setupDismiss: $('setup-dismiss'), setupReopen: $('setup-reopen'),
    grantsDetails: $('grants-details'), permissionsDetails: $('permissions-details'), advancedDetails: $('advanced-details'), desktopDetails: $('desktop-details'),
    clientsDetails: $('clients-details'), desktopState: $('desktop-state'), clientsState: $('clients-state')
  };
  const SETUP_STEPS = ['mcp', 'origin', 'tier'].map((name) => ({ name, item: $(`setup-step-${name}`), mark: $(`setup-mark-${name}`), state: $(`setup-state-${name}`), go: $(`setup-go-${name}`) }));
  const DESKTOP_CONTROLS = ['allowAllApplications', 'desktopAppId', 'desktopAppPath', 'desktopBrowse', 'desktopSave', 'desktopClear', 'allowPhysicalInput', 'allowUnredactedImages'];

  const set = (el, text) => setText(el, text);
  // A collapsed group opens by itself when a problem or an elevated grant appears inside it (once per appearance, so the user can close it again).
  const seenProblem = new Map();
  function openOnProblem(key, details, problem) {
    const was = seenProblem.get(key) === true;
    seenProblem.set(key, !!problem);
    if (problem && !was && details) details.open = true;
  }
  if (els.language) {
    els.language.value = uiLanguage;
    els.language.addEventListener('change', () => applyLanguage(els.language.value));
  }
  if (typeof document.querySelectorAll === 'function') {
    for (const option of document.querySelectorAll('option')) {
      const text = option.textContent;
      if (typeof text === 'string' && text.includes(' / ')) {
        localizedOptions.set(option, text); option.textContent = localize(text);
      }
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const key of ['aria-label', 'title', 'placeholder']) {
        const value = el.getAttribute(key); if (typeof value === 'string') setLocalizedAttribute(el, key, value);
      }
    }
  }
  const setBusy = (el, busy) => { if (el) { el.disabled = busy || el.dataset.locked === 'true'; el.setAttribute('aria-busy', busy ? 'true' : 'false'); } };

  let busy = {};
  // Revoke buttons of the standing-grant list currently on screen, and the localized nodes created with them.
  let grantButtons = [];
  let grantNodes = [];
  let grantTick = null;
  let currentOrigins = [];
  let currentResourceOrigins = [];
  // Desktop inputs are only overwritten from saved state while the user has no unsaved edit.
  let desktopDirty = false;
  let pickedNotes = [];
  let hostDesktopNotice = '';
  function markBusy(key, on) {
    busy[key] = on;
    const map = { enabled: ['enabled'], auto: ['autoUpdate'], check: ['checkUpdates'], checkNow: ['checkNow'], resume: ['resumeOperations'], clients: ['clientsEnable', 'clientsRefresh'], origins: ['originAdd', 'allowAllBrowserOrigins'], runtime: ['sessionIdleMinutes','browserHeadless','browserProxyServer','browserProxyConnectHostname'], operationMode:['operationMode'], desktop: DESKTOP_CONTROLS, browser: ['browserRetry','browserUseAuto'], grants: [] };
    (map[key] || []).forEach((name) => setBusy(els[name], on));
    if (key === 'grants') grantButtons.forEach((button) => setBusy(button, on));
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
      const status = document.createElement('span'); setText(status, labels[client.status] || String(client.status));
      li.appendChild(name); li.appendChild(status);
      if (client.message) li.title = String(client.message);
      els.clientsList.appendChild(li);
    }
    const clientsProblem = state.error || state.rows.filter(c => c.status === 'error' || c.status === 'conflict').map(c => `${c.name}: ${c.message}`).join('\n');
    set(els.clientsError, clientsProblem);
    openOnProblem('clients', els.clientsDetails, !!clientsProblem);
    if (state.busy) set(els.clientsStatus, 'AI クライアントを更新しています… / Updating AI clients…');
    else {
      const detected = state.rows.filter(c => c.detected).length;
      const configured = state.rows.filter(c => c.status === 'enabled').length;
      setTextParts(els.clientsStatus, [`${detected} 件を検出 / ${detected} detected`, `${configured} 件に登録済み / ${configured} configured`]);
      set(els.clientsState, `${configured} 件に登録済み / ${configured} configured`);
    }
    setBusy(els.clientsEnable, !!state.busy || !!busy.clients);
    setBusy(els.clientsRefresh, !!state.busy || !!busy.clients);
    // Disabling remains available while another operation is preparing.
  }

  function renderOriginList(list, origins, type, label) {
    if (!list) return;
    const current = Array.isArray(origins) ? origins.filter(value => typeof value === 'string').slice() : [];
    list.textContent = '';
    for (const origin of current) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = origin;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = '削除 / Remove';
      setText(remove, '削除 / Remove');
      setLocalizedAttribute(remove, 'aria-label', `許可元を削除 / Remove ${label} ${origin}`);
      remove.addEventListener('click', () => {
        const next = current.slice(); next.splice(next.indexOf(origin), 1);
        send({ type, origins: next }, 'origins');
      });
      li.appendChild(name); li.appendChild(remove); list.appendChild(li);
    }
    return current;
  }
  function renderOrigins(origins) {
    currentOrigins = renderOriginList(els.originsList, origins, 'setBrowserOrigins', 'origin') || [];
  }
  function renderResourceOrigins(origins) {
    currentResourceOrigins = renderOriginList(els.resourceOriginsList, origins, 'setBrowserResourceOrigins', 'resource origin') || [];
  }
  // Which grant the typed origin would need: only exact http(s) origins count, and a hint disappears once its grant is on.
  const isPrivateHost = (host) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (m) { const a = Number(m[1]), b = Number(m[2]); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
    return /^\[f[cd][0-9a-f]{2}:/i.test(host);
  };
  // The origin of a string that is exactly an http(s) origin (optional trailing slash); '' otherwise.
  function exactOrigin(raw) {
    try {
      const url = new URL(raw);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) return '';
      return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(raw) ? url.origin : '';
    } catch { return ''; }
  }
  function suggestLoopback() {
    const raw = String(els.originInput?.value || '').trim();
    let host = '';
    try { if (exactOrigin(raw)) host = new URL(raw).hostname.toLowerCase(); } catch { host = ''; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (els.loopbackSuggestion) els.loopbackSuggestion.hidden = !loopback || els.allowLoopback?.checked === true;
    if (els.privateNetworkSuggestion) els.privateNetworkSuggestion.hidden = loopback || !host || !isPrivateHost(host) || els.allowPrivateNetwork?.checked === true;
    // The hints point at the toggles in "More grants": show them when a suggestion appears.
    openOnProblem('suggest', els.grantsDetails, els.loopbackSuggestion?.hidden === false || els.privateNetworkSuggestion?.hidden === false);
  }
  // A successful add clears the input; a rejected one keeps it so the text can be corrected.
  const pendingAdd = { origin: '', resource: '' };
  function settleAdd(kind, input, origins) {
    const value = pendingAdd[kind];
    if (!value || busy.origins === true) return;
    pendingAdd[kind] = '';
    const added = exactOrigin(value);
    if (added && Array.isArray(origins) && origins.includes(added) && input && String(input.value).trim() === value) input.value = '';
  }

  const PERMS = [['origins', 'ブラウザの許可元 / Browser origins'], ['app', 'ネイティブアプリ / Native app'], ['operations', '全操作 / All operations'], ['physical', '物理入力 / Physical input'], ['images', '無加工ネイティブ画像 / Unredacted native images'], ['loopback', 'ループバック / Loopback'], ['private', 'プライベート網 / Private network'], ['mode','操作段階 / Operation tier']];
  const OFF = {origins: 'なし / none', app: 'なし / none', operations: '許可リストのみ / allowlists only', physical: 'オフ / off', images: '無効 / disabled', loopback: 'オフ / off', private: 'オフ / off'};
  // Concise bilingual summary; all text lands through textContent.
  function renderPermissions(p) {
    if (!els.permissions || !p || typeof p !== 'object' || typeof document.createElement !== 'function') return;
    const requested = p.requested || p;
    p = p.effective || p;
    const flags = {'operations':'allowAllOperations','physical':'allowPhysicalInput','images':'allowUnredactedImages','loopback':'allowLoopback','private':'allowPrivateNetwork'};
    const value = (key) => key === 'mode' ? ({read_only:'読み取り専用 / read only',standard:'標準 / standard',ask:'都度承認 / ask each time',all:'すべて許可 / all operations'}[p.operationMode] || 'unknown')
      : key === 'origins' ? (p.allowAllBrowserOrigins ? 'すべてのURL / all URLs' : Array.isArray(p.browserOrigins) && p.browserOrigins.length ? p.browserOrigins.join(', ') : OFF.origins)
      : key === 'app' ? (p.allowAllApplications ? 'すべてのアプリ / all apps' : p.desktopAppId || OFF.app)
      : p[flags[key]] ? '有効 / on' : OFF[key];
    els.permissions.textContent = '';
    for (const [key, label] of PERMS) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'perm-label'; setText(a, label);
      const b = document.createElement('span'); b.className = 'perm-value'; setText(b, String(value(key)) + (requested[flags[key]] === true && p[flags[key]] !== true ? '（要求 on / requested on）' : ''));
      li.appendChild(a); li.appendChild(b); els.permissions.appendChild(li);
    }
    const hint = p.allowAllBrowserOrigins || p.allowAllApplications || (Array.isArray(p.browserOrigins) && p.browserOrigins.length) || p.desktopAppId ? '許可された範囲のみ利用できます。 / Only granted scopes are usable.' : 'MCP を有効にしても権限は付きません。 / Enabling MCP alone grants nothing.';
    if (els.permissionsHint) setTextParts(els.permissionsHint, [hint, ...(Array.isArray(p.reasons) ? p.reasons : [])]);
  }
  const HOST_NOTES = { 'cdn.playwright.dev': 'Chromium 本体と補助ファイル / Chromium and helpers', 'playwright.download.prss.microsoft.com': '補助ファイルのミラー / mirror for helper files' };
  const majorOf = (version) => { const m = /^(\d+)\./.exec(String(version || '')); return m ? m[1] : ''; };
  // Browser setup failure panel: the hosts the download needs, a retry, and installed browsers that could stand in. Text only.
  function renderBrowserSetup(b) {
    if (!els.browserSetup || !b || typeof b !== 'object') return;
    const using = b.using && typeof b.using === 'object' ? b.using : null;
    const visible = b.failed === true || !!using;
    els.browserSetup.hidden = !visible;
    if (!visible) return;
    const busyNow = b.preparing === true || busy.browser === true;
    if (using) setTextParts(els.browserSetupStatus, ['インストール済みのブラウザを使用中: / Using the installed browser:', String(using.label || ''), String(using.version || ''), String(using.path || '')].filter(Boolean));
    else set(els.browserSetupStatus, b.preparing === true ? 'ブラウザを準備しています… / Preparing the browser…' : 'ブラウザを自動で準備できませんでした。下の接続先に届くか確認して再試行するか、インストール済みのブラウザを使ってください。 / The browser could not be prepared automatically. Check that the hosts below are reachable and retry, or use an installed browser.');
    if (els.browserHosts) {
      els.browserHosts.textContent = '';
      for (const host of Array.isArray(b.hosts) ? b.hosts : []) {
        if (typeof host !== 'string') continue;
        const li = document.createElement('li');
        const name = document.createElement('span'); name.textContent = host;
        const note = document.createElement('span'); setText(note, HOST_NOTES[host] || 'カスタム取得先 / custom download host');
        li.appendChild(name); li.appendChild(note); els.browserHosts.appendChild(li);
      }
    }
    setBusy(els.browserRetry, busyNow);
    if (els.browserUseAuto) { els.browserUseAuto.hidden = !using; setBusy(els.browserUseAuto, busyNow); }
    const installed = Array.isArray(b.installed) ? b.installed.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [];
    if (els.browserInstalledEmpty) els.browserInstalledEmpty.hidden = installed.length > 0 || !!using;
    const expected = b.expected && typeof b.expected === 'object' ? b.expected : {};
    if (els.browserInstalled) {
      els.browserInstalled.textContent = '';
      for (const item of installed) {
        const li = document.createElement('li'); li.className = 'browser-item';
        const head = document.createElement('span'); head.className = 'browser-name'; head.textContent = [item.label, item.version].filter(v => typeof v === 'string' && v).join(' ');
        const where = document.createElement('span'); where.className = 'browser-path'; where.textContent = String(item.path || '');
        li.appendChild(head); li.appendChild(where);
        const expectedMajor = majorOf(expected.chromium), actualMajor = majorOf(item.version);
        if (item.usable === true && expectedMajor && actualMajor && expectedMajor !== actualMajor) {
          const warn = document.createElement('span'); warn.className = 'browser-note';
          setText(warn, `メジャーバージョンが検証版（${expectedMajor}）と異なります。 / Its major version differs from the tested ${expectedMajor}.`);
          li.appendChild(warn);
        }
        if (item.usable === true) {
          const use = document.createElement('button'); use.type = 'button'; use.className = 'secondary';
          setText(use, 'このブラウザを使う / Use this browser');
          use.disabled = busyNow || (!!using && using.id === item.id);
          use.addEventListener('click', () => send({ type: 'useInstalledBrowser', id: item.id }, 'browser'));
          li.appendChild(use);
        } else if (typeof item.note === 'string' && item.note) {
          const note = document.createElement('span'); note.className = 'browser-note'; setText(note, item.note); li.appendChild(note);
        }
        els.browserInstalled.appendChild(li);
      }
    }
    if (els.browserCompat) {
      const pw = typeof expected.playwright === 'string' && expected.playwright ? expected.playwright : '', chromium = typeof expected.chromium === 'string' ? expected.chromium : '', revision = typeof expected.revision === 'string' ? expected.revision : '';
      const tested = chromium ? `Chromium ${chromium}${revision ? `（リビジョン ${revision}）` : ''}` : '同梱の Chromium';
      const testedEn = chromium ? `Chromium ${chromium}${revision ? ` (revision ${revision})` : ''}` : 'the bundled Chromium';
      set(els.browserCompat, `互換性の注意: AgentDeskLink${pw ? `（Playwright ${pw}）` : ''}は ${tested} で検証しています。インストール済みブラウザは別のバージョンでも動くことが多いものの、保証はなく、メジャーバージョンが大きく違うと起動や操作に失敗することがあります。 / Compatibility: AgentDeskLink${pw ? ` (Playwright ${pw})` : ''} is tested with ${testedEn}. An installed browser of another version often works but is not guaranteed; a very different major version may fail to start or behave differently.`);
    }
  }
  const OS_HINTS = {
    darwin: 'macOS: アプリ ID は Bundle Identifier（例: com.apple.calculator）、パスは .app の中の Contents/MacOS/<実行ファイル> です。「参照…」で .app を選ぶと自動で解決し、ID も提案します。 / macOS: the app ID is the bundle identifier (for example com.apple.calculator) and the path is Contents/MacOS/<executable> inside the .app. Browse… resolves a selected .app for you and suggests the ID.',
    win32: 'Windows: アプリ ID は AI に見せる名前（ラベル）で、128 文字以内で自由に付けられます。実際の対象は .exe のフルパスで固定されます。 / Windows: the app ID is the label shown to the AI (up to 128 characters, your choice). The app itself is pinned by the exact path of its .exe.',
    linux: 'Linux: アプリ ID は AT-SPI のアプリケーション名、パスは実行ファイルの絶対パス（readlink /proc/<pid>/exe の結果。Python 製アプリはインタープリターのパス）です。 / Linux: the app ID is the AT-SPI application name and the path is the absolute path of the executable (the result of readlink /proc/<pid>/exe; for Python apps, the interpreter).'
  };
  function renderDesktopNotice() { setTextParts(els.desktopNotice, [hostDesktopNotice, ...(desktopDirty ? pickedNotes : [])].filter(Boolean)); }
  function renderDesktop(settings, platform) {
    if (els.desktopOsHint) set(els.desktopOsHint, OS_HINTS[platform] || 'アプリ ID と実行ファイルの絶対パスを指定します。 / Enter the app ID and the absolute path of the executable.');
    if (settings) {
      const id = typeof settings.desktopAppId === 'string' ? settings.desktopAppId : '', file = typeof settings.desktopAppPath === 'string' ? settings.desktopAppPath : '';
      // Saved values win once they equal what is typed; until then an unsaved edit is kept.
      if (els.desktopAppId && els.desktopAppPath) {
        if (desktopDirty && els.desktopAppId.value.trim() === id && els.desktopAppPath.value.trim() === file) desktopDirty = false;
        if (!desktopDirty) { els.desktopAppId.value = id; els.desktopAppPath.value = file; }
      }
      if (els.allowPhysicalInput && typeof settings.allowPhysicalInput === 'boolean') els.allowPhysicalInput.checked = settings.allowPhysicalInput;
      if (els.allowUnredactedImages && typeof settings.allowUnredactedImages === 'boolean') els.allowUnredactedImages.checked = settings.allowUnredactedImages;
    }
    renderDesktopNotice();
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
    pendingAdd.origin = value;
    send({ type: 'setBrowserOrigins', origins: [...currentOrigins, value] }, 'origins');
  });
  if (els.originInput) {
    els.originInput.addEventListener('input', suggestLoopback);
    els.originInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); els.originAdd?.click(); } });
  }
  if (els.resourceOriginAdd) els.resourceOriginAdd.addEventListener('click', () => {
    const value = String(els.resourceOriginInput?.value || '').trim();
    if (!value) return;
    pendingAdd.resource = value;
    send({ type: 'setBrowserResourceOrigins', origins: [...currentResourceOrigins, value] }, 'origins');
  });
  if (els.resourceOriginInput) els.resourceOriginInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); els.resourceOriginAdd?.click(); } });
  if (els.allowAllBrowserOrigins) els.allowAllBrowserOrigins.addEventListener('change', () => send({type:'setAllowAllBrowserOrigins',enabled:els.allowAllBrowserOrigins.checked},'origins'));
  if (els.allowAllApplications) els.allowAllApplications.addEventListener('change', () => send({type:'setAllowAllApplications',enabled:els.allowAllApplications.checked},'desktop'));
  if (els.allowLoopback) els.allowLoopback.addEventListener('change', () => { suggestLoopback(); send({type:'setAllowLoopback',enabled:els.allowLoopback.checked},'origins'); });
  if (els.allowPrivateNetwork) els.allowPrivateNetwork.addEventListener('change', () => { suggestLoopback(); send({type:'setAllowPrivateNetwork',enabled:els.allowPrivateNetwork.checked},'origins'); });
  if (els.allowPersonalData) els.allowPersonalData.addEventListener('change', () => send({type:'setAllowPersonalData',enabled:els.allowPersonalData.checked},'origins'));
  if (els.sessionIdleMinutes) els.sessionIdleMinutes.addEventListener('change', () => {
    const minutes=Number(els.sessionIdleMinutes.value);
    if (Number.isInteger(minutes)) send({ type: 'setSessionIdleMinutes', minutes }, 'runtime');
  });
  if (els.browserHeadless) els.browserHeadless.addEventListener('change', () => send({type:'setBrowserHeadless',enabled:els.browserHeadless.checked},'runtime'));
  if (els.browserProxyServer) els.browserProxyServer.addEventListener('change', () => send({type:'setBrowserProxyServer',proxy:String(els.browserProxyServer.value)},'runtime'));
  if (els.browserProxyConnectHostname) els.browserProxyConnectHostname.addEventListener('change', () => send({type:'setBrowserProxyConnectByHostname',enabled:els.browserProxyConnectHostname.checked},'runtime'));
  if (els.allowPhysicalInput) els.allowPhysicalInput.addEventListener('change', () => send({type:'setAllowPhysicalInput',enabled:els.allowPhysicalInput.checked},'desktop'));
  if (els.allowUnredactedImages) els.allowUnredactedImages.addEventListener('change', () => send({type:'setAllowUnredactedImages',enabled:els.allowUnredactedImages.checked},'desktop'));
  if (els.browserRetry) els.browserRetry.addEventListener('click', () => send({ type: 'retryBrowserSetup' }, 'browser'));
  if (els.browserUseAuto) els.browserUseAuto.addEventListener('click', () => send({ type: 'clearInstalledBrowser' }, 'browser'));
  if (els.desktopBrowse) els.desktopBrowse.addEventListener('click', () => post({ type: 'browseDesktopApp' }));
  if (els.desktopSave) els.desktopSave.addEventListener('click', () => { pickedNotes = []; send({ type: 'setDesktopApp', appId: String(els.desktopAppId?.value || '').trim(), appPath: String(els.desktopAppPath?.value || '').trim() }, 'desktop'); });
  if (els.desktopClear) els.desktopClear.addEventListener('click', () => {
    if (els.desktopAppId) els.desktopAppId.value = '';
    if (els.desktopAppPath) els.desktopAppPath.value = '';
    desktopDirty = true; pickedNotes = [];
    send({ type: 'setDesktopApp', appId: '', appPath: '' }, 'desktop');
  });
  for (const input of [els.desktopAppId, els.desktopAppPath]) if (input) {
    input.addEventListener('input', () => { desktopDirty = true; });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); els.desktopSave?.click(); } });
  }
  if (els.operationMode) els.operationMode.addEventListener('change', () => send({type:'setOperationMode',mode:String(els.operationMode.value)},'operationMode'));

  // ---- "What the AI can do now" summary and first-run checklist ----
  // Presentation only: both are derived from the state the host already posts and never change a setting.
  // Capabilities come from the effective permissions when present, so nothing is claimed that the state does not grant.
  const MODES = ['read_only', 'standard', 'ask', 'all'];
  const model = { settings: null, perms: null, stopped: null, workspaceOk: null, mcpError: '', runtimeError: '', desktopError: '', grants: [] };
  const uiState = (() => {
    try { const saved = vscode && typeof vscode.getState === 'function' ? vscode.getState() : null; return saved && typeof saved === 'object' ? { ...saved } : {}; }
    catch { return {}; }
  })();
  let setupDismissed = uiState.setupDismissed === true;
  // Webview state API (not a setting): survives the sidebar being hidden and shown again.
  function rememberUi(patch) {
    Object.assign(uiState, patch);
    try { if (vscode && typeof vscode.setState === 'function') vscode.setState({ ...uiState }); } catch { /* state API unavailable */ }
  }
  const plain = (value) => String(value ?? '').replace(/ \/ /g, '/');
  const effective = () => { const p = model.perms; return p && typeof p === 'object' ? (p.effective && typeof p.effective === 'object' ? p.effective : p) : null; };
  const flag = (key) => { const eff = effective(); return eff && typeof eff[key] === 'boolean' ? eff[key] : !!(model.settings && model.settings[key] === true); };
  const grantedOrigins = () => {
    const eff = effective(), own = model.settings;
    const list = eff && Array.isArray(eff.browserOrigins) ? eff.browserOrigins : own && Array.isArray(own.browserOrigins) ? own.browserOrigins : [];
    return list.filter(value => typeof value === 'string' && value);
  };
  const currentMode = () => {
    const eff = effective();
    if (eff && (eff.operationMode === 'all' || eff.allowAllOperations === true)) return 'all';
    if (eff && MODES.includes(eff.operationMode)) return eff.operationMode;
    return model.settings && MODES.includes(model.settings.operationMode) ? model.settings.operationMode : 'read_only';
  };
  const siteName = (origin) => plain(origin).replace(/^https:\/\//i, '').replace(/\/$/, '');
  function sitesText(origins) {
    const names = origins.map(siteName), shown = names.slice(0, 2), more = names.length - shown.length;
    return { ja: shown.join('、') + (more > 0 ? ` ほか ${more} 件` : ''), en: shown.join(', ') + (more > 0 ? ` and ${more} more` : '') };
  }
  // Standing site-write grants the host reports; the host drops them at the end, and the 30 s tick below hides one that ran out in between.
  const liveGrants = () => model.grants.filter((grant) => grant.expires_at > Date.now());
  const validGrant = (grant) => !!grant && typeof grant === 'object' && typeof grant.id === 'string' && typeof grant.origin === 'string' && grant.origin !== '' && Number.isFinite(grant.expires_at) && Number.isFinite(grant.uses);
  function renderSiteGrants() {
    if (!els.siteGrants) return;
    if (grantTick !== null) { clearTimeout(grantTick); grantTick = null; }
    // Every use of a grant republishes the list; keep keyboard focus on the same grant's button across the re-render.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.grantId : undefined;
    for (const node of grantNodes) { localizedNodes.delete(node); localizedAttributes.delete(node); }
    grantNodes = []; grantButtons = [];
    els.siteGrants.textContent = '';
    const live = liveGrants();
    for (const grant of live) {
      const minutes = Math.max(0, Math.ceil((grant.expires_at - Date.now()) / 60000)), uses = Math.max(0, Math.trunc(grant.uses));
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = grant.origin;
      const state = document.createElement('span'); setText(state, `残り ${minutes} 分・${uses} 回使用 / ${minutes} min left, used ${uses} times`);
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'secondary'; revoke.dataset.grantId = grant.id;
      setText(revoke, '取り消す / Revoke');
      setLocalizedAttribute(revoke, 'aria-label', `書き込みの継続許可を取り消す / Revoke standing write grant ${grant.origin}`);
      setBusy(revoke, busy.grants === true);
      revoke.addEventListener('click', () => send({ type: 'revokeSiteGrant', id: grant.id }, 'grants'));
      grantNodes.push(state, revoke); grantButtons.push(revoke);
      li.appendChild(name); li.appendChild(state); li.appendChild(revoke); els.siteGrants.appendChild(li);
    }
    els.siteGrants.hidden = live.length === 0;
    const again = focused ? grantButtons.find((button) => button.dataset.grantId === focused) : undefined;
    if (again && typeof again.focus === 'function') again.focus();
    // Remaining minutes are rounded up and refreshed every 30 s while a grant is listed (a chained timeout, so nothing keeps running once the list is empty).
    if (live.length > 0) grantTick = setTimeout(() => { grantTick = null; renderSiteGrants(); renderSummary(); }, 30000);
  }
  function summarize() {
    if (model.stopped === true) return { ja: '緊急停止中です。操作を再開するまで、AI は何も実行できません。', en: 'Emergency stop is active. The AI cannot do anything until you resume operations.' };
    const s = model.settings;
    if (!s || typeof s.enabled !== 'boolean') return null;
    if (model.workspaceOk === false) return { ja: '信頼済みのフォルダーを開くまで MCP は使えません。AI は何もできません。', en: 'MCP is unavailable until a trusted folder is open, so the AI can do nothing.' };
    if (!s.enabled) return { ja: 'このワークスペースでは MCP が無効です。AI は何もできません。', en: 'MCP is off in this workspace, so the AI can do nothing.' };
    if (model.mcpError) return { ja: 'MCP の設定に問題があります。下のメッセージを解消するまで、AI の権限は確定しません。', en: 'There is a problem with the MCP configuration. The AI\'s access is not settled until the message below is resolved.' };
    const origins = grantedOrigins();
    if (!origins.length && !flag('allowAllBrowserOrigins')) return { ja: 'MCP は有効ですが、許可された Web サイトがないため、AI はブラウザーを操作できません。', en: 'MCP is on, but no websites are allowed, so the AI cannot use the browser.' };
    const sites = flag('allowAllBrowserOrigins') ? {ja:'すべてのWebサイト',en:'all websites'} : sitesText(origins), mode = currentMode();
    if (mode === 'all') return { ja: `AI は ${sites.ja} で、確認なしにあらゆる操作（送信・削除・購入・認証情報の入力を含む）を実行できます（全操作）。`, en: `The AI can perform any action on ${sites.en} without asking, including submitting forms, deleting, buying and entering credentials (all operations).` };
    if (mode === 'ask') {
      const text = { ja: `ブラウザーでは ${sites.ja} を閲覧し、通常のクリックや入力ができます。送信などの重要な操作と、ページが保存のために送る通信は、VS Code の確認画面で内容を承認した場合のみ実行されます。デスクトップでは通常操作を実行でき、削除や送信などの重要なネイティブ操作の前に確認します。通常操作に伴う保存や自動保存は発生することがあります（都度承認）。`, en: `In the browser, the AI can view ${sites.en} and use ordinary controls. Consequential actions such as submitting, and requests the page sends to save data, run only after you approve them in VS Code. On desktop, ordinary actions remain available; approval is requested before consequential native actions such as delete or send. Ordinary desktop actions may save or autosave data (ask each time).` };
      // A standing grant is only ever created by the host's approval dialog; it is named here so the sentence stays true while one is active.
      const n = liveGrants().length;
      if (n > 0) {
        text.ja += ` いま ${n} 件のサイトで、書き込み通信を確認なしに送る継続許可が有効です（最長 30 分。認証情報を含む通信と購入・支払いに関わる操作は毎回確認）。`;
        text.en += ` Standing write permission is active for ${n} ${n === 1 ? 'site' : 'sites'} (up to 30 minutes; credential and payment-like requests still ask).`;
      }
      return text;
    }
    if (mode === 'standard') return { ja: `ブラウザーでは ${sites.ja} を閲覧し、通常のクリックや入力ができます。送信などの重要な操作と、ページが保存のために送る通信はブロックされるため、変更を保存できない場合があります。デスクトップでは通常操作を実行でき、保存や自動保存が発生することがあります（標準）。`, en: `In the browser, the AI can view ${sites.en} and use ordinary controls. Consequential actions such as submitting and requests the page sends to save data are blocked, so changes may not be saved. On desktop, ordinary actions remain available and may save or autosave data (standard).` };
    return { ja: `AI は ${sites.ja} を閲覧できます。クリックや入力はできません（読み取り専用）。`, en: `The AI can view ${sites.en}. It cannot click or type (read only).` };
  }
  // Grants outside the browser sentence that are on right now, so they stay visible while their toggles sit in collapsed groups.
  function extraGrants() {
    const s = model.settings;
    if (!s || s.enabled !== true || model.stopped === true || model.workspaceOk === false || model.mcpError) return null;
    const eff = effective() || {}, ja = [], en = [];
    const app = typeof eff.desktopAppId === 'string' ? eff.desktopAppId : '';
    if (flag('allowAllApplications')) { ja.push('すべてのデスクトップアプリ'); en.push('all desktop applications'); }
    else if (app) { ja.push(`デスクトップアプリ ${plain(app)}`); en.push(`desktop app ${plain(app)}`); }
    if (flag('allowPhysicalInput')) { ja.push('物理入力'); en.push('physical input'); }
    if (flag('allowUnredactedImages')) { ja.push('無加工のネイティブ画像'); en.push('unredacted native images'); }
    if (flag('allowLoopback')) { ja.push('ループバック'); en.push('loopback'); }
    if (flag('allowPrivateNetwork')) { ja.push('プライベートネットワーク'); en.push('private network'); }
    if (flag('allowPersonalData')) { ja.push('個人データの表示'); en.push('revealing personal data'); }
    return ja.length ? { ja: `ほかに有効な設定: ${ja.join('、')}。`, en: `Also on: ${en.join(', ')}.` } : null;
  }
  function renderSummary() {
    const text = summarize();
    if (text) set(els.aiSummary, `${text.ja} / ${text.en}`);
    const extra = text ? extraGrants() : null;
    if (els.aiSummaryExtra) { set(els.aiSummaryExtra, extra ? `${extra.ja} / ${extra.en}` : ''); els.aiSummaryExtra.hidden = !extra; }
  }
  const SETUP_DONE = { mcp: () => !!model.settings && model.settings.enabled === true, origin: () => flag('allowAllBrowserOrigins') || grantedOrigins().length > 0, tier: () => !!model.settings && (currentMode() !== 'read_only' || model.settings.operationModeConfirmed === true) };
  function renderSetup() {
    const known = model.settings !== null || model.perms !== null;
    const done = SETUP_STEPS.map((step) => !!SETUP_DONE[step.name]());
    const count = done.filter(Boolean).length, complete = count === done.length;
    SETUP_STEPS.forEach((step, index) => {
      if (step.mark) step.mark.textContent = done[index] ? '✓' : '○';
      set(step.state, done[index] ? '完了 / Done' : '未完了 / To do');
      if (step.item && step.item.dataset) step.item.dataset.done = done[index] ? 'true' : 'false';
      if (step.go) step.go.hidden = done[index];
    });
    set(els.setupProgress, `${count}/${done.length} 完了 / ${count} of ${done.length} done`);
    if (els.setupChecklist) els.setupChecklist.hidden = !known || complete || setupDismissed;
    if (els.setupReopen) els.setupReopen.hidden = !known || complete || !setupDismissed;
  }
  // Open any collapsed group around the control, scroll it into view and move keyboard focus to it.
  function focusControl(el) {
    if (!el) return;
    const group = typeof el.closest === 'function' ? el.closest('details') : null;
    if (group) group.open = true;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') el.focus();
  }
  const SETUP_TARGET = { mcp: () => els.enabled, origin: () => els.originInput, tier: () => els.operationMode };
  for (const step of SETUP_STEPS) if (step.go) step.go.addEventListener('click', () => focusControl(SETUP_TARGET[step.name]()));
  if (els.setupDismiss) els.setupDismiss.addEventListener('click', () => {
    setupDismissed = true; rememberUi({ setupDismissed: true }); renderSetup();
    if (els.setupReopen && !els.setupReopen.hidden && typeof els.setupReopen.focus === 'function') els.setupReopen.focus();
  });
  if (els.setupReopen) els.setupReopen.addEventListener('click', () => {
    setupDismissed = false; rememberUi({ setupDismissed: false }); renderSetup();
    const next = SETUP_STEPS.find((step) => step.go && !step.go.hidden), target = next ? next.go : els.setupDismiss;
    if (target && typeof target.focus === 'function') target.focus();
  });
  function renderGroups() {
    const eff = effective() || {}, saved = model.settings || {};
    openOnProblem('reasons', els.permissionsDetails, Array.isArray(eff.reasons) && eff.reasons.length > 0);
    openOnProblem('grants', els.grantsDetails, flag('allowLoopback') || flag('allowPrivateNetwork') || flag('allowPersonalData'));
    openOnProblem('desktop', els.desktopDetails, saved.allowPhysicalInput === true || saved.allowUnredactedImages === true || !!model.desktopError);
    openOnProblem('runtime', els.advancedDetails, !!model.runtimeError);
    if (typeof saved.desktopAppId === 'string') set(els.desktopState, saved.desktopAppId ? plain(saved.desktopAppId) : '未設定 / Not set');
  }

  window.addEventListener('message', (event) => {
    const s = event.data;
    if (s && typeof s === 'object' && s.type === 'desktopAppPicked') {
      // Browse only fills the inputs; the user still presses Save.
      if (els.desktopAppPath && typeof s.appPath === 'string') els.desktopAppPath.value = s.appPath;
      if (els.desktopAppId && typeof s.appId === 'string' && s.appId && (s.replaceId === true || !String(els.desktopAppId.value).trim())) els.desktopAppId.value = s.appId;
      desktopDirty = true; pickedNotes = Array.isArray(s.notes) ? s.notes.filter(note => typeof note === 'string') : [];
      renderDesktopNotice();
      return;
    }
    if (!s || typeof s !== 'object' || s.type !== 'state') return;
    if (s.settings && typeof s.settings === 'object') model.settings = { ...(model.settings || {}), ...s.settings };
    if (s.permissions && typeof s.permissions === 'object') model.perms = s.permissions;
    if (typeof s.stopped === 'boolean') model.stopped = s.stopped;
    if (typeof s.trusted === 'boolean' || typeof s.hasFolder === 'boolean') model.workspaceOk = s.trusted !== false && s.hasFolder !== false;
    if (s.status && typeof s.status === 'object') {
      model.mcpError = typeof s.status.mcpError === 'string' ? s.status.mcpError : '';
      model.runtimeError = typeof s.status.runtimeError === 'string' ? s.status.runtimeError : '';
      model.desktopError = typeof s.status.desktopError === 'string' ? s.status.desktopError : '';
    }
    if (s.busy) Object.keys(s.busy).forEach((k) => markBusy(k, !!s.busy[k]));
    if (typeof s.trusted === 'boolean' || typeof s.hasFolder === 'boolean') {
      const workspaceOk = s.trusted !== false && s.hasFolder !== false;
      if (els.enabled) els.enabled.dataset.locked = workspaceOk ? 'false' : 'true';
      if (els.enabled) els.enabled.disabled = busy.enabled === true || !workspaceOk;
      if (els.clientsEnable) { els.clientsEnable.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.clientsEnable, !!busy.clients); }
      if (els.enabledHint) set(els.enabledHint, workspaceOk ? '変更はこのワークスペースに保存されます。 / Changes are saved to this workspace.' : '信頼済みワークスペースで利用できます。 / Open a trusted workspace to change this.');
      if (els.originAdd) { els.originAdd.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.originAdd, !!busy.origins); }
      if (els.originInput) els.originInput.disabled = !workspaceOk || busy.origins === true;
      if (els.resourceOriginAdd) { els.resourceOriginAdd.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(els.resourceOriginAdd, !!busy.origins); }
      if (els.resourceOriginInput) els.resourceOriginInput.disabled = !workspaceOk || busy.origins === true;
      for (const grant of [els.allowAllBrowserOrigins, els.allowLoopback, els.allowPrivateNetwork, els.allowPersonalData]) if (grant) { grant.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(grant, !!busy.origins); }
      if (els.sessionIdleMinutes) { els.sessionIdleMinutes.dataset.locked=workspaceOk?'false':'true'; setBusy(els.sessionIdleMinutes,!!busy.runtime); }
      if (els.browserHeadless) { els.browserHeadless.dataset.locked=workspaceOk?'false':'true'; setBusy(els.browserHeadless,!!busy.runtime); }
      if (els.browserProxyServer) { els.browserProxyServer.dataset.locked=workspaceOk?'false':'true'; setBusy(els.browserProxyServer,!!busy.runtime); }
      if (els.browserProxyConnectHostname) { els.browserProxyConnectHostname.dataset.locked=workspaceOk?'false':'true'; setBusy(els.browserProxyConnectHostname,!!busy.runtime); }
      if (els.operationMode) { els.operationMode.dataset.locked=workspaceOk?'false':'true'; setBusy(els.operationMode,!!busy.operationMode); }
      for (const name of DESKTOP_CONTROLS) if (els[name]) { els[name].dataset.locked=workspaceOk?'false':'true'; setBusy(els[name],!!busy.desktop); }
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
      renderResourceOrigins(s.settings.browserResourceOrigins);
      settleAdd('origin', els.originInput, s.settings.browserOrigins);
      settleAdd('resource', els.resourceOriginInput, s.settings.browserResourceOrigins);
      if (els.allowAllBrowserOrigins && typeof s.settings.allowAllBrowserOrigins === 'boolean') els.allowAllBrowserOrigins.checked=s.settings.allowAllBrowserOrigins;
      if (els.allowAllApplications && typeof s.settings.allowAllApplications === 'boolean') els.allowAllApplications.checked=s.settings.allowAllApplications;
      if (els.allowLoopback && typeof s.settings.allowLoopback === 'boolean') els.allowLoopback.checked = s.settings.allowLoopback;
      if (els.allowPrivateNetwork && typeof s.settings.allowPrivateNetwork === 'boolean') els.allowPrivateNetwork.checked = s.settings.allowPrivateNetwork;
      if (els.allowPersonalData && typeof s.settings.allowPersonalData === 'boolean') els.allowPersonalData.checked = s.settings.allowPersonalData;
      suggestLoopback();
      if (els.sessionIdleMinutes && typeof s.settings.sessionIdleMinutes === 'number') {
        els.sessionIdleMinutes.value = String(s.settings.sessionIdleMinutes);
      }
      if (els.browserHeadless && typeof s.settings.browserHeadless === 'boolean') els.browserHeadless.checked=s.settings.browserHeadless;
      if (els.browserProxyServer && typeof s.settings.browserProxyServer === 'string') els.browserProxyServer.value=s.settings.browserProxyServer;
      if (els.browserProxyConnectHostname && typeof s.settings.browserProxyConnectByHostname === 'boolean') els.browserProxyConnectHostname.checked=s.settings.browserProxyConnectByHostname;
      if (els.operationMode && typeof s.settings.operationMode==='string') {
        const effectiveMode=s.permissions?.effective?.operationMode;
        els.operationMode.value=effectiveMode==='all'?'all':s.settings.operationMode;
      }
      if (typeof s.settings.sessionIdleMinutes==='number'&&typeof s.settings.browserHeadless==='boolean') {
        const m=s.settings.sessionIdleMinutes,headless=s.settings.browserHeadless,proxyUrl=s.settings.browserProxyServer||'',byHost=!!proxyUrl&&s.settings.browserProxyConnectByHostname===true;
        const ja=`有効値: ${m} 分、${headless?'ヘッドレス':'画面あり'}、プロキシ: ${proxyUrl||'なし'}${byHost?'（CONNECT はホスト名）':''}`;
        const en=`Effective: ${m} minutes; ${headless?'headless':'headful'}; proxy: ${proxyUrl||'none'}${byHost?' (CONNECT by hostname)':''}`;
        set(els.sessionIdleEffective,`${ja} / ${en}`);
      }
    }
    if (s.settings || typeof s.platform === 'string') renderDesktop(s.settings, s.platform);
    if (s.browser) renderBrowserSetup(s.browser);
    if (s.permissions) renderPermissions(s.permissions);
    if (Array.isArray(s.grants)) { model.grants = s.grants.filter(validGrant); renderSiteGrants(); }
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
      set(els.desktopError, s.status.desktopError || '');
      hostDesktopNotice = typeof s.status.desktopNotice === 'string' ? s.status.desktopNotice : '';
      renderDesktopNotice();
      set(els.mcpError, s.status.mcpError || '');
    }
    renderSummary();
    renderSetup();
    renderGroups();
  });

  post({ type: 'ready' });
})();
