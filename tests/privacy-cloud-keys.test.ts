import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString } from '../src/policy.js';
import { redactApprovalText } from '../src/approval-summary.js';

// AWS documentation example credentials; not real keys.
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

test('AWS access key IDs and secret access keys are redacted in text and approval summaries', () => {
  for (const redact of [redactString, (value: string) => redactApprovalText(value)]) {
    assert.equal(redact(`Access key ${ACCESS_KEY}`), 'Access key [redacted]');
    assert.equal(redact(`ASIAY34FZKBOKMUTVV7A is temporary`), '[redacted] is temporary');
    assert.equal(redact(`Secret access key ${SECRET_KEY}`), 'Secret access key [redacted]');
    assert.equal(redact(`aws_secret_access_key=${SECRET_KEY}`), 'aws_secret_access_key=[redacted]');
    // A table cell holds the value without its label.
    assert.equal(redact(SECRET_KEY), '[redacted]');
    assert.equal(redact('k9Xq2LmN8pR4sT6vW1yZ3aB5cD7eF0gH2jK4lM6n'), '[redacted]');
  }
});

test('ordinary 40-character values stay readable', () => {
  const sha = '3f7bc39a1b2c3d4e5f60718293a4b5c6d7e8f901';
  assert.equal(redactString(`commit ${sha}`), `commit ${sha}`);
  assert.equal(redactString('pneumonoultramicroscopicsilicovolcanoconi'), 'pneumonoultramicroscopicsilicovolcanoconi');
  assert.equal(redactString('AKIA is the prefix of access key IDs'), 'AKIA is the prefix of access key IDs');
  const base64Blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==';
  assert.equal(redactString(base64Blob), base64Blob);
});

test('link destinations mask opaque path tokens but keep ordinary paths readable', async () => {
  const { redactLink } = await import('../src/policy.js');
  const page = 'https://shop.example/account';
  assert.equal(redactLink('https://shop.example/reset/Zx81kQp2LmN4vR7tW0yB3cD5eF', page), '/reset/[redacted]');
  assert.equal(
    redactLink('https://other.example/invite/k9Xq2LmN8pR4sT6vW1yZ3aB5/accept', page),
    'https://other.example/invite/[redacted]/accept',
  );
  assert.equal(
    redactLink('https://shop.example/blog/getting-started-with-agentdesklink-2026', page),
    '/blog/getting-started-with-agentdesklink-2026',
  );
  assert.equal(
    redactLink('https://shop.example/downloads/agentdesklink-0.1.6.vsix', page),
    '/downloads/agentdesklink-0.1.6.vsix',
  );
  assert.equal(
    redactLink('https://code.example/commit/3f7bc39a1b2c3d4e5f60718293a4b5c6d7e8f901', page),
    'https://code.example/commit/3f7bc39a1b2c3d4e5f60718293a4b5c6d7e8f901',
  );
  assert.equal(redactLink('https://shop.example/products/12345', page), '/products/12345');
});

test('link path segments made of words and numbers joined by underscores stay readable, mixed tokens stay masked', async () => {
  const { redactLink } = await import('../src/policy.js');
  const page = 'https://shop.example/account';
  // Three or more parts split on - or _, each only letters or only digits: a readable name, not a token.
  assert.equal(
    redactLink('https://shop.example/files/annual_report_2025_final_version', page),
    '/files/annual_report_2025_final_version',
  );
  assert.equal(
    redactLink('https://shop.example/files/Quarterly_Sales_Summary_2026_March', page),
    '/files/Quarterly_Sales_Summary_2026_March',
  );
  assert.equal(
    redactLink('https://shop.example/notes/meeting-notes_2026_march-summary_final', page),
    '/notes/meeting-notes_2026_march-summary_final',
  );
  assert.equal(
    redactLink('https://other.example/files/annual_report_2025_final_version/download', page),
    'https://other.example/files/annual_report_2025_final_version/download',
  );
  // Random tokens: mixed letter-digit parts, with or without separators.
  assert.equal(redactLink('https://shop.example/reset/Zk3pQ9vL2mX8rT5wY1nB7cD4', page), '/reset/[redacted]');
  assert.equal(redactLink('https://shop.example/reset/a8F_k2LmQ9-zXc4Vb7Nn1Qw3', page), '/reset/[redacted]');
  assert.equal(
    redactLink('https://shop.example/reset/dGhpc19_pc19hX3Rva2Vu-XzEyMzQ1Njc4OQ', page),
    '/reset/[redacted]',
  );
  assert.equal(redactLink('https://shop.example/reset/AbCd_Ef12Gh34_IjKlMnOpQr56', page), '/reset/[redacted]');
  // One mixed part, two parts only, or an empty part: not a readable name.
  assert.equal(redactLink('https://shop.example/files/annual_report_2025_final_v2_version', page), '/files/[redacted]');
  assert.equal(redactLink('https://shop.example/reset/abcdefghijklmnopqrstuvwx_1234567890', page), '/reset/[redacted]');
  assert.equal(redactLink('https://shop.example/files/annual__report_2025_final_version', page), '/files/[redacted]');
});
