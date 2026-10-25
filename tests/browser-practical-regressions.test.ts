import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy, assertUrlAllowed} from '../src/policy.js';

async function setup(html: string, controls: {selector: string; actions: string[]}[]) {
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><style>input{display:block;width:240px;height:40px;margin:20px}</style>${html}`);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as {port: number}).port}`;
  const policy = parsePolicy({allowedOrigins: [origin], allowLoopback: true,
    actionTimeoutMs: 3000, browserTargets: [{id: 'search', label: 'Public search',
      url: origin, classification: 'PUBLIC', controls}]});
  const engine = new Engine(policy, {browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy))});
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {engine, session, close: async () => {
    await engine.shutdown(); app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }};
}

test('an ambiguous earlier selector does not shadow a unique approved search selector', {timeout: 15000}, async () => {
  const f = await setup('<form id="header" role="search"><input type="search" name="q" aria-label="Quick search"></form><form id="footer"><input name="q" aria-label="Other search"></form>',
    [{selector: 'input[name="q"]', actions: ['fill']}, {selector: '#header input[name="q"]', actions: ['fill']}]);
  try {
    const before = await f.engine.observe(f.session.session_id, {token_budget: 8000});
    const input = before.elements!.find(e => e.name === 'Quick search')!;
    await f.engine.act(f.session.session_id, {action: 'fill', element_id: input.id,
      value: 'dictionary', expected_target: {role: 'textbox', name: 'Quick search'}}, before.revision);
    const after = await f.engine.observe(f.session.session_id, {token_budget: 8000});
    assert.equal(after.elements!.find(e => e.name === 'Quick search')!.value, 'dictionary');
    assert.equal(after.elements!.find(e => e.name === 'Other search')!.value, '');
  } finally {await f.close();}
});

test('a search field after an over-deep unrelated subtree remains observable and editable', {timeout: 15000}, async () => {
  const deep = '<div>'.repeat(20) + '<span>Deep unrelated content</span>' + '</div>'.repeat(20);
  const f = await setup(`${deep}<input id="query" type="search" aria-label="Quick search">`, [{selector: '#query', actions: ['fill']}]);
  try {
    const before = await f.engine.observe(f.session.session_id, {token_budget: 8000});
    assert.equal(before.truncated, true);
    const input = before.elements!.find(e => e.name === 'Quick search');
    assert.ok(input, 'depth limiting must skip the subtree and continue with later siblings');
    await f.engine.act(f.session.session_id, {action: 'fill', element_id: input.id, value: 'dictionary'}, before.revision);
    const after = await f.engine.observe(f.session.session_id, {token_budget: 8000});
    assert.equal(after.elements!.find(e => e.id === input.id)!.value, 'dictionary');
  } finally {await f.close();}
});

test('ambiguous search selectors alone still refuse input', {timeout: 15000}, async () => {
  const f = await setup('<input name="q" aria-label="Quick search"><input name="q" aria-label="Other search">', [{selector: 'input[name="q"]', actions: ['fill']}]);
  try {
    const before = await f.engine.observe(f.session.session_id);
    await assert.rejects(f.engine.act(f.session.session_id, {action: 'fill', element_id: before.elements!.find(e => e.name === 'Quick search')!.id, value: 'must not enter'}, before.revision), {code: 'E_APPROVAL_REQUIRED'});
  } finally {await f.close();}
});

test('ordinary search fill stays independent from submitting a form', {timeout: 15000}, async () => {
  const f = await setup('<form method="get"><input id="query" name="q" type="search" aria-label="Quick search"><button id="submit">Submit</button></form>', [{selector: '#query', actions: ['fill']}, {selector: '#submit', actions: ['click']}]);
  try {
    let state = await f.engine.observe(f.session.session_id);
    await f.engine.act(f.session.session_id, {action: 'fill', element_id: state.elements!.find(e => e.name === 'Quick search')!.id, value: 'dictionary'}, state.revision);
    state = await f.engine.observe(f.session.session_id);
    assert.equal(state.elements!.find(e => e.name === 'Quick search')!.value, 'dictionary');
    await assert.rejects(f.engine.act(f.session.session_id, {action: 'click', element_id: state.elements!.find(e => e.name === 'Submit')!.id}, state.revision));
  } finally {await f.close();}
});

test('a later action-specific rule for the same unique selector can authorize fill', {timeout:15000}, async()=>{
  const f=await setup('<input id="query" type="search" aria-label="Quick search">', [{selector:'#query',actions:['click']},{selector:'#query',actions:['fill']}]);
  try{const before=await f.engine.observe(f.session.session_id);await f.engine.act(f.session.session_id,{action:'fill',element_id:before.elements!.find(e=>e.name==='Quick search')!.id,value:'dictionary'},before.revision);const after=await f.engine.observe(f.session.session_id);assert.equal(after.elements!.find(e=>e.name==='Quick search')!.value,'dictionary');}finally{await f.close();}
});

test('authorization visit cap never infers uniqueness without scanning the entire tree', {timeout:15000}, async()=>{
  const f=await setup('<input id="query" type="checkbox" aria-label="Toggle">'+'<span></span>'.repeat(5100)+'<input id="query" type="checkbox" aria-label="Duplicate">', [{selector:'#query',actions:['check']}]);
  try{const before=await f.engine.observe(f.session.session_id);await assert.rejects(f.engine.act(f.session.session_id,{action:'check',element_id:before.elements!.find(e=>e.name==='Toggle')!.id,checked:true},before.revision),{code:'E_APPROVAL_REQUIRED'});}finally{await f.close();}
});

test('Python-style responsive duplicate search fields authorize only the visible header instance', {timeout:15000}, async()=>{
  const header='body > .related:has(~ .document) form.inline-search input[type="search"][name="q"]';
  const form='<form class="inline-search"><input id="search-box" type="search" name="q" aria-label="Quick search"></form>';
  const f=await setup('<div hidden><form role="search" class="search"><input type="search" name="q" aria-label="Quick search"></form></div><div class="related">'+form+'</div><div class="document">Documentation</div><div class="related">'+form+'</div>', [{selector:header,actions:['fill']}]);
  try{const before=await f.engine.observe(f.session.session_id);const fields=before.elements!.filter(e=>e.name==='Quick search');assert.equal(fields.length,2);await f.engine.act(f.session.session_id,{action:'fill',element_id:fields[0]!.id,value:'dictionary'},before.revision);const after=await f.engine.observe(f.session.session_id);assert.equal(after.elements!.find(e=>e.id===fields[0]!.id)!.value,'dictionary');assert.equal(after.elements!.find(e=>e.id===fields[1]!.id)!.value,'');}finally{await f.close();}
});
