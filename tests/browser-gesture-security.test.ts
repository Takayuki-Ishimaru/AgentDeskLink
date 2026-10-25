import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {runBrowserGesture} from '../src/browser-gesture.js';
import {captureBrowserImage} from '../src/browser-visual.js';
import {AdlError} from '../src/types.js';

async function fixture(content:string,script='',extraStyle=''){
 const html=`<!doctype html><style>body{margin:0}#board{position:absolute;left:10px;top:10px;width:400px;height:200px;touch-action:none}#danger,#art{position:absolute;left:10px;top:10px;width:100px;height:60px;background:red}${extraStyle}</style><div id="board">${content}</div><script>window.clicks=0;window.presses=0;window.releases=0;window.addEventListener('mousedown',()=>window.presses++);window.addEventListener('mouseup',()=>window.releases++);${script}</script>`;
 const http=createServer((_,r)=>{r.setHeader('content-type','text/html');r.end(html)});await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;const browser=await chromium.launch({headless:true,chromiumSandbox:true});const page=await browser.newPage();await page.goto(origin);const signal=new AbortController().signal,reference=await captureBrowserImage(page,origin,{enabled:true,maskSelectors:[]},signal);const policy={enabled:true,surfaces:[{id:'board',selector:'#board',kinds:['drag' as const,'swipe' as const]}]};const request=(dx=3)=>({surface_id:'board',kind:'drag' as const,points:[{x:50,y:50,t_ms:0},{x:50+dx,y:50,t_ms:30}]});return {page,signal,reference,policy,request,counts:()=>page.evaluate(()=>({clicks:(window as any).clicks,presses:(window as any).presses,releases:(window as any).releases})),close:async()=>{await browser.close();await new Promise<void>(r=>http.close(()=>r()))}};
}
for(const dx of [0,3])test(`gesture rejects consequential custom ARIA button at ${dx}px displacement`,{timeout:10000},async()=>{
 const f=await fixture('<div id="danger" role="button" aria-label="Delete account" onclick="window.clicks++">Delete account</div>');try{await assert.rejects(runBrowserGesture(f.page,f.request(dx),f.policy,f.reference,f.signal,()=>{}));assert.deepEqual(await f.counts(),{clicks:0,presses:0,releases:0});}finally{await f.close();}
});
test('gesture rejects visible consequential text on a custom non-ARIA control',{timeout:10000},async()=>{
 const f=await fixture('<div id="danger" onclick="window.clicks++">Delete account</div>');try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}));assert.deepEqual(await f.counts(),{clicks:0,presses:0,releases:0});}finally{await f.close();}
});
test('gesture blocks Pay consistently with existing semantic consequential policy',{timeout:10000},async()=>{
 const f=await fixture('<div id="danger" aria-label="Pay now" onclick="window.clicks++">Pay now</div>');try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}));assert.deepEqual(await f.counts(),{clicks:0,presses:0,releases:0});}finally{await f.close();}
});
test('gesture rejects a fully transparent allowed surface',{timeout:10000},async()=>{
 const f=await fixture('<div id="danger" onclick="window.clicks++">Run</div>','','#board{opacity:0}');try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}));assert.deepEqual(await f.counts(),{clicks:0,presses:0,releases:0});}finally{await f.close();}
});
test('gesture refuses a transparent sensitive overlay even though it looks absent',{timeout:10000},async()=>{
 const f=await fixture('<canvas id="art"></canvas><input aria-label="Password" value="CANARY" style="position:absolute;left:20px;top:20px;width:100px;height:50px;opacity:0">');try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}));assert.equal((await f.counts()).presses,0);}finally{await f.close();}
});
test('gesture rechecks hover-created editable overlay before pressing',{timeout:10000},async()=>{
 const f=await fixture('<canvas id="art"></canvas>',`document.getElementById('board').addEventListener('mousemove',()=>{if(document.getElementById('overlay'))return;const node=document.createElement('input');node.id='overlay';node.style.cssText='position:fixed;left:30px;top:30px;width:100px;height:60px';document.body.appendChild(node)},{once:true});`);try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}));assert.equal((await f.counts()).presses,0);}finally{await f.close();}
});
test('gesture stops on surface movement and releases a pressed mouse',{timeout:10000},async()=>{
 const f=await fixture('<canvas id="art"></canvas>',`document.getElementById('board').addEventListener('mousedown',()=>{document.getElementById('board').style.left='20px'},{once:true});`);try{await assert.rejects(runBrowserGesture(f.page,f.request(),f.policy,f.reference,f.signal,()=>{}),(e:unknown)=>e instanceof AdlError&&e.code==='E_STALE_STATE'&&e.mayHaveExecuted);assert.deepEqual(await f.counts(),{clicks:0,presses:1,releases:1});}finally{await f.close();}
});
