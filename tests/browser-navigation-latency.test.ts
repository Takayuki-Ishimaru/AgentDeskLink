import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import type {Target} from '../src/types.js';

test('a non-navigation click does not wait for a navigation that will never occur',{timeout:15000},async()=>{
  const app=createServer((_,response)=>{
    response.setHeader('content-type','text/html');
    response.end('<button id="plain" type="button" onclick="document.querySelector(\'#status\').textContent=\'Done\'">Plain click</button><p id="status" role="status">Ready</p>');
  });
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
  const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,
    browserTargets:[{id:'plain',label:'Plain click',url:origin,classification:'PUBLIC',
      controls:[{selector:'#plain',actions:['click']}]}]});
  const adapter=new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy));
  const target:Target={target_id:'t_plain',application_id:'plain',label:'Plain click',
    surface:'browser',policy_class:'PUBLIC',capabilities:[]};
  try {
    const session=await adapter.open(target,'strict_isolated',new AbortController().signal);
    const observed=await session.snapshot();
    // Warm browser first; this deadline covers only the ordinary click.
    policy.actionTimeoutMs=400;
    await session.act({action:'click',element_id:observed.elements.find(e=>e.name==='Plain click')!.id},new AbortController().signal);
    assert.ok((await session.snapshot()).elements.some(e=>e.role==='status'&&e.name==='Done'));
  } finally {
    await adapter.close();
    await new Promise<void>(resolve=>app.close(()=>resolve()));
  }
});
