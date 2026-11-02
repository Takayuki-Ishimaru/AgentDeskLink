import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LEGACY_CONTROLS_PATTERN,
  POLICY_LABEL_PATTERN,
  NATIVE_LABEL_PATTERN,
  normalizeLabel,
  matchesLabelList,
  classifyLabel,
  isContainable,
} from '../src/action-classifier.js';
import type { ActionFacts, LabelVerdict, LabelLists } from '../src/action-classifier.js';
import type { Action } from '../src/types.js';

const ORIGIN = 'https://shop.example';
const NO: LabelLists = { allow: [], deny: [] };
const click: Action = { action: 'click' };
const press = (value: string): Action => ({ action: 'press', value });

const button = (name: string, extra: Partial<ActionFacts> = {}): ActionFacts => ({
  tag: 'button',
  type: 'button',
  role: 'button',
  name,
  submitterName: '',
  submit: false,
  method: 'GET',
  searchForm: false,
  inForm: false,
  link: null,
  dialog: null,
  ...extra,
});

// Builds the link facts exactly as the page-world collector will (design A.4): decoded,
// lower-cased path segments without one trailing extension (at most 32), and the
// values of the action-like query keys (lower-cased, at most 8).
const link = (name: string, href: string, opts: { download?: boolean; origin?: string } = {}): ActionFacts => {
  const pageOrigin = opts.origin ?? ORIGIN;
  let protocol = 'invalid';
  let sameOrigin = false;
  let segments: string[] = [];
  let actionValues: string[] = [];
  try {
    const u = new URL(href, pageOrigin);
    protocol = u.protocol;
    sameOrigin = u.origin === new URL(pageOrigin).origin;
    segments = u.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 32)
      .map(s => {
        try {
          s = decodeURIComponent(s);
        } catch {
          /* keep the raw segment */
        }
        return s.toLowerCase().replace(/\.[a-z0-9]{1,8}$/, '');
      });
    actionValues = [...u.searchParams]
      .filter(([k]) => /^(?:action|act|cmd|op|do|_method|method|task)$/i.test(k))
      .slice(0, 8)
      .map(([, value]) => value.toLowerCase());
  } catch {
    /* an invalid href is classified like a button */
  }
  return {
    ...button(name, { tag: 'a', type: '', role: 'link' }),
    link: { protocol, sameOrigin, download: opts.download === true, segments, actionValues },
  };
};

const inDialog = (facts: ActionFacts, dialogName: string): ActionFacts => ({
  ...facts,
  dialog: { name: dialogName },
});

const v = (consequential: boolean, reason: LabelVerdict['reason'] = null): LabelVerdict => ({
  consequential,
  reason,
});

const verdict = (facts: ActionFacts, action: Action = click, lists: LabelLists = NO) =>
  classifyLabel(facts, action, lists);

// Each row: label -> expected verdict, checked for a plain button on click.
function buttons(rows: [string, LabelVerdict][], action: Action = click) {
  for (const [name, expected] of rows)
    test(`button ${JSON.stringify(name)} -> ${expected.consequential ? 'consequential' : 'ordinary'}${expected.reason ? ` (${expected.reason})` : ''}`, () => {
      assert.deepEqual(verdict(button(name), action), expected);
    });
}

// ---- Dismiss idiom -------------------------------------------------------

test('bare Cancel button in a dialog is the dismiss idiom: ordinary, no reason', () => {
  assert.deepEqual(verdict(inDialog(button('Cancel'), 'Delete this item?')), v(false));
});

buttons([
  ['Cancel', v(false)],
  ['キャンセル', v(false)],
  ['取消', v(false)],
  ['取消し', v(false)],
  ['取り消し', v(false)],
  ['× Cancel', v(false)],
  ['Ｃａｎｃｅｌ', v(false)],
  ['Cancel Cancel', v(false)], // aria-label and text both name the button
  ['Cancel order', v(true, 'label')],
  ['注文をキャンセル', v(true, 'label')],
  ['Cancel subscription', v(true, 'label')],
]);

