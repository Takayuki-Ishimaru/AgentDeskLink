import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactElement, redactElements } from '../src/policy.js';
import { SnapshotStore } from '../src/snapshot.js';

test('Japanese personal labels survive masking while instructions, product codes and event dates remain readable', () => {
  for (const [input, expected] of [
    ['氏名：架空 表子', '氏名：[redacted]'],
    ['氏名 | 架空 表子', '氏名 | [redacted]'],
    ['住所：東京都千代田区丸の内1-2-3', '住所：[redacted]'],
    ['郵便番号：123-4567', '郵便番号：[redacted]'],
    ['〒123-4567', '[redacted]'],
    ['氏名：必須項目です。漢字で入力してください。', '氏名：必須項目です。漢字で入力してください。'],
    ['氏名： 必須項目です。', '氏名： 必須項目です。'],
    ['氏名：漢字で入力してください。', '氏名：漢字で入力してください。'],
    ['製品番号：123-4567', '製品番号：123-4567'],
    ['品番: 123-4567', '品番: 123-4567'],
    ['東京都内で2026-11-04開催の勉強会', '東京都内で2026-11-04開催の勉強会'],
  ])
    assert.equal(redactString(input!), expected, input);
  assert.ok(!redactString('東京都港区芝公園4-2-8').includes('芝公園'));
});

test('mask reasons describe a rule without echoing the hidden value', () => {
  const masked = redactElement({ id: 'e', role: 'text', name: '郵便番号：123-4567', enabled: true });
  assert.deepEqual(masked.redaction_reasons, ['postal_code']);
  assert.ok(!JSON.stringify(masked).includes('123-4567'));
  assert.equal(
    redactElement({ id: 'p', role: 'text', name: '製品番号：123-4567', enabled: true }).redaction_reasons,
    undefined,
  );
});

test('structured row and column personal data is masked even when child cells repeat the value', () => {
  const elements = [
    { id: 't', role: 'table', name: '', enabled: true },
    { id: 'h', role: 'row', name: '氏名 | 状態', parent_id: 't', enabled: true },
    { id: 'hn', role: 'columnheader', name: '氏名', parent_id: 'h', enabled: true },
    { id: 'hs', role: 'columnheader', name: '状態', parent_id: 'h', enabled: true },
    { id: 'r', role: 'row', name: '架空 表子 | 完了', parent_id: 't', enabled: true },
    { id: 'n', role: 'cell', name: '架空 表子', parent_id: 'r', enabled: true },
    { id: 's', role: 'cell', name: '完了', parent_id: 'r', enabled: true },
  ];
  const safe = redactElements(elements);
  assert.equal(safe.find(e => e.id === 'n')?.name, '[redacted]');
  assert.equal(safe.find(e => e.id === 'hn')?.name, '氏名');
  assert.equal(safe.find(e => e.id === 's')?.name, '完了');
  assert.equal(redactElements(elements, true).find(e => e.id === 'n')?.name, '架空 表子');
});

test('personal opt-in does not reveal credentials or protected regions', () => {
  assert.equal(redactString('氏名 | 架空 表子', true), '氏名 | 架空 表子');
  for (const allow of [false, true]) {
    assert.ok(!redactString('password=CANARY_SECRET', allow).includes('CANARY_SECRET'));
    assert.equal(
      redactElement(
        { id: 'e', role: 'text', name: 'CANARY_SECRET', protected: true, sensitive: true, enabled: true },
        allow,
      ).name,
      '[redacted]',
    );
  }
});

test('flattened row and its synthetic child cell cannot leak through SnapshotStore', () => {
  const store = new SnapshotStore();
  store.record('s', 1, {
    fingerprint: 'a',
    truncated: false,
    elements: [
      { id: 'r', role: 'row', name: '氏名 | 架空 表子', enabled: true },
      { id: 'h', role: 'rowheader', name: '氏名', parent_id: 'r', enabled: true },
      { id: 'v', role: 'cell', name: '架空 表子', parent_id: 'r', enabled: true },
    ],
  });
  const result = store.observe('s', 1, { token_budget: 1800 });
  assert.ok(!JSON.stringify(result).includes('架空'));
});
