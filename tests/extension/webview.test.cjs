const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panel() {
  const elements = new Map(), messages = [], listeners = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, disabled: false, dataset: {}, listeners: new Map(),
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      async trigger(type) { await this.listeners.get(type)?.({ target: this, preventDefault() {} }); }
    });
    return elements.get(id);
  };
  const document = { getElementById: get, activeElement: null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../media/settings.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: data => messages.push(data), getState: () => ({}), setState() {} }),
    document, window: { addEventListener: (type, listener) => listeners.set(type, listener) }, console, setTimeout, clearTimeout
  });
  return { get, messages, document, state: data => listeners.get('message')({ data: { type: 'state', ...data } }) };
}

test('webview synchronizes saved toggles and locks only workspace settings without trust', async () => {
  const p = panel();
  p.state({ trusted: false, hasFolder: true, settings: { enabled: false, autoUpdate: true, checkForUpdates: true } });
  assert.equal(p.get('enabled').disabled, true);
  assert.equal(p.get('auto-update').disabled, false);
  p.state({ trusted: true, hasFolder: true, settings: { enabled: false } });
  const enabled = p.get('enabled'); enabled.checked = true; await enabled.trigger('change');
  assert.equal(enabled.disabled, true);
  assert.ok(p.messages.some(x => x.type === 'setEnabled' && x.enabled === true));
  p.state({ trusted: true, hasFolder: true, busy: { enabled: false }, settings: { enabled: false } });
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.checked, false, 'failed saves restore persisted state');
});

test('manual update button becomes usable again after the host finishes a check', async () => {
  const p = panel();
  await p.get('check-now').trigger('click');
  assert.equal(p.get('check-now').disabled, true);
  assert.ok(p.messages.some(x => x.type === 'checkForUpdates'));
  p.state({ busy: { checkNow: false }, status: { update: '更新先未設定' } });
  assert.equal(p.get('check-now').disabled, false);
});

test('refresh keeps focused text drafts and displays error messages as text', () => {
  const p = panel();
  p.document.activeElement = p.get('manifest-url');
  p.get('manifest-url').value = 'https://draft.example/update.json';
  p.state({ settings: { updateManifestUrl: 'https://saved.example/update.json' }, status: { mcpError: '<img src=x onerror=alert(1)>' } });
  assert.equal(p.get('manifest-url').value, 'https://draft.example/update.json');
  assert.equal(p.get('mcp-error').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(p.get('mcp-error').innerHTML, undefined);
});

test('removed node and policy controls post no webview messages', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { enabled: false } });
  for (const id of ['node-path', 'node-save', 'config-path', 'config-save', 'config-select', 'config-open']) {
    const el = p.get(id);
    assert.equal(el.listeners.size, 0, `${id} has no listeners`);
    await el.trigger('click');
  }
  assert.deepEqual(p.messages.map(x => x.type), ['ready']);
});

test('emergency stop posts immediately and stays enabled despite trust lock and unrelated busy flags', async () => {
  const p = panel();
  p.state({ trusted: false, hasFolder: false, stopped: false, busy: { enabled: true, check: true, checkNow: true } });
  const stop = p.get('emergency-stop');
  assert.equal(stop.disabled, false, 'stop stays accessible when untrusted and other operations are busy');
  await stop.trigger('click');
  await stop.trigger('click');
  assert.deepEqual(p.messages.filter(x => x.type === 'emergencyStop').map(x => x.type), ['emergencyStop', 'emergencyStop']);
});

test('resume button appears only while stopped and posts resumeOperations', async () => {
  const p = panel();
  p.state({ stopped: false });
  assert.equal(p.get('resume-operations').hidden, true);
  p.state({ stopped: true });
  const resume = p.get('resume-operations');
  assert.equal(resume.hidden, false);
  assert.equal(p.get('stopped-status').hidden, false);
  await resume.trigger('click');
  assert.ok(p.messages.some(x => x.type === 'resumeOperations'));
  assert.equal(resume.disabled, true, 'resume shows busy feedback until the host answers');
  p.state({ stopped: true, busy: { resume: false } });
  assert.equal(resume.disabled, false);
  p.state({ stopped: false, busy: { resume: false } });
  assert.equal(resume.hidden, true);
  assert.equal(p.get('stopped-status').hidden, true);
});


test('emergency stop remains clickable while stop itself is busy; hidden controls stay hidden', () => {
  const p = panel();
  p.state({stopped:false,busy:{stop:true}});
  assert.equal(p.get('emergency-stop').disabled,false);
  const css=fs.readFileSync(path.join(__dirname,'../../media/settings.css'),'utf8');
  assert.match(css,/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
});