// ---- Order / 注文 ----------------------------------------------------------

buttons([
  ['Sort order', v(false)],
  ['Order details', v(false)],
  ['Order history', v(false)],
  ['My orders', v(false)],
  ['注文履歴', v(false)],
  ['注文詳細', v(false)],
  ['Order', v(true, 'label')],
  ['Order now', v(true, 'label')],
  ['Place order', v(true, 'label')],
  ['Complete your order', v(true, 'label')],
  ['Reorder', v(true, 'label')],
  ['Buy', v(true, 'label')],
  ['Buy now', v(true, 'label')],
  ['Buy it again', v(true, 'label')],
  ['注文する', v(true, 'label')],
  ['この内容で注文', v(true, 'label')],
]);

// ---- 登録 / Register ---------------------------------------------------------

buttons([
  ['お気に入りに登録', v(false)],
  ['カレンダーに登録', v(false)],
  ['登録済み', v(false)],
  ['登録', v(true, 'label')],
  ['会員登録', v(true, 'label')],
  ['Register', v(true, 'label')],
  ['Sign up', v(true, 'label')],
]);

// ---- Commit words outside / inside dialogs -----------------------------------

buttons([
  ['確定', v(false)],
  ['Confirm', v(false)],
  ['OK', v(false)],
  ['はい', v(false)],
]);

test('only the verbs that may stay in the session are containable', () => {
  const containable = (facts: ActionFacts, action: Action = { action: 'click' }) =>
    isContainable(facts, action, classifyLabel(facts, action, { allow: [], deny: [] }));
  for (const name of ['Delete', 'Remove', 'Delete Buy milk', '削除', '削除する', 'Delete account'])
    assert.equal(containable(button(name)), true, name);
  for (const name of ['Delete and send', 'Delete order', 'Remove and pay', 'Submit', 'Send', 'Archive', 'Reset', 'Go'])
    assert.equal(containable(button(name)), false, name);
  assert.equal(containable(inDialog(button('OK'), 'Delete this item?')), true);
  assert.equal(containable(inDialog(button('OK'), 'Delete and send?')), false);
  assert.equal(containable(inDialog(button('OK'), '注文を確定しますか')), false);
  assert.equal(containable(button('Delete'), { action: 'press', value: 'Enter' }), true);
  assert.equal(containable(button('Delete'), { action: 'select', value: 'x' }), false);
  assert.equal(containable(button('Delete'), { action: 'check', checked: true }), false);
  const deny = classifyLabel(button('Delete'), { action: 'click' }, { allow: [], deny: ['Delete'] });
  assert.equal(isContainable(button('Delete'), { action: 'click' }, deny), false, 'the deny list is final');
});

test('affirmative buttons inherit the verdict of the dialog they confirm', () => {
  for (const dialog of ['Delete this item?', '注文を確定しますか'])
    for (const name of ['Confirm', 'OK', 'はい', '確定'])
      assert.deepEqual(
        verdict(inDialog(button(name), dialog)),
        v(true, 'dialog'),
        `${name} in ${JSON.stringify(dialog)}`,
      );
});

test('a name that repeats the affirmative idiom (aria-label + text) still inherits the dialog', () => {
  assert.deepEqual(verdict(inDialog(button('OK OK'), 'Delete this item?')), v(true, 'dialog'));
  assert.deepEqual(verdict(inDialog(button('はい はい'), '注文を確定しますか')), v(true, 'dialog'));
  assert.deepEqual(verdict(inDialog(button('OK for now'), 'Delete this item?')), v(false));
});

test('Cancel inside a consequential dialog stays ordinary', () => {
  for (const dialog of ['Delete this item?', '注文を確定しますか'])
    assert.deepEqual(verdict(inDialog(button('Cancel'), dialog)), v(false), dialog);
});

