import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import type { BrowserContext } from 'playwright';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';

test('browser reads long text in redacted chunks and retains table and list grouping', { timeout: 60000 }, async () => {
  const long = '\u65e5\u672c\u8a9e'.repeat(300);
  const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>Value ${i + 1}</td></tr>`).join('');
  const html = `<p>${long}</p><p>Public alice@example.com <span data-adl-sensitive>PRIVATE_CANARY</span><label for="password"><span>PASSWORD_LABEL_CANARY</span></label><input id="password" type="password" value="PASSWORD_CANARY"><script>secret</script> done</p><table><tbody>${rows}</tbody></table><ul><li>List item</li></ul>`;
  const server = createServer((_, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  let session: AdapterSession | undefined;
  try {
    session = await adapter.open(
      {
        target_id: 'p',
        surface: 'browser',
        application_id: 'p',
        label: 'Fixture',
        capabilities: [],
        policy_class: 'PUBLIC',
      },
      'strict_isolated',
      new AbortController().signal,
    );
    const snapshot = await session.snapshot();
    const paragraph = snapshot.elements.find(e => e.name.startsWith('\u65e5\u672c\u8a9e'))!;
    assert.ok(paragraph);
    assert.equal(paragraph.name_truncated, true);
    assert.equal(paragraph.text_length, long.length);
    assert.equal(snapshot.truncated, false);
    const read = session as AdapterSession & {
      readText: (
        id: string,
        offset: number,
        length: number,
        signal: AbortSignal,
      ) => Promise<{ text: string; total_length: number; next_offset: number | null; truncated: boolean }>;
    };
    const signal = new AbortController().signal;
    const one = await read.readText(paragraph.id, 0, 510, signal),
      two = await read.readText(paragraph.id, one.next_offset!, 1000, signal);
    assert.equal(one.total_length, long.length);
    assert.equal(one.text + two.text, long);
    assert.equal(two.next_offset, null);
    const textNode = snapshot.elements.find(e => e.name.startsWith('Public alice'))!;
    assert.ok(textNode);
    const redacted = await read.readText(textNode.id, 0, 1000, signal);
    assert.ok(!redacted.text.includes('alice@example.com'));
    assert.ok(!redacted.text.includes('PRIVATE_CANARY'));
    assert.ok(!redacted.text.includes('PASSWORD_LABEL_CANARY'));
    assert.ok(!redacted.text.includes('PASSWORD_CANARY'));
    const label = snapshot.elements.find(e => e.name === 'PASSWORD_LABEL_CANARY');
    assert.ok(label);
    assert.equal((await read.readText(label.id, 0, 100, signal)).text, '');
    const left = await read.readText(textNode.id, 0, 9, signal),
      right = await read.readText(textNode.id, 9, 1000, signal);
    assert.equal(left.text + right.text, redacted.text);
    policy.allowPersonalData = true;
    const allowed = await read.readText(textNode.id, 0, 1000, signal);
    assert.ok(allowed.text.includes('alice@example.com'));
    assert.ok(!allowed.text.includes('PRIVATE_CANARY'));
    const page = (session as unknown as { context: BrowserContext }).context.pages()[0]!;
    await page.evaluate(() => {
      Object.defineProperty(Element.prototype, 'matches', { value: () => false, configurable: true });
      Document.prototype.createTreeWalker = () => {
        throw new Error('forged page method');
      };
    });
    const hostile = await read.readText(textNode.id, 0, 1000, signal);
    assert.ok(!hostile.text.includes('PRIVATE_CANARY'));
    assert.ok(!hostile.text.includes('PASSWORD_LABEL_CANARY'));
    const row = snapshot.elements.find(e => e.name === 'Row 2000 | Value 2000' && e.role === 'row')!;
    assert.ok(row);
    assert.equal(snapshot.elements.find(e => e.id === row.parent_id)?.role, 'table');
    assert.ok(
      !snapshot.elements.some(e => e.role === 'cell' && e.parent_id === row.id),
      'plain cells are carried by the row name',
    );
    const listitem = snapshot.elements.find(e => e.name === 'List item' && e.role === 'listitem')!;
    assert.ok(listitem);
    assert.equal(snapshot.elements.find(e => e.id === listitem.parent_id)?.role, 'list');
  } finally {
    await session?.close();
    await adapter.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
