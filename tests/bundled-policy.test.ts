import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyRuntimeSettings,normalizeRuntimeSettings,parseRuntimeSettingsEnv,parseStartupPolicy,runtimeSettingsFromIdleMinutes,runtimeSettingsEnvJson} from '../src/bundled-policy.js';
import {resolve,dirname} from 'node:path';

const app = {appId:'test.app', appPath:'/Applications/Test.app/Contents/MacOS/Test', classification:'PUBLIC'};

test('extension runtime settings normalize idle minutes separately from permission grants',()=>{
  assert.deepEqual(runtimeSettingsFromIdleMinutes(15),{sessionTtlMs:900_000,browserHeadless:true,browserProxyServer:''});
  assert.deepEqual(normalizeRuntimeSettings({}),{sessionTtlMs:900_000,browserHeadless:true,browserProxyServer:''});
  assert.deepEqual(parseRuntimeSettingsEnv(runtimeSettingsEnvJson({sessionTtlMs:3_600_000,browserHeadless:false,browserProxyServer:'https://proxy.example:8443/'})),{sessionTtlMs:3_600_000,browserHeadless:false,browserProxyServer:'https://proxy.example:8443'});
  assert.deepEqual(parseRuntimeSettingsEnv(undefined),{sessionTtlMs:900_000,browserHeadless:true,browserProxyServer:''});
  for(const minutes of [0,-1,1.5,61,NaN])assert.throws(()=>runtimeSettingsFromIdleMinutes(minutes));
  for(const value of [{sessionTtlMs:999},{sessionTtlMs:3_600_001},{sessionTtlMs:12_345.5},{sessionTtlMs:60_000,proxy:'http://localhost'},
    {browserProxyServer:'ftp://proxy.example'},{browserProxyServer:'http://user:secret@proxy.example:8080'},
    {browserProxyServer:'http://proxy.example/path'},{browserProxyServer:'http://proxy.example/?q=secret'},
    {browserProxyServer:'http://proxy.example/#fragment'}])assert.throws(()=>normalizeRuntimeSettings(value));
  const base=parseStartupPolicy({allowedOrigins:['https://example.com']});
  assert.equal(applyRuntimeSettings(base,{sessionTtlMs:120_000,browserHeadless:false,browserProxyServer:'http://proxy.example:3128'}).sessionTtlMs,120_000);
  assert.equal(applyRuntimeSettings(base,{sessionTtlMs:120_000,browserHeadless:false,browserProxyServer:'http://proxy.example:3128'}).browserHeadless,false);
  assert.equal(base.sessionTtlMs,900_000,'applying runtime settings does not mutate the base policy');
});

test('relative audit logs resolve beside the policy file independently of the host working directory',()=>{
  const config=resolve('fixtures','settings','policy.json');
  const input={auditPath:'../logs/audit.jsonl'};
  assert.equal(parseStartupPolicy(input,undefined,'linux',config).auditPath,resolve(dirname(config),'../logs/audit.jsonl'));
  assert.equal(input.auditPath,'../logs/audit.jsonl');
  const absolute=resolve('logs','audit.jsonl');
  assert.equal(parseStartupPolicy({auditPath:absolute},undefined,'linux',config).auditPath,absolute);
  assert.equal(parseStartupPolicy(input).auditPath,input.auditPath);
});

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
