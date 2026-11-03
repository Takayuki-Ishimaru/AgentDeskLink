import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELD_METHODS,
  describeApprovalForm,
  describeApprovalValue,
  describeHeldRequest,
  redactApprovalText,
} from '../src/approval-summary.js';

test('approval preserves the complete public value beyond snapshot and short-preview limits', () => {
  const value = 'Ordinary public paragraph. '.repeat(70) + '\nThe final sentence must be reviewed.';
  assert.ok(value.length > 512);
  assert.deepEqual(describeApprovalValue(value), { kind: 'public', length: value.length, preview: value });
  assert.equal(redactApprovalText(value), value);
  const limit = 'x'.repeat(4096);
  assert.deepEqual(describeApprovalValue(limit), { kind: 'public', length: 4096, preview: limit });
});

test('secret descriptions disclose only length, including structured secrets after character 512', () => {
  const raw = 'ordinary public context '.repeat(40) + 'password=CANARY_SECRET';
  assert.ok(raw.indexOf('CANARY_SECRET') > 512);
  assert.deepEqual(describeApprovalValue(raw), { kind: 'secret', length: raw.length });
  assert.ok(!redactApprovalText(raw).includes('CANARY_SECRET'));
  assert.deepEqual(describeApprovalValue('ordinary-looking-credential', true), { kind: 'secret', length: 27 });
});

test('form review includes the last field and complete multiline public contents', () => {
  const message = 'This is a public message. '.repeat(50) + '\nFinal reviewed paragraph.';
  const fields = [
    { name: 'message', value: message, secret: false },
    ...Array.from({ length: 22 }, (_, i) => ({ name: `entry${i}`, value: `public ${i}`, secret: false })),
    { name: 'last', value: 'Final field', secret: false },
  ];
  const lines = describeApprovalForm({ method: 'POST', url: 'https://example.com/send', fields });
  assert.equal(lines.length, 25);
  assert.ok(lines[1]!.includes(JSON.stringify(message)));
  assert.equal(lines[24], '"last": "Final field"');
  assert.throws(
    () =>
      describeApprovalForm({
        method: 'POST',
        url: 'https://example.com/send',
        fields: [...fields, { name: 'overflow', value: 'Must not silently disappear', secret: false }],
      }),
    { code: 'E_RESOURCE_LIMIT' },
  );
});

test('form credentials and hidden values never enter human-readable details', () => {
  const lines = describeApprovalForm({
    method: 'POST',
    url: 'https://example.com/send?token=CANARY_URL',
    fields: [
      { name: 'password', value: 'CANARY_PASSWORD', secret: true },
      { name: 'csrf', value: 'CANARY_HIDDEN', secret: true },
      { name: 'notes', value: 'prefix access_token=CANARY_INLINE', secret: false },
    ],
  });
  assert.ok(!JSON.stringify(lines).includes('CANARY_'));
  assert.ok(lines.slice(1).every(line => line.includes('[secret,')));
});

