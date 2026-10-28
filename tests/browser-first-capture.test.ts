import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Engine} from '../src/core.js';
import {BrowserAdapter} from '../src/browser.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';

// A separate test process is intentional: earlier captures must not warm the
// process-wide selector registry and conceal late registration on a cold start.
test('the first capture works after input has initialized the page selector engine',{timeout:15000},async()=>{
 const app=createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<label>Search<input id="q" aria-label="Search"></label><p role="status">Ready</p>');});await new Promise<void>(r=>app.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
 const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,browserTargets:[{id:'first',label:'First capture',url:origin,classification:'PUBLIC',visual:{enabled:true},controls:[{selector:'#q',actions:['fill']}]}]});const engine=new Engine(policy,{browser:new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy))});
 try{const s=await engine.open((await engine.listTargets()).targets[0]!.target_id);const observed=await engine.observe(s.session_id);await engine.act(s.session_id,{action:'fill',element_id:observed.elements!.find(e=>e.role==='textbox')!.id,value:'bundled runtime'},observed.revision);const captured=await engine.capture(s.session_id);assert.ok(captured.png.length>1000);assert.ok((await engine.observe(s.session_id)).elements?.some(e=>e.value==='bundled runtime'));}
 finally{await engine.shutdown();app.closeAllConnections();await new Promise<void>(r=>app.close(()=>r()));}
});
