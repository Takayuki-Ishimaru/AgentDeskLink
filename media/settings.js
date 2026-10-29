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
    loopbackSuggestion: $('loopback-suggestion'), allowLoopback: $('allow-loopback'), allowPrivateNetwork: $('allow-private-network'), allowPersonalData: $('allow-personal-data'),
    sessionIdleMinutes: $('session-idle-minutes'), browserHeadless: $('browser-headless'), browserProxyServer: $('browser-proxy-server'),
    sessionIdleEffective: $('session-idle-effective'), runtimeError: $('runtime-settings-error'), operationMode: $('operation-mode'), operationModeError: $('operation-mode-error'),
    privateNetworkSuggestion: $('private-network-suggestion'), browserProxyConnectHostname: $('browser-proxy-connect-hostname'),
    browserSetup: $('browser-setup'), browserSetupStatus: $('browser-setup-status'), browserHosts: $('browser-hosts'), browserRetry: $('browser-retry'),
    browserInstalled: $('browser-installed'), browserInstalledEmpty: $('browser-installed-empty'), browserCompat: $('browser-compat'), browserUseAuto: $('browser-use-auto'),
    desktopOsHint: $('desktop-os-hint'), desktopAppId: $('desktop-app-id'), desktopAppPath: $('desktop-app-path'), desktopBrowse: $('desktop-browse'), desktopSave: $('desktop-save'),
    desktopClear: $('desktop-clear'), desktopNotice: $('desktop-notice'), desktopError: $('desktop-error'), allowPhysicalInput: $('allow-physical-input'), allowUnredactedImages: $('allow-unredacted-images')
  };
  const DESKTOP_CONTROLS = ['desktopAppId', 'desktopAppPath', 'desktopBrowse', 'desktopSave', 'desktopClear', 'allowPhysicalInput', 'allowUnredactedImages'];

  const set = (el, text) => setText(el, text);
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
  let currentOrigins = [];
  let currentResourceOrigins = [];
  // Desktop inputs are only overwritten from saved state while the user has no unsaved edit.
  let desktopDirty = false;
  let pickedNotes = [];
  let hostDesktopNotice = '';
  function markBusy(key, on) {
    busy[key] = on;
    const map = { enabled: ['enabled'], auto: ['autoUpdate'], check: ['checkUpdates'], checkNow: ['checkNow'], resume: ['resumeOperations'], clients: ['clientsEnable', 'clientsRefresh'], origins: ['originAdd'], runtime: ['sessionIdleMinutes','browserHeadless','browserProxyServer','browserProxyConnectHostname'], operationMode:['operationMode'], desktop: DESKTOP_CONTROLS, browser: ['browserRetry','browserUseAuto'] };
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
      const status = document.createElement('span'); setText(status, labels[client.status] || String(client.status));
      li.appendChild(name); li.appendChild(status);
      if (client.message) li.title = String(client.message);
      els.clientsList.appendChild(li);
    }
    set(els.clientsError, state.error || state.rows.filter(c => c.status === 'error' || c.status === 'conflict').map(c => `${c.name}: ${c.message}`).join('\n'));
    if (state.busy) set(els.clientsStatus, 'AI クライアントを更新しています… / Updating AI clients…');
    else {
      const detected = state.rows.filter(c => c.detected).length;
      const configured = state.rows.filter(c => c.status === 'enabled').length;
      setTextParts(els.clientsStatus, [`${detected} 件を検出 / ${detected} detected`, `${configured} 件に登録済み / ${configured} configured`]);
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
    const value = (key) => key === 'mode' ? ({read_only:'読み取り専用 / read only',standard:'標準 / standard',ask:'都度承認 / ask each time',all:'すべて許可 / allow all (legacy)'}[p.operationMode] || 'unknown')
      : key === 'origins' ? (Array.isArray(p.browserOrigins) && p.browserOrigins.length ? p.browserOrigins.join(', ') : OFF.origins)
      : key === 'app' ? (p.desktopAppId || OFF.app)
      : p[flags[key]] ? '有効 / on' : OFF[key];
    els.permissions.textContent = '';
    for (const [key, label] of PERMS) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'perm-label'; setText(a, label);
      const b = document.createElement('span'); b.className = 'perm-value'; setText(b, String(value(key)) + (requested[flags[key]] === true && p[flags[key]] !== true ? '（要求 on / requested on）' : ''));
      li.appendChild(a); li.appendChild(b); els.permissions.appendChild(li);
    }
    const hint = (Array.isArray(p.browserOrigins) && p.browserOrigins.length) || p.desktopAppId ? '許可された範囲のみ利用できます。 / Only granted scopes are usable.' : 'MCP を有効にしても権限は付きません。 / Enabling MCP alone grants nothing.';
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
      for (const grant of [els.allowLoopback, els.allowPrivateNetwork, els.allowPersonalData]) if (grant) { grant.dataset.locked = workspaceOk ? 'false' : 'true'; setBusy(grant, !!busy.origins); }
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
  });

  post({ type: 'ready' });
})();