test('oversized consent text and total form details fail instead of truncating', () => {
  assert.throws(() => describeApprovalValue('x'.repeat(4097)), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(() => redactApprovalText('a\0b'), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(
    () =>
      describeApprovalForm({
        method: 'POST',
        url: 'https://example.com/send',
        fields: [
          { name: 'first', value: 'x'.repeat(4096), secret: false },
          { name: 'second', value: 'y'.repeat(4096), secret: false },
        ],
      }),
    { code: 'E_RESOURCE_LIMIT' },
  );
});

const JSON_TYPE = 'application/json';
const held = (body: string | undefined, contentType = JSON_TYPE, method = 'POST') =>
  describeHeldRequest({ method, url: 'https://example.com/api/tasks', contentType, body });
const HEADER = 'Request POST https://example.com/api/tasks';

test('held request: a JSON object lists every top-level key and masks secrets by key and by value', () => {
  const nonce = '3f1c1d52-0a7b-4f7e-9d3a-6f2b9a0c5e11';
  const { lines, secret } = held(
    JSON.stringify({
      title: 'Buy milk',
      nonce,
      password: 'hunter22',
      note: 'Authorization: Bearer abcdef123456',
      count: 3,
    }),
  );
  assert.deepEqual(lines, [
    HEADER,
    '"title": "Buy milk"',
    `"nonce": "${nonce}"`,
    '"password": [secret, 8 characters]',
    '"note": [secret, 34 characters]',
    '"count": 3',
  ]);
  assert.equal(secret, true);
  assert.ok(!JSON.stringify(lines).includes('hunter22'));
  assert.ok(!JSON.stringify(lines).includes('abcdef123456'));
  assert.deepEqual(held(JSON.stringify({ title: 'Buy milk', done: false, tags: ['a', 'b'] })), {
    lines: [HEADER, '"title": "Buy milk"', '"done": false', '"tags": ["a","b"]'],
    secret: false,
  });
});

test('held request: nested values are masked by key name before they are shown', () => {
  const { lines, secret } = held(
    JSON.stringify({
      user: { name: 'ann', card_number: '4111111111111111', profile: { apiKey: 'AKEYVALUE' } },
      items: [{ token: 'T0KEN', qty: 2 }],
    }),
  );
  assert.equal(secret, true);
  assert.deepEqual(lines.slice(1), [
    '"user": {"name":"ann","card_number":"[secret, 16 characters]","profile":{"apiKey":"[secret, 9 characters]"}}',
    '"items": [{"token":"[secret, 5 characters]","qty":2}]',
  ]);
  const text = JSON.stringify(lines);
  for (const canary of ['4111111111111111', 'AKEYVALUE', 'T0KEN']) assert.ok(!text.includes(canary), canary);
  // A key named like Object.prototype plumbing stays visible and its content is still masked.
  const proto = held('{"__proto__":{"password":"CANARY_PROTO"},"visible":"yes"}');
  assert.equal(proto.lines.length, 3);
  assert.equal(proto.lines[1], '"__proto__": {"password":"[secret, 12 characters]"}');
  assert.equal(proto.lines[2], '"visible": "yes"');
  assert.ok(!JSON.stringify(proto.lines).includes('CANARY_PROTO'));
});

test('held request: 24 JSON keys are described, 25 are refused instead of cut', () => {
  const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]));
  const ok = held(JSON.stringify(keys(24)));
  assert.equal(ok.lines.length, 25);
  assert.equal(ok.lines[24], '"k23": "v23"');
  assert.throws(() => held(JSON.stringify(keys(25))), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(() => held('['.repeat(40) + ']'.repeat(40)), { code: 'E_RESOURCE_LIMIT' });
});

test('held request: JSON array, scalar and empty object bodies are shown whole', () => {
  const array = held('[1,"two",{"password":"p"}]');
  assert.deepEqual(array.lines, [HEADER, 'Body (application/json): [1,"two",{"password":"[secret, 1 characters]"}]']);
  assert.equal(array.secret, true);
  assert.deepEqual(held('"just text"'), { lines: [HEADER, 'Body (application/json): "just text"'], secret: false });
  assert.equal(held('{}').lines[1], 'Body (application/json): {}');
  assert.equal(held('null').lines[1], 'Body (application/json): null');
});

test('held request: invalid JSON under application/json is described as text', () => {
  const body = '{"title": "unterminated';
  assert.deepEqual(held(body), {
    lines: [HEADER, `Body (text/plain, ${body.length} characters): ${JSON.stringify(body)}`],
    secret: false,
  });
  const secretText = held('not json password=CANARY_TEXT');
  assert.equal(secretText.secret, true);
  assert.ok(!JSON.stringify(secretText.lines).includes('CANARY_TEXT'));
});