test('an affirmative button in a harmless dialog stays ordinary', () => {
  for (const dialog of ['Settings', 'Order history', 'Sort order', ''])
    for (const name of ['OK', 'Confirm', '確定'])
      assert.deepEqual(verdict(inDialog(button(name), dialog)), v(false), `${name} in ${JSON.stringify(dialog)}`);
});

test('dialog inheritance does not turn other labels into consequential ones', () => {
  assert.deepEqual(verdict(inDialog(button('Close'), 'Delete this item?')), v(false));
  assert.deepEqual(verdict(inDialog(button('Show details'), 'Delete this item?')), v(false));
});

// ---- Delete / Remove -----------------------------------------------------------

test('"Delete Buy milk" (a ToDo delete) is documented to stay gated', () => {
  assert.deepEqual(verdict(button('Delete Buy milk')), v(true, 'label'));
});

buttons([
  ['Delete', v(true, 'label')],
  ['Remove', v(true, 'label')],
  ['Remove filter', v(false)],
  ['Remove filters', v(false)],
  ['Remove selection', v(false)],
]);

// ---- New verbs ----------------------------------------------------------------

buttons([
  ['Unsubscribe', v(true, 'label')],
  ['Opt out', v(true, 'label')],
  ['配信停止', v(true, 'label')],
  ['登録解除', v(true, 'label')],
  ['退会', v(true, 'label')],
  ['Archive', v(true, 'label')],
  ['Unarchive', v(true, 'label')],
  ['アーカイブ', v(true, 'label')],
  ['Reset', v(true, 'label')],
  ['Reset password', v(true, 'label')],
  ['Factory reset', v(true, 'label')],
  ['リセット', v(true, 'label')],
  ['Reset filters', v(false)],
  ['Reset view', v(false)],
  ['フィルターをリセット', v(false)],
  ['Clear', v(true, 'label')],
  ['Clear cart', v(true, 'label')],
  ['Clear history', v(true, 'label')],
  ['クリア', v(true, 'label')],
  ['Clear filters', v(false)],
  ['Clear all filters', v(false)],
  ['Clear search', v(false)],
  ['検索条件をクリア', v(false)],
  ['Log out', v(true, 'label')],
  ['Sign out', v(true, 'label')],
  ['ログアウト', v(true, 'label')],
]);

// ---- Payment ----------------------------------------------------------------------

buttons([
  ['Payment methods', v(false)],
  ['支払方法', v(false)],
  ['決済履歴', v(false)],
  ['Pay', v(true, 'label')],
  ['Pay now', v(true, 'label')],
  ['Make a payment', v(true, 'label')],
  ['支払う', v(true, 'label')],
]);

// ---- Links ---------------------------------------------------------------------

test('same-origin navigation links are not gated by the button vocabulary', () => {
  const rows: [string, string][] = [
    ['How to cancel', '/help/how-to-cancel'],
    ['Order history', '/orders'],
    ['Order details', '/orders/42'],
    ['Pay bills', '/billing/pay'],
    ['Register', '/register'],
    ['Delete policy', '/legal/delete-policy'],
  ];
  for (const [name, href] of rows) assert.deepEqual(verdict(link(name, href)), v(false), `${name} ${href}`);
});

test('same-origin links with an imperative verb label are gated (link_verb)', () => {
  const rows: [string, string][] = [
    ['Log out', '/account'],
    ['Unsubscribe', '/u/opaque123'],
    ['Delete', '/items/1'],
  ];
  for (const [name, href] of rows) assert.deepEqual(verdict(link(name, href)), v(true, 'link_verb'), `${name} ${href}`);
});

test('same-origin links with an action word in the URL are gated (link_url)', () => {
  const rows: [string, string][] = [
    ['Details', '/orders/42/cancel'],
    ['Go', '/logout'],
    ['Continue', '/x?action=delete'],
    ['Open', '/api/remove.php'],
  ];
  for (const [name, href] of rows) assert.deepEqual(verdict(link(name, href)), v(true, 'link_url'), `${name} ${href}`);
});

