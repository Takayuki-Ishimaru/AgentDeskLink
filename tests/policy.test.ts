import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, assertUrlAllowed, resolveAllowedAddresses, redactString, redactElement, authorizeAction } from '../src/policy.js';
const config = () => parsePolicy({ allowedOrigins: ['https://example.com'], browserTargets: [{id:'demo',label:'Demo',url:'https://example.com',classification:'PUBLIC'}] });
test('policy is closed by default and rejects malformed/unknown configuration', async () => {
  const p = parsePolicy({}); assert.deepEqual(p.allowedOrigins, []);
  await assert.rejects(assertUrlAllowed('https://example.com', p), {code:'E_POLICY_DENIED'});
  assert.throws(() => parsePolicy({physicalInput:true}));
  assert.throws(() => parsePolicy({allowedOrigins:['https://example.com/path']}));
  assert.throws(() => parsePolicy({maxSessions:1000000}));
});
test('exact origins, schemes, credentials and network addresses are checked', async () => {
  const p = config();
  const publicDns = async () => ['93.184.216.34'];
  await assertUrlAllowed('https://example.com/form', p, publicDns);
  for(const url of ['https://evil.example.com','https://example.com:444','file:///tmp/a','javascript:alert(1)','https://user:pass@example.com'])
    await assert.rejects(assertUrlAllowed(url,p,publicDns));
  for(const addresses of [['127.0.0.1'],['10.0.0.1'],['::1'],['::ffff:127.0.0.1'],['93.184.216.34','192.168.0.2']])
    await assert.rejects(assertUrlAllowed('https://example.com',p,async()=>addresses));
  await assert.rejects(assertUrlAllowed('https://example.com',p,async()=>{throw new Error('secret dns error')}));
});
test('loopback fixture needs explicit exact origin and separate opt-in', async () => {
  const p = parsePolicy({allowedOrigins:['http://127.0.0.1:8123'],allowLoopback:true});
  await assertUrlAllowed('http://127.0.0.1:8123/',p);
  await assert.rejects(assertUrlAllowed('http://127.0.0.1:8124/',p));
  await assert.rejects(assertUrlAllowed('http://169.254.169.254/',p));
});
test('redaction covers secret fields, emails, token query strings and API keys', () => {
  for(const value of ['alice@example.com','sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','https://example.com/?access_token=CANARY_SECRET','Bearer abcdefghijklmnopqrstuvwxyz123456','employee_id=EMP-123456']) {
    const safe = redactString(value); assert.notEqual(safe,value);
    assert.ok(!safe.includes('CANARY_SECRET')); assert.ok(!safe.includes('alice@'));
  }
  const e = redactElement({id:'e1',role:'textbox',name:'Password',value:'canary-unknown-value',enabled:true,sensitive:true});
  assert.ok(!JSON.stringify(e).includes('canary')); assert.ok(!('sensitive' in e));
});