test('held request: a urlencoded body lists its fields like a form', () => {
  const type = 'application/x-www-form-urlencoded; charset=UTF-8';
  const { lines, secret } = held('title=Buy+milk&token=abc123&note=hello%20there&password=&x=y', type, 'PUT');
  assert.deepEqual(lines, [
    'Request PUT https://example.com/api/tasks',
    '"title": "Buy milk"',
    '"token": [secret, 6 characters]',
    '"note": "hello there"',
    '"password": [secret, 0 characters]',
    '"x": "y"',
  ]);
  assert.equal(secret, true);
  const fields = Array.from({ length: 25 }, (_, i) => `f${i}=${i}`);
  assert.equal(held(fields.slice(0, 24).join('&'), type).lines.length, 25);
  assert.throws(() => held(fields.join('&'), type), { code: 'E_RESOURCE_LIMIT' });
});

test('held request: plain text, no body, PATCH and DELETE', () => {
  const plain = held('Remember to call Ann', 'text/plain;charset=utf-8');
  assert.deepEqual(plain, {
    lines: [HEADER, 'Body (text/plain, 20 characters): "Remember to call Ann"'],
    secret: false,
  });
  assert.match(held('a,b\n1,2', 'text/csv').lines[1]!, /^Body \(text\/plain, 7 characters\): /);
  const remove = describeHeldRequest({ method: 'DELETE', url: 'https://example.com/items/1', contentType: '' });
  assert.deepEqual(remove, { lines: ['Request DELETE https://example.com/items/1', '(no body)'], secret: false });
  assert.deepEqual(held('', JSON_TYPE, 'PATCH').lines, ['Request PATCH https://example.com/api/tasks', '(no body)']);
  assert.deepEqual([...HELD_METHODS].sort(), ['DELETE', 'PATCH', 'POST', 'PUT']);
});

test('held request: secret query values in the URL are redacted', () => {
  const { lines } = describeHeldRequest({
    method: 'POST',
    url: 'https://example.com/api/save?token=CANARY_QUERY&page=2',
    contentType: '',
  });
  assert.equal(lines[0], 'Request POST https://example.com/api/save?token=[redacted]&page=2');
  assert.ok(!JSON.stringify(lines).includes('CANARY_QUERY'));
});

test('held request: unsupported methods, content and sizes throw instead of being shortened', () => {
  for (const method of ['OPTIONS', 'GET', 'HEAD', 'post', 'TRACE'])
    assert.throws(() => held(undefined, '', method), { code: 'E_RESOURCE_LIMIT' }, method);
  assert.throws(() => held('--b\r\ncontent', 'multipart/form-data; boundary=b'), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(() => held('x'.repeat(8193), 'text/plain'), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(() => held('x'.repeat(8100), 'text/plain'), { code: 'E_RESOURCE_LIMIT' }); // the quoted line passes 8192
  assert.throws(() => held(JSON.stringify({ a: 'x'.repeat(4097) })), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(() => held(JSON.stringify({ a: 'y'.repeat(4096), b: 'z'.repeat(4096) })), {
    code: 'E_RESOURCE_LIMIT',
  });
  assert.throws(() => held('a\0b', 'text/plain'), { code: 'E_RESOURCE_LIMIT' });
  assert.throws(
    () => describeHeldRequest({ method: 'POST', url: 'https://example.com/' + 'a'.repeat(2048), contentType: '' }),
    { code: 'E_RESOURCE_LIMIT' },
  );
  assert.equal(
    held('x'.repeat(4000), 'text/plain').lines[1]!.length,
    'Body (text/plain, 4000 characters): '.length + 4002,
  );
});

test('held request: a custom key pattern replaces the default', () => {
  const body = JSON.stringify({ password: 'visible', pin_code: '1234' });
  assert.deepEqual(held(body).lines.slice(1), ['"password": [secret, 7 characters]', '"pin_code": "1234"']);
  const custom = describeHeldRequest(
    { method: 'POST', url: 'https://example.com/', contentType: JSON_TYPE, body },
    'pin_code',
  );
  assert.deepEqual(custom.lines.slice(1), ['"password": "visible"', '"pin_code": [secret, 4 characters]']);
});