test('a link with a download attribute is gated (download)', () => {
  assert.deepEqual(verdict(link('Report', '/reports/q3.pdf', { download: true })), v(true, 'download'));
});

test('cross-origin links keep the full button vocabulary', () => {
  assert.deepEqual(verdict(link('Order history', 'https://other.example/orders')), v(false));
  assert.deepEqual(verdict(link('Delete account', 'https://other.example/account')), v(true, 'label'));
  // The destination of a cross-origin link is not judged by its path.
  assert.deepEqual(verdict(link('Details', 'https://other.example/logout')), v(false));
});

test('javascript: and missing hrefs are classified as buttons', () => {
  assert.deepEqual(verdict(link('Delete', 'javascript:void(0)')), v(true, 'label'));
  assert.deepEqual(
    verdict({ ...button('Delete', { tag: 'a', type: '', role: 'link' }), link: null }),
    v(true, 'label'),
  );
  assert.deepEqual(verdict(link('Details', 'javascript:void(0)')), v(false));
});

test('link rules extras: unlabeled link, documentation nouns and faceted navigation', () => {
  // An icon-only link has no name; the destination still decides.
  assert.deepEqual(verdict(link('', '/logout')), v(true, 'link_url'));
  assert.deepEqual(verdict(link('', '/orders')), v(false));
  // URL segments are whole words: a longer slug is not an action word.
  assert.deepEqual(verdict(link('Open', '/legal/delete-policy')), v(false));
  assert.deepEqual(verdict(link('Open', '/a/Logout.php')), v(true, 'link_url'));
  assert.deepEqual(verdict(link('Open', '/x?method=DELETE')), v(true, 'link_url'));
  assert.deepEqual(verdict(link('Open', '/x?next=delete')), v(false));
  // Verbs inside a longer label are not "imperative at the start".
  assert.deepEqual(verdict(link('Deleted items', '/trash')), v(false));
  assert.deepEqual(verdict(link('Remove filters', '/products')), v(false));
  assert.deepEqual(verdict(link('削除', '/items/1')), v(true, 'link_verb'));
  assert.deepEqual(verdict(link('ログアウト', '/account')), v(true, 'link_verb'));
});

// ---- Which actions are gated ------------------------------------------------------

test('fill is never label-gated; Enter gates the form submitter, not the textbox label', () => {
  const textbox = button('Delete reason', { tag: 'input', type: 'text', role: 'textbox' });
  assert.deepEqual(verdict(textbox, { action: 'fill', value: 'x' }), v(false));
  assert.deepEqual(verdict(textbox, { action: 'hover' }), v(false));
  assert.deepEqual(verdict(textbox, { action: 'scroll' }), v(false));
  assert.deepEqual(
    verdict({ ...textbox, submit: true, inForm: true, submitterName: 'Delete' }, press('Enter')),
    v(true, 'label'),
  );
  assert.deepEqual(verdict(textbox, press('Enter')), v(false));
  assert.deepEqual(verdict({ ...textbox, tag: 'textarea', type: 'textarea' }, press('Enter')), v(false));
});

test('Enter in a search form activates the Search submitter: ordinary', () => {
  const field = button('Search products', {
    tag: 'input',
    type: 'search',
    role: 'textbox',
    submit: true,
    method: 'GET',
    searchForm: true,
    inForm: true,
    submitterName: 'Search',
  });
  assert.deepEqual(verdict(field, press('Enter')), v(false));
  // "submit" as a word is only a signal outside search forms.
  assert.deepEqual(verdict(button('Submit', { searchForm: true })), v(false));
  assert.deepEqual(verdict(button('Submit')), v(true, 'label'));
  assert.deepEqual(verdict(button('Submit order', { searchForm: true })), v(true, 'label'));
});

