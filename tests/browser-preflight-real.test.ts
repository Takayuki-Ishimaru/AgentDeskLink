import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

async function fixture(body: string, action: 'click' | 'fill' = 'fill', policyExtra: Record<string, unknown> = {}) {
  const events: string[] = [];
  const app = createServer((req, res) => {
    if (req.url?.startsWith('/event?')) {
      events.push(req.url);
      res.end('ok');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><style>body{margin:0}input,button{width:220px;height:44px;margin:16px}</style>${body}`);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 3000,
    ...policyExtra,
    browserTargets: [
      {
        id: 'fixture',
        label: 'Preflight fixture',
        url: origin,
        classification: 'PUBLIC',
        controls: [{ selector: '#target', actions: [action] }],
      },
    ],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)),
    engine = new Engine(policy, { browser: adapter });
  const target = (await engine.listTargets()).targets[0]!;
  const session = await engine.open(target.target_id);
  const observed = await engine.observe(session.session_id, { token_budget: 8000 });
  const element = observed.elements!.find(
    e => e.name.trim() === 'Reference' || e.name === 'Continue' || e.name === 'Inspect',
  )!;
  assert.ok(element, JSON.stringify(observed.elements));
  const act = () =>
    engine.act(
      session.session_id,
      {
        action,
        element_id: element.id,
        expected_target: { role: element.role, name: element.name },
        ...(action === 'fill' ? { value: 'AI intended text' } : {}),
      },
      observed.revision,
    );
  return {
    engine,
    session,
    element,
    events,
    act,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}
const input = `<label>Reference<input id="target" oninput="fetch('/event?input=target')"></label>`;

test(
  'real Chromium Engine scrolls an offscreen approved field before hit/focus checks',
  { timeout: 12000 },
  async () => {
    const f = await fixture(`<div style="height:1800px"></div>${input}`);
    try {
      await f.act();
      const observed = await f.engine.observe(f.session.session_id);
      assert.equal(observed.elements!.find(e => e.id === f.element.id)?.value, 'AI intended text');
      await delay(40);
      assert.equal(f.events.length, 1);
    } finally {
      await f.close();
    }
  },
);
test('real Chromium Engine permits ordinary form fill without submitting', { timeout: 12000 }, async () => {
  const f = await fixture(
    `<form onsubmit="fetch('/event?submit');return false">${input}<button>Continue</button></form>`,
  );
  try {
    await f.act();
    const observed = await f.engine.observe(f.session.session_id);
    assert.equal(observed.elements!.find(e => e.id === f.element.id)?.value, 'AI intended text');
    await delay(40);
    assert.ok(f.events.every(x => !x.includes('submit')));
  } finally {
    await f.close();
  }
});
test('real Chromium Engine refuses a foreign overlay before sending any input', { timeout: 12000 }, async () => {
  const f = await fixture(`${input}<div style="position:fixed;inset:0;z-index:50;background:#eee">Cover</div>`);
  try {
    await assert.rejects(
      f.act(),
      (e: unknown) => e instanceof AdlError && e.code === 'E_NOT_INTERACTABLE' && e.reason === 'occluded',
    );
    await delay(40);
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
test('real Chromium Engine catches an overlay created by hover before fill', { timeout: 12000 }, async () => {
  const f = await fixture(
    `<input id="target" aria-label="Reference" oninput="fetch('/event?input=target')" onmouseenter="const o=document.createElement('div');o.style='position:fixed;inset:0;z-index:99;background:#eee';document.body.append(o)">`,
  );
  try {
    await assert.rejects(f.act());
    await delay(40);
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
test('real Chromium Engine catches a target renamed by hover before fill', { timeout: 12000 }, async () => {
  const f = await fixture(
    `<input id="target" aria-label="Reference" oninput="fetch('/event?input=target')" onmouseenter="this.setAttribute('aria-label','Different control')">`,
  );
  try {
    await assert.rejects(f.act(), (e: unknown) => e instanceof AdlError && e.code === 'E_STALE_STATE');
    await delay(40);
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
test('real Chromium Engine refuses redirected focus and leaves both inputs untouched', { timeout: 12000 }, async () => {
  const f = await fixture(
    `<input id="target" aria-label="Reference" onfocus="document.querySelector('#other').focus()" oninput="fetch('/event?input=target')"><input id="other" aria-label="Other control" oninput="fetch('/event?input=other')">`,
  );
  try {
    await assert.rejects(f.act(), (e: unknown) => e instanceof AdlError && e.code === 'E_FOCUS_CHANGED');
    await delay(40);
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
test('real Chromium Engine refuses an implicit submit button before click', { timeout: 12000 }, async () => {
  const f = await fixture(
    `<form onsubmit="fetch('/event?submit');return false"><button id="target" onclick="fetch('/event?click')">Continue</button></form>`,
    'click',
  );
  try {
    await assert.rejects(f.act());
    await delay(40);
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
test(
  'real Chromium Engine accepts a noninteractive descendant at the intended button center',
  { timeout: 12000 },
  async () => {
    const f = await fixture(
      `<button type="button" id="target" aria-label="Inspect" onclick="fetch('/event?click')"><span style="display:block;width:100%;height:100%">Icon</span></button>`,
      'click',
    );
    try {
      await f.act();
      await delay(40);
      assert.equal(f.events.length, 1);
    } finally {
      await f.close();
    }
  },
);
test('real Chromium Engine refuses readonly and disabled-fieldset inputs', { timeout: 20000 }, async () => {
  for (const body of [
    `<input readonly id="target" aria-label="Reference" oninput="fetch('/event?input')">`,
    `<fieldset disabled><input id="target" aria-label="Reference" oninput="fetch('/event?input')"></fieldset>`,
  ]) {
    const f = await fixture(body);
    try {
      await assert.rejects(f.act());
      await delay(40);
      assert.equal(f.events.length, 0);
    } finally {
      await f.close();
    }
  }
});
test(
  'real Chromium Engine names a wrapping label using bounded text and skips hidden decoration',
  { timeout: 12000 },
  async () => {
    const f = await fixture(
      `<label>Reference<span aria-hidden="true">decorative subtree text</span><input id="target" oninput="fetch('/event?input=target')"></label>`,
    );
    try {
      assert.equal(f.element.name, 'Reference');
      await f.act();
      const observed = await f.engine.observe(f.session.session_id);
      assert.equal(observed.elements!.find(e => e.id === f.element.id)?.value, 'AI intended text');
    } finally {
      await f.close();
    }
  },
);

test(
  'real Chromium Engine preserves snapshot role for input buttons and exact aria-label spacing',
  { timeout: 20000 },
  async () => {
    for (const body of [
      `<input id="target" type="button" aria-label="Inspect" onclick="fetch('/event?click')">`,
      `<button id="target" type="button" aria-label=" Reference " onclick="fetch('/event?click')">Inspect</button>`,
    ]) {
      const f = await fixture(body, 'click');
      try {
        await f.act();
        await delay(40);
        assert.equal(f.events.length, 1);
      } finally {
        await f.close();
      }
    }
  },
);

// A link wrapped over two lines. The 20ch monospace column breaks the same way on every platform: the first fragment ends line 1
// ("alpha"), the second starts line 2 ("xyz"), and the centre of the link's bounding box lies between them on the container's own text.
// The page reports that premise, so the tests cannot silently stop covering the bug if the layout ever changes.
const wrapped = (extraBody = '', linkStyle = '') =>
  `<div id="box" style="width:20ch;margin:40px;font:16px/22px monospace">Leading text <a id="target" style="${linkStyle}" aria-label="Reference" href="/elsewhere" onclick="fetch('/event?click=link@'+event.clientX+','+event.clientY);return false">alpha xyz</a> tail words follow</div>${extraBody}` +
  `<script>addEventListener('load',()=>{const a=document.getElementById('target'),b=a.getBoundingClientRect(),t=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);fetch('/event?premise='+a.getClientRects().length+','+(t===a||a.contains(t)?'on-link':'off-link')+'@'+[...a.getClientRects()].map(r=>[r.left,r.top,r.right,r.bottom].join(',')).join(';'))})</script>`;
const clicks = (events: string[]) => events.filter(e => e.startsWith('/event?click='));
const premise = async (events: string[]) => {
  await delay(60);
  return events.find(e => e.startsWith('/event?premise='));
};
type Rect = [number, number, number, number];
// The link's layout fragments as the page reported them, and where its click handler saw the click.
const fragmentsOf = (premiseEvent: string): Rect[] =>
  premiseEvent
    .split('@')[1]!
    .split(';')
    .map(rect => rect.split(',').map(Number) as Rect);
const landingOf = (events: string[]) => {
  const [x, y] = clicks(events)[0]!.split('@')[1]!.split(',').map(Number);
  return { x: x!, y: y! };
};
const within = (p: { x: number; y: number }, r: Rect) =>
  p.x >= r[0] - 1 && p.x < r[2] + 1 && p.y >= r[1] - 1 && p.y < r[3] + 1;
const refusedAsOccluded = (e: unknown) =>
  e instanceof AdlError && e.code === 'E_NOT_INTERACTABLE' && e.reason === 'occluded';
// A positioned element exactly over the link's first fragment (the second one stays free).
const coverFirstFragment =
  `<script>addEventListener('load',()=>{const a=document.getElementById('target'),f=a.getClientRects()[0],d=document.createElement('div');d.id='cover';` +
  `d.style.cssText='position:fixed;z-index:9;background:#fc0;left:'+(f.left-1)+'px;top:'+f.top+'px;width:'+(f.width+2)+'px;height:'+f.height+'px';` +
  `d.onclick=()=>fetch('/event?click=cover');document.body.append(d)})</script>`;
const modes: [string, Record<string, unknown>][] = [
  ['controls', {}],
  ['standard operation mode', { operationMode: 'standard' }],
];

for (const [mode, policy] of modes) {
  test(
    `real Chromium Engine clicks a link wrapped over two lines whose bounding-box centre is over other content (${mode})`,
    { timeout: 20000 },
    async () => {
      const f = await fixture(wrapped(), 'click', policy);
      try {
        const reported = (await premise(f.events)) ?? '';
        assert.match(reported, /^\/event\?premise=2,off-link@/);
        await f.act();
        await delay(60);
        assert.equal(clicks(f.events).length, 1);
        assert.match(clicks(f.events)[0]!, /^\/event\?click=link@/);
        // The click went to one of the link's own fragments, not to the (empty) centre of its bounding box.
        assert.ok(
          fragmentsOf(reported).some(rect => within(landingOf(f.events), rect)),
          JSON.stringify(f.events),
        );
      } finally {
        await f.close();
      }
    },
  );
  test(
    `real Chromium Engine refuses a wrapped link under a full-page modal overlay as occluded (${mode})`,
    { timeout: 20000 },
    async () => {
      const f = await fixture(
        wrapped('<div style="position:fixed;inset:0;z-index:50;background:#eee">Modal</div>'),
        'click',
        policy,
      );
      try {
        assert.match((await premise(f.events)) ?? '', /^\/event\?premise=2,/);
        await assert.rejects(f.act(), refusedAsOccluded);
        await delay(60);
        assert.deepEqual(clicks(f.events), []);
      } finally {
        await f.close();
      }
    },
  );
  test(
    `real Chromium Engine clicks the visible fragment of a wrapped link whose first fragment is covered (${mode})`,
    { timeout: 20000 },
    async () => {
      const f = await fixture(wrapped(coverFirstFragment), 'click', policy);
      try {
        const [first, second] = fragmentsOf((await premise(f.events)) ?? '');
        await f.act();
        await delay(60);
        // The covering element received nothing; the click reached the link through its second fragment, the only free one.
        assert.equal(clicks(f.events).length, 1);
        assert.match(clicks(f.events)[0]!, /^\/event\?click=link@/);
        assert.ok(
          within(landingOf(f.events), second!) && !within(landingOf(f.events), first!),
          JSON.stringify(f.events),
        );
      } finally {
        await f.close();
      }
    },
  );
  test(
    `real Chromium Engine dispatches at the verified fragment centre even when the wrapped link has borders (${mode})`,
    { timeout: 20000 },
    async () => {
      // Playwright measures a click position from the padding box; a wrong border correction would shift the click by the border width.
      const f = await fixture(wrapped('', 'border:3px solid #36c;padding:0 2px'), 'click', policy);
      try {
        const reported = (await premise(f.events)) ?? '';
        assert.match(reported, /^\/event\?premise=2,off-link@/);
        await f.act();
        await delay(60);
        const [first] = fragmentsOf(reported),
          landed = landingOf(f.events);
        assert.ok(
          Math.abs(landed.x - Math.floor((first![0] + first![2]) / 2)) <= 1 &&
            Math.abs(landed.y - Math.floor((first![1] + first![3]) / 2)) <= 1,
          JSON.stringify({ landed, first, events: f.events }),
        );
      } finally {
        await f.close();
      }
    },
  );
  test(`real Chromium Engine still clicks an ordinary single-line button (${mode})`, { timeout: 20000 }, async () => {
    const f = await fixture(
      `<button type="button" id="target" aria-label="Inspect" onclick="fetch('/event?click=button')">Inspect</button>`,
      'click',
      policy,
    );
    try {
      await f.act();
      await delay(60);
      assert.deepEqual(clicks(f.events), ['/event?click=button']);
    } finally {
      await f.close();
    }
  });
}
test(
  'real Chromium Engine scrolls a wrapped link into view before choosing its click point',
  { timeout: 20000 },
  async () => {
    const f = await fixture(`<div style="height:1800px"></div>${wrapped()}`, 'click');
    try {
      await f.act();
      await delay(60);
      assert.equal(clicks(f.events).length, 1);
      assert.match(clicks(f.events)[0]!, /^\/event\?click=link@/);
    } finally {
      await f.close();
    }
  },
);
test('real Chromium Engine refuses a wrapped link whose every fragment is covered', { timeout: 20000 }, async () => {
  const cover =
    `<script>addEventListener('load',()=>{const a=document.getElementById('target');for(const f of a.getClientRects()){const d=document.createElement('div');` +
    `d.style.cssText='position:fixed;z-index:9;background:#fc0;left:'+f.left+'px;top:'+f.top+'px;width:'+f.width+'px;height:'+f.height+'px';document.body.append(d)}})</script>`;
  const f = await fixture(wrapped(cover), 'click');
  try {
    await premise(f.events);
    await assert.rejects(f.act(), refusedAsOccluded);
    await delay(60);
    assert.deepEqual(clicks(f.events), []);
  } finally {
    await f.close();
  }
});
test(
  'real Chromium Engine clicks a wrapped link inside a form whose named controls shadow DOM APIs (CDP input path)',
  { timeout: 20000 },
  async () => {
    const f = await fixture(
      `<form onsubmit="return false"><input name="getAttribute" aria-label="Decoy" style="display:block;margin:0;width:100px;height:20px">${wrapped()}</form>`,
      'click',
      { operationMode: 'standard' },
    );
    try {
      const reported = (await premise(f.events)) ?? '';
      assert.match(reported, /^\/event\?premise=2,off-link@/);
      await f.act();
      await delay(60);
      assert.equal(clicks(f.events).length, 1);
      assert.match(clicks(f.events)[0]!, /^\/event\?click=link@/);
      assert.ok(
        fragmentsOf(reported).some(rect => within(landingOf(f.events), rect)),
        JSON.stringify(f.events),
      );
    } finally {
      await f.close();
    }
  },
);