test('ordinary labels, long links and prose remain readable while structured secrets are hidden', () => {
  for (const name of ['Opinion', 'Shipping', 'Author', 'Session length', 'Cookie settings']) {
    assert.equal(redactElement({id:'e', role:'button', name, enabled:true}).name, name);
  }
  for (const text of [
    'https://example.com/this-is-a-long-readable-documentation-path?category=shipping',
    'A long paragraph about documentation with https://example.com/a-long-public-path-for-reading and other ordinary words.',
    'opinion=positive shipping=express author=Alice',
    'The token budget and token lifetime are documented here.',
  ]) assert.equal(redactString(text), text);
  const prose='This session explains cookie storage and credential handling. '+ 'Public documentation. '.repeat(40);
  const paragraph=redactElement({id:'e',role:'text',name:prose,enabled:true});assert.equal(paragraph.name,prose.slice(0,512));
  assert.ok(!redactElement({id:'e',role:'text',name:'Database db_password=PRIVATE_CANARY',enabled:true}).name.includes('PRIVATE_CANARY'));
  for (const text of [
    'https://example.com/?access_token=PRIVATE_CANARY',
    'password=PRIVATE_CANARY', 'cookie=PRIVATE_CANARY', 'session_id=PRIVATE_CANARY',
    'oauth_access_token=PRIVATE_CANARY', 'db_password=PRIVATE_CANARY', 'database.connection.password=PRIVATE_CANARY',
    'Authorization: Bearer PRIVATE_CANARY', 'Authorization: Token PRIVATE_CANARY', 'Authorization: Basic PRIVATE_CANARY',
    'https://example.com/?oauth_access_token=PRIVATE_CANARY&category=shipping',
    'Bearer PRIVATE_CANARY_1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123',
  ]) assert.ok(!redactString(text).includes(text.includes('PRIVATE_CANARY') ? 'PRIVATE_CANARY' : text), text);
});
test('unsafe actions are denied, consequential controls fail closed', () => {
  assert.throws(()=>authorizeAction({action:'click'}, {id:'e',role:'button',name:'Protected',enabled:true,protected:true},true),{code:'E_PRIVACY_BLOCKED'});
  assert.throws(()=>authorizeAction({action:'fill',value:'secret'}, {id:'e',role:'textbox',name:'Password',enabled:true,sensitive:true}),{code:'E_PRIVACY_BLOCKED'});
  for(const name of ['Delete account','Upload file','Pay now','Send email','Sign in','Submit'])
    assert.throws(()=>authorizeAction({action:'click'},{id:'e',role:'button',name,enabled:true}),{code:'E_APPROVAL_REQUIRED'});
  authorizeAction({action:'fill',value:'TEST-001'},{id:'e',role:'textbox',name:'Search',enabled:true});
  authorizeAction({action:'scroll',direction:'down'},{id:'e',role:'region',name:'Payment documentation',enabled:true});
  assert.throws(()=>authorizeAction({action:'press',value:'Control+Enter'},{id:'e',role:'textbox',name:'Search',enabled:true},true),{code:'E_INVALID_ARGUMENT'});
});
test('IPv6 transitions, mapped loopback and mixed DNS cannot bypass policy',async()=>{
 const p=config();for(const ip of ['::ffff:7f00:1','::ffff:127.0.0.1','::','ff02::1','fe80::1','fc00::1','2002:7f00:1::','2001::1','64:ff9b::7f00:1','fe80::1%eth0','192.0.2.1'])await assert.rejects(assertUrlAllowed('https://example.com',p,async()=>[ip]));
 assert.deepEqual(await resolveAllowedAddresses('https://example.com',p,async()=>['2606:4700:4700::1111']),['2606:4700:4700::1111']);
});
test('private opt-in still denies metadata and unrelated origins',async()=>{
 const p=parsePolicy({allowedOrigins:['http://10.0.0.1'],allowPrivateNetwork:true});await assertUrlAllowed('http://10.0.0.1',p);await assert.rejects(assertUrlAllowed('http://10.0.0.2',p));
 const hostPolicy=parsePolicy({allowedOrigins:['http://private.example'],allowPrivateNetwork:true});
 for(const ip of ['169.254.169.254','0.0.0.0','224.0.0.1','fe80::1'])await assert.rejects(assertUrlAllowed('http://private.example',hostPolicy,async()=>[ip]));
});
test('trusted control rules, full paths and duplicate ids',()=>{
 const entry={id:'demo',label:'Demo',url:'https://example.com/test',classification:'PUBLIC',controls:[{selector:'#q',actions:['fill']}]};
 assert.equal(parsePolicy({browserTargets:[entry]}).browserTargets[0]?.controls?.[0]?.selector,'#q');
 assert.throws(()=>parsePolicy({browserTargets:[entry,entry]}));assert.throws(()=>parsePolicy({browserTargets:[{...entry,classification:undefined}]}));
});
test('unknown role cannot carry secrets into an otherwise redacted snapshot',()=>{const canary='sk-CANARY123456789012345678901234';const e=redactElement({id:'e',role:canary,name:'Find',enabled:true});assert.equal(e.role,'generic');assert.ok(!JSON.stringify(e).includes(canary));});
test('visual disclosure is a strict trusted per-target opt-in',()=>{
 const entry={id:'demo',label:'Demo',url:'https://example.com',classification:'PUBLIC'};
 assert.equal(parsePolicy({browserTargets:[entry]}).browserTargets[0]?.visual,undefined);
 assert.deepEqual(parsePolicy({browserTargets:[{...entry,visual:{enabled:true}}]}).browserTargets[0]?.visual,{enabled:true,maskSelectors:[]});
 for(const visual of [true,{enabled:'true'},{enabled:true,unknown:true},{enabled:true,maskSelectors:['']}])assert.throws(()=>parsePolicy({browserTargets:[{...entry,visual}]}),{code:'E_INVALID_ARGUMENT'});
 assert.equal(parsePolicy({browserTargets:[{...entry,classification:'SECRET',visual:{enabled:true}}]}).browserTargets.length,0);
});
test('native interactive policy requires image permission and bounds trusted surfaces',()=>{
 const base={helperPath:'/fixture/helper',appId:'fixture',appPath:'/fixture/app',classification:'PUBLIC'};
 const interactive={enabled:true,surfaces:[{id:'board',region:{x:0,y:0,width:320,height:200},kinds:['drag','swipe'],swipe_backend:'scroll'}]};
 assert.throws(()=>parsePolicy({windows:{...base,interactive}}));
 assert.throws(()=>parsePolicy({macos:{...base,visual:{enabled:true},interactive}}));
 assert.equal(parsePolicy({windows:{...base,visual:{enabled:true},interactive}}).windows!.interactive!.enabled,true);
 assert.equal(parsePolicy({macos:{...base,visual:{enabled:true,allowUnredacted:true},interactive}}).macos!.interactive!.enabled,true);
 for(const surfaces of [[interactive.surfaces[0],interactive.surfaces[0]],[{...interactive.surfaces[0],id:'界'.repeat(22)}],[{...interactive.surfaces[0],region:{x:4090,y:0,width:10,height:20}}],[{...interactive.surfaces[0],kinds:['drag','drag']}],Array.from({length:17},(_,i)=>({...interactive.surfaces[0],id:String(i)}))])assert.throws(()=>parsePolicy({windows:{...base,visual:{enabled:true},interactive:{enabled:true,surfaces}}}));
});