test('press other than Enter/Space and non-activating actions are not gated', () => {
  const del = button('Delete');
  for (const a of ['Escape', 'Tab', 'ArrowDown', 'Home']) assert.deepEqual(verdict(del, press(a)), v(false), a);
  assert.deepEqual(verdict(del, { action: 'hover' }), v(false));
  assert.deepEqual(verdict(del, { action: 'scroll' }), v(false));
  assert.deepEqual(verdict(del, { action: 'back' }), v(false));
  assert.deepEqual(verdict(del, { action: 'navigate', url: 'https://x.example/' }), v(false));
  assert.deepEqual(verdict(del, { action: 'read_state' }), v(false));
  assert.deepEqual(verdict(del, press('Enter')), v(true, 'label'));
  assert.deepEqual(verdict(del, press('Space')), v(true, 'label'));
});

test('press on a custom button or checkbox is gated by its own label', () => {
  const custom = button('Delete', { tag: 'div', type: '', role: 'button' });
  assert.deepEqual(verdict(custom, press('Enter')), v(true, 'label'));
  const box = button('Delete all', { tag: 'input', type: 'checkbox', role: 'checkbox' });
  assert.deepEqual(verdict(box, press('Space')), v(true, 'label'));
});

test('select and check are label-gated', () => {
  const select = button('Delete order', { tag: 'select', type: 'select-one', role: 'combobox' });
  assert.deepEqual(verdict(select, { action: 'select', value: 'x' }), v(true, 'label'));
  const all = button('Delete all', { tag: 'input', type: 'checkbox', role: 'checkbox' });
  assert.deepEqual(verdict(all, { action: 'check', checked: true }), v(true, 'label'));
  const sel = button('Select all', { tag: 'input', type: 'checkbox', role: 'checkbox' });
  assert.deepEqual(verdict(sel, { action: 'check', checked: true }), v(false));
});

// ---- User label lists -------------------------------------------------------------

test('allow list: whole label or whole word, never a prefix', () => {
  const lists: LabelLists = { allow: ['Delete'], deny: [] };
  assert.deepEqual(verdict(button('Delete Buy milk'), click, lists), v(false, 'allow_list'));
  assert.deepEqual(verdict(button('Delete'), click, lists), v(false, 'allow_list'));
  assert.deepEqual(verdict(button('Deleted'), click, lists), v(false));
  assert.deepEqual(verdict(button('Delete Buy milk'), click, { allow: ['Del'], deny: [] }), v(true, 'label'));
  // Every label of the control must be allowed.
  assert.deepEqual(
    verdict({ ...button('Save', { submit: true, inForm: true }), submitterName: 'Delete all' }, press('Enter'), {
      allow: ['Save'],
      deny: [],
    }),
    v(true, 'label'),
  );
});

test('allow list with Japanese entries matches as a substring after the する strip', () => {
  assert.deepEqual(verdict(button('削除する'), click, { allow: ['削除'], deny: [] }), v(false, 'allow_list'));
  assert.deepEqual(verdict(button('削除する'), click, { allow: ['削除する'], deny: [] }), v(false, 'allow_list'));
  assert.deepEqual(verdict(button('商品を削除'), click, { allow: ['削除'], deny: [] }), v(false, 'allow_list'));
});

test('deny list beats the allow list and the dismiss idiom', () => {
  assert.deepEqual(verdict(button('Details'), click, { allow: ['Details'], deny: ['Details'] }), v(true, 'deny_list'));
  assert.deepEqual(verdict(button('Details'), click, { allow: [], deny: ['Details'] }), v(true, 'deny_list'));
  assert.deepEqual(verdict(button('Cancel'), click, { allow: [], deny: ['cancel'] }), v(true, 'deny_list'));
  assert.deepEqual(
    verdict(link('Order history', '/orders'), click, { allow: [], deny: ['order history'] }),
    v(true, 'deny_list'),
  );
  assert.deepEqual(verdict(button('Order history'), click, { allow: [], deny: ['履歴'] }), v(false));
  assert.deepEqual(verdict(button('注文履歴'), click, { allow: [], deny: ['履歴'] }), v(true, 'deny_list'));
});

