import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseStartupPolicy} from '../src/bundled-policy.js';

const app = {appId:'test.app', appPath:'/Applications/Test.app/Contents/MacOS/Test', classification:'PUBLIC'};

test('bundled helper fills only the current platform and never changes the source policy', () => {
  for (const [platform, key] of [['darwin','macos'], ['win32','windows']] as const) {
    const input = {[key]: {...app}};
    const before = JSON.stringify(input);
    const result = parseStartupPolicy(input, '/installed/helper', platform);
    assert.equal(result[key]?.helperPath, '/installed/helper');
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(result.allowedOrigins, []);
    assert.equal(result[key]?.interactive, undefined);
    assert.equal(result[key]?.visual, undefined);
    assert.equal(result[key]?.lifecycle, undefined);
  }
});

test('custom helper is preserved and invalid explicit paths fail instead of falling back', () => {
  assert.equal(parseStartupPolicy({macos:{...app, helperPath:'/custom/helper'}}, '/installed/helper','darwin').macos?.helperPath, '/custom/helper');
  for (const helperPath of ['', null, 'relative/helper', 42]) {
    assert.throws(() => parseStartupPolicy({macos:{...app, helperPath}}, '/installed/helper','darwin'), {code:'E_INVALID_ARGUMENT'});
  }
});

test('standalone, other platforms, and malformed policies retain strict validation', () => {
  for (const [input, helper, platform] of [
    [{macos:app},undefined,'darwin'],
    [{macos:app},'/installed/helper','win32'],
    [{macos:app},'/installed/helper','linux'],
    [{macos:app},'relative/helper','darwin'],
    [{macos:{...app,unknown:true}},'/installed/helper','darwin'],
    [{macos:{...app,interactive:{enabled:true,surfaces:[]}}},'/installed/helper','darwin'],
    [{macos:[]},'/installed/helper','darwin'],
    [[], '/installed/helper','darwin'],
  ] as const) assert.throws(() => parseStartupPolicy(input, helper, platform), {code:'E_INVALID_ARGUMENT'});
});

test('bundled setup grants no targets or desktop access by default', () => {
  const policy = parseStartupPolicy({}, '/installed/helper','darwin');
  assert.deepEqual(policy.browserTargets, []);
  assert.equal(policy.macos, undefined);
  assert.equal(policy.windows, undefined);
  assert.equal(policy.allowLoopback, false);
  assert.equal(policy.allowPrivateNetwork, false);
});
