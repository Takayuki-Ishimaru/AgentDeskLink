import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {inspectBrowserAction} from '../src/browser-approval.js';

test('approval proof reads real form values and protected ancestors in an isolated world',{timeout:20000},async()=>{
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<form action="/submit" method="post"><input id="secret" type="password" name="password" value="ACTUAL_SECRET"><button id="send">Send</button></form><input id="APIKey1" value="opaque"><div data-adl-sensitive><button id="private">Protected</button></div>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,chromiumSandbox:true});const page=await browser.newPage();
 try{
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  const send=(await page.locator('#send').elementHandle())!,privateButton=(await page.locator('#private').elementHandle())!,apiKey=(await page.locator('#APIKey1').elementHandle())!;
  await page.evaluate(()=>{
   Element.prototype.getAttribute=function(){return null;};
   Element.prototype.closest=function(){return null;};
   Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){return 'FORGED';},set(){}});
   Map.prototype.get=function(){return undefined;};
  });
  const action={action:'click' as const,element_id:'retained'};
  const first=await inspectBrowserAction(send,action);
  assert.equal(first.risk,'credential');assert.ok(first.details?.some(x=>x.includes('[secret, 13 characters]')));
  assert.ok(!JSON.stringify(first.details).includes('ACTUAL_SECRET'));
  assert.equal((await inspectBrowserAction(apiKey,{action:'fill',element_id:'retained',value:'example'})).risk,'credential');
  await assert.rejects(inspectBrowserAction(privateButton,action));
  const cdp=await page.context().newCDPSession(page);const tree=await cdp.send('Page.getFrameTree');const world=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'test-isolation'});
  await cdp.send('Runtime.evaluate',{contextId:world.executionContextId,expression:`document.querySelector('#secret').value='CHANGED_SECRET'`});await cdp.detach();
  const second=await inspectBrowserAction(send,action);assert.notEqual(second.proof,first.proof);
  await send.dispose();await privateButton.dispose();await apiKey.dispose();
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