test('deny list only gates activating actions', () => {
  const lists: LabelLists = { allow: [], deny: ['Reason'] };
  const textbox = button('Reason', { tag: 'input', type: 'text', role: 'textbox' });
  assert.deepEqual(verdict(textbox, { action: 'fill', value: 'x' }, lists), v(false));
  assert.deepEqual(verdict(button('Reason'), click, lists), v(true, 'deny_list'));
});

test('allow list can clear a link verb and a URL action word but never a download', () => {
  const allow: LabelLists = { allow: ['Log out', 'Go'], deny: [] };
  assert.deepEqual(verdict(link('Log out', '/account'), click, allow), v(false, 'allow_list'));
  assert.deepEqual(verdict(link('Go', '/logout'), click, allow), v(false, 'allow_list'));
  assert.deepEqual(verdict(link('Log out', '/x.zip', { download: true }), click, allow), v(true, 'download'));
});

test('allow list does not touch the verdict of a POST form submit button label (WP2 adds submitRisk)', () => {
  // The label verdict is ordinary and says why; classifyLabel never sees submitRisk.
  const submit = button('Save', { tag: 'button', type: 'submit', submit: true, method: 'POST', inForm: true });
  assert.deepEqual(verdict(submit, click, { allow: ['Save'], deny: [] }), v(false, 'allow_list'));
  assert.deepEqual(verdict(submit), v(false));
});

test('allow list entries never relax a credential field fill (label verdict of fill is not gated)', () => {
  const password = button('Password', { tag: 'input', type: 'password', role: 'textbox' });
  assert.deepEqual(verdict(password, { action: 'fill', value: 'x' }, { allow: ['Password'], deny: [] }), v(false));
});

test('an allow list entry does not clear an unrelated label', () => {
  assert.deepEqual(verdict(button('Delete Buy milk'), click, { allow: ['Save'], deny: [] }), v(true, 'label'));
  assert.deepEqual(verdict(button(''), click, { allow: ['Save'], deny: [] }), v(false));
});

test('matchesLabelList: exact, ASCII whole word, non-ASCII substring', () => {
  assert.equal(matchesLabelList('Delete Buy milk', ['delete']), true);
  assert.equal(matchesLabelList('Please delete now', ['Delete']), true);
  assert.equal(matchesLabelList('Deleted', ['delete']), false);
  assert.equal(matchesLabelList('Undelete', ['delete']), false);
  assert.equal(matchesLabelList('Buy milk', ['milk']), true);
  assert.equal(matchesLabelList('Save & close', ['save & close']), true);
  assert.equal(matchesLabelList('Delete', ['Delete!']), true); // edge punctuation is not significant
  assert.equal(matchesLabelList('ＤｅｌｅｔｅＩｔｅｍ', ['delete item']), true);
  assert.equal(matchesLabelList('商品を削除する', ['削除']), true);
  assert.equal(matchesLabelList('商品', ['削除']), false);
  assert.equal(matchesLabelList('', ['x']), false);
  assert.equal(matchesLabelList('Delete', []), false);
  assert.equal(matchesLabelList('Delete', ['', '  ']), false);
});

// ---- normalizeLabel --------------------------------------------------------------

test('normalizeLabel: NFKC, camelCase splits, case, whitespace, edge punctuation, suffix', () => {
  assert.equal(normalizeLabel('Ｃａｎｃｅｌ'), 'cancel');
  assert.equal(normalizeLabel('ＤｅｌｅｔｅＩｔｅｍ'), 'delete item');
  assert.equal(normalizeLabel('deleteItem2'), 'delete item 2');
  assert.equal(normalizeLabel('HTMLParser'), 'html parser');
  assert.equal(normalizeLabel('  ×  Cancel...  '), 'cancel');
  assert.equal(normalizeLabel('Delete\n\t  item'), 'delete item');
  assert.equal(normalizeLabel('削除する'), '削除');
  assert.equal(normalizeLabel('削除します'), '削除');
  assert.equal(normalizeLabel('削除しますか？'), '削除');
  assert.equal(normalizeLabel('…'), '');
  assert.equal(normalizeLabel(''), '');
});

