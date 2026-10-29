import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeApprovalForm, describeApprovalValue, redactApprovalText } from '../src/approval-summary.js';

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
