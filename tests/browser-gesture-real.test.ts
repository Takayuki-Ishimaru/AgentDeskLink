import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { captureGestureGeometry, runBrowserGesture } from '../src/browser-gesture.js';
import { captureBrowserImage } from '../src/browser-visual.js';
import type { GesturePolicy } from '../src/gesture-types.js';
const html =
  "<!doctype html><meta charset=\"utf-8\"><style>body{margin:0;background:#eee}#board{position:absolute;left:10px;top:10px;width:600px;height:250px;touch-action:none}#video{position:absolute;left:10px;top:280px;width:160px;height:90px}#status{position:absolute;left:10px;top:390px}#unsafe{position:absolute;left:650px;top:10px}</style>\n<canvas id=\"board\" width=\"600\" height=\"250\"></canvas><div role=\"status\" id=\"status\">Ready</div><input id=\"unsafe\" aria-label=\"Password\" value=\"CANARY_SECRET\"><script>\nconst board=document.getElementById('board'),ctx=board.getContext('2d'),status=document.getElementById('status');let x=20,y=20,mouse=false,touch=false,trusted=true,pointerType='',startX=0;\nfunction paint(){ctx.fillStyle='white';ctx.fillRect(0,0,600,250);ctx.fillStyle='#f00';ctx.fillRect(x,y,40,40);ctx.fillStyle='#00f';ctx.fillRect(450,150,100,80)}paint();\nboard.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse')return;mouse=true;trusted&&=e.isTrusted;pointerType=e.pointerType;});\nboard.addEventListener('pointermove',e=>{if(!mouse||e.pointerType!=='mouse')return;trusted&&=e.isTrusted;x=e.clientX-30;y=e.clientY-30;paint();});\nboard.addEventListener('pointerup',e=>{if(!mouse||e.pointerType!=='mouse')return;mouse=false;trusted&&=e.isTrusted;status.textContent=`Drag ended x=${Math.round(x)} y=${Math.round(y)} trusted=${trusted} pointer=${pointerType}`;});\nboard.addEventListener('pointercancel',()=>{mouse=false;});\nboard.addEventListener('touchstart',e=>{touch=true;trusted&&=e.isTrusted;startX=e.touches[0].clientX;e.preventDefault();},{passive:false});\nboard.addEventListener('touchmove',e=>{if(!touch)return;trusted&&=e.isTrusted;x=20+e.touches[0].clientX-startX;paint();e.preventDefault();},{passive:false});\nboard.addEventListener('touchend',e=>{if(!touch)return;touch=false;trusted&&=e.isTrusted;status.textContent=`Swipe ended x=${Math.round(x)} trusted=${trusted} touch=${e instanceof TouchEvent}`;e.preventDefault();},{passive:false});\nboard.addEventListener('touchcancel',e=>{touch=false;status.textContent='Touch cancelled';e.preventDefault();},{passive:false});\n</script>";
async function fixture() {
  const http = createServer((_, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(html);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.goto(origin);
  const signal = new AbortController().signal;
  const reference = Object.assign(
    await captureBrowserImage(page, origin, { enabled: true, maskSelectors: [] }, signal),
    { origin },
  );
  const policy: GesturePolicy = {
    enabled: true,
    surfaces: [{ id: 'board', selector: '#board', kinds: ['drag', 'swipe'] }],
  };
  return {
    page,
    reference,
    signal,
    policy,
    close: async () => {
      await browser.close();
      await new Promise<void>(r => http.close(() => r()));
    },
  };
}
async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
}
test('real browser gesture: trusted pointer drag changes rendered canvas', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const out = await runBrowserGesture(
      f.page,
      {
        surface_id: 'board',
        kind: 'drag',
        points: [
          { x: 50, y: 50, t_ms: 0 },
          { x: 150, y: 80, t_ms: 50 },
          { x: 260, y: 120, t_ms: 100 },
        ],
      },
      f.policy,
      f.reference,
      f.signal,
      () => {},
    );
    assert.equal(out.released_input, true);
    assert.equal(out.verified, 'input_sequence_completed');
    assert.match(await f.page.locator('#status').innerText(), /Drag ended x=230 y=90 trusted=true pointer=mouse/);
    assert.deepEqual(await pixel(await f.page.screenshot({ scale: 'css' }), 245, 110), [255, 0, 0]);
  } finally {
    await f.close();
  }
});
test(
  'real browser gesture: swipe emits trusted TouchEvents and changes rendered canvas',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const out = await runBrowserGesture(
        f.page,
        {
          surface_id: 'board',
          kind: 'swipe',
          points: [
            { x: 50, y: 50, t_ms: 0 },
            { x: 120, y: 50, t_ms: 50 },
            { x: 200, y: 50, t_ms: 100 },
          ],
        },
        f.policy,
        f.reference,
        f.signal,
        () => {},
      );
      assert.equal(out.released_input, true);
      assert.equal(out.kind, 'swipe');
      assert.match(await f.page.locator('#status').innerText(), /Swipe ended x=170 trusted=true touch=true/);
      assert.deepEqual(await pixel(await f.page.screenshot({ scale: 'css' }), 195, 45), [255, 0, 0]);
    } finally {
      await f.close();
    }
  },
);
test('browser gesture rejects stale viewport and moved surface before dispatch', { timeout: 10000 }, async () => {
  const f = await fixture();
  const plan = {
    surface_id: 'board',
    kind: 'drag' as const,
    points: [
      { x: 50, y: 50, t_ms: 0 },
      { x: 150, y: 80, t_ms: 50 },
    ],
  };
  try {
    await f.page.setViewportSize({ width: 900, height: 700 });
    await assert.rejects(
      runBrowserGesture(f.page, plan, f.policy, f.reference, f.signal, () => {}),
      { code: 'E_STALE_STATE' },
    );
    await f.page.setViewportSize({ width: f.reference.viewport.width, height: f.reference.viewport.height });
    await f.page.locator('#board').evaluate(el => {
      (el as HTMLElement).style.left = '500px';
    });
    await assert.rejects(
      runBrowserGesture(f.page, plan, f.policy, f.reference, f.signal, () => {}),
      { code: 'E_POLICY_DENIED' },
    );
    assert.equal(await f.page.locator('#status').innerText(), 'Ready');
  } finally {
    await f.close();
  }
});
test(
  'capture geometry rejects CSS movement even when gesture points remain on the surface',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const geometry = await captureGestureGeometry(f.page, f.policy, f.signal);
      await f.page.locator('#board').evaluate(el => {
        (el as HTMLElement).style.left = '11px';
      });
      const plan = {
        surface_id: 'board',
        kind: 'drag' as const,
        points: [
          { x: 50, y: 50, t_ms: 0 },
          { x: 150, y: 80, t_ms: 50 },
        ],
      };
      await assert.rejects(
        runBrowserGesture(f.page, plan, f.policy, f.reference, f.signal, () => {}, false, geometry),
        { code: 'E_STALE_STATE' },
      );
      assert.equal(await f.page.locator('#status').innerText(), 'Ready');
    } finally {
      await f.close();
    }
  },
);