// ---- Frozen vocabularies ---------------------------------------------------------

// The legacy controls classifier (browser.ts), authorizeAction (policy.ts) and the native
// tiers must keep deciding exactly as before: the exact regex sources are pinned here.
test('frozen legacy vocabularies keep their exact sources', () => {
  assert.equal(
    LEGACY_CONTROLS_PATTERN,
    String.raw`\b(?:delete|remove(?!\s+filter\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)\b`,
  );
  assert.equal(
    POLICY_LABEL_PATTERN,
    String.raw`\b(?:delete|remove(?!\s+filters?\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)\b|削除|購入|注文|決済|支払|送信|申込|申し込|登録|解約|振込|送金|確定|ログイン`,
  );
  assert.equal(
    NATIVE_LABEL_PATTERN,
    String.raw`\b(?:delete|remove(?!\s+filters?\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer|confirm|cancel|order)\b|削除|購入|注文|支払|決済|送信|登録|取消|取り消|キャンセル|振込|送金|転送|申込|申し込|解約|確定|ログイン`,
  );
});

test('frozen vocabularies still decide the way the legacy and native tiers did', () => {
  const legacy = new RegExp(LEGACY_CONTROLS_PATTERN, 'i');
  const policy = new RegExp(POLICY_LABEL_PATTERN, 'iu');
  const native = new RegExp(NATIVE_LABEL_PATTERN, 'iu');
  for (const label of ['Delete', 'remove item', 'Pay now', 'Log in', 'Sign up', 'Submit']) {
    assert.ok(legacy.test(label), `legacy ${label}`);
    assert.ok(policy.test(label), `policy ${label}`);
    assert.ok(native.test(label), `native ${label}`);
  }
  // Legacy controls have no Japanese vocabulary and treat "Remove filter" as ordinary.
  assert.ok(!legacy.test('削除') && policy.test('削除') && native.test('削除'));
  assert.ok(!legacy.test('Remove filter') && !policy.test('Remove filters') && !native.test('Remove filters'));
  assert.ok(!legacy.test('Payload viewer') && !policy.test('Payload viewer'));
  // Cancel / order / confirm are consequential for the native helpers only.
  for (const label of ['Cancel', 'Order', 'Confirm', 'キャンセル', '取り消し']) {
    assert.ok(native.test(label), `native ${label}`);
    assert.ok(!legacy.test(label), `legacy ${label}`);
  }
  assert.ok(!policy.test('Cancel') && !policy.test('Order') && !policy.test('キャンセル'));
  // The tier classifier does not share these words: bare "Cancel" is a dismiss idiom there.
  assert.deepEqual(verdict(button('Cancel')), v(false));
});

test('browser.ts and policy.ts import the frozen constants instead of repeating the literals', () => {
  const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
  const browser = source('browser.ts'),
    policy = source('policy.ts');
  assert.match(browser, /LEGACY_CONTROLS_PATTERN/);
  assert.match(policy, /new RegExp\(POLICY_LABEL_PATTERN, 'iu'\)/);
  assert.match(policy, /new RegExp\(NATIVE_LABEL_PATTERN, 'iu'\)/);
  assert.ok(!/withdraw\|transfer/.test(browser), 'no vocabulary literal left in browser.ts');
  assert.ok(!/withdraw\|transfer/.test(policy), 'no vocabulary literal left in policy.ts');
});

test('a to-do item that starts with "Buy" is ordinary: only the bare verb and its checkout phrases are gated', () => {
  for (const name of ['Buy milk', 'Buy groceries for the weekend', 'buy-in meeting'])
    assert.deepEqual(verdict(button(name)), v(false, null), name);
  const checkbox = button('Buy milk', { tag: 'input', type: 'checkbox', role: 'checkbox' });
  assert.deepEqual(verdict(checkbox, { action: 'check', checked: true }), v(false, null));
});
