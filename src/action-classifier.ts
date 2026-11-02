// Shared consequential-operation classifier (design V0.1.7 Part A).
// Pure module: no DOM, no imports except the Action type.
import type { Action } from './types.js';

// Frozen legacy vocabularies. Each constant is the exact regex source string of
// the literal it replaced; src/browser.ts and src/policy.ts import them, so the
// CLI controls allowlist and the native tiers keep deciding exactly as before.
// tests/action-classifier.test.ts pins the exact strings.

// Page-world classifier of the legacy controls allowlist in src/browser.ts (flags: 'i').
export const LEGACY_CONTROLS_PATTERN =
  '\\b(?:delete|remove(?!\\s+filter\\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\\s*in|sign\\s*in|sign\\s*up|register|withdraw|transfer)\\b';

// authorizeAction's CONSEQUENTIAL in src/policy.ts (flags: 'iu').
export const POLICY_LABEL_PATTERN =
  '\\b(?:delete|remove(?!\\s+filters?\\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\\s*in|sign\\s*in|sign\\s*up|register|withdraw|transfer)\\b|削除|購入|注文|決済|支払|送信|申込|申し込|登録|解約|振込|送金|確定|ログイン';

// The native helpers' vocabulary, NATIVE_CONSEQUENTIAL in src/policy.ts (flags: 'iu').
export const NATIVE_LABEL_PATTERN =
  '\\b(?:delete|remove(?!\\s+filters?\\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\\s*in|sign\\s*in|sign\\s*up|register|withdraw|transfer|confirm|cancel|order)\\b|削除|購入|注文|支払|決済|送信|登録|取消|取り消|キャンセル|振込|送金|転送|申込|申し込|解約|確定|ログイン';

export interface LabelLists {
  allow: string[];
  deny: string[];
}

export interface ActionFacts {
  tag: string;
  type: string;
  role: string;
  name: string;
  submitterName: string;
  submit: boolean;
  method: string;
  searchForm: boolean;
  inForm: boolean;
  link: null | {
    protocol: string;
    sameOrigin: boolean;
    download: boolean;
    segments: string[];
    actionValues: string[];
  };
  dialog: null | { name: string };
}

export type LabelVerdict = {
  consequential: boolean;
  reason: 'deny_list' | 'allow_list' | 'label' | 'link_verb' | 'link_url' | 'download' | 'dialog' | 'dismiss' | null;
};

// Tier vocabularies (flags 'iu'), matched against normalizeLabel output.
const EN_WORDS_SOURCE =
  '\\b(?:delete|remove(?!\\s+(?:filters?|sorting|selection)\\b)|upload|send|purchase|buy(?=$|\\s+(?:now|it|again|this|these|all|tickets?)\\b)|checkout|pay|subscribe|unsubscribe|opt\\s*out|register|sign\\s*up|login|log\\s*in|sign\\s*in|logout|log\\s*out|sign\\s*out|withdraw|transfer|archive|unarchive|publish|unpublish|approve|revoke|deactivate|reset(?!\\s+(?:filters?|search|selection|sort|form|view|zoom|layout)\\b)|clear(?!\\s+(?:all\\s+)?(?:filters?|search|selection|sort|form|fields?|input)\\b)|cancel)\\b|\\b(?:place|complete|submit|finish|finali[sz]e|confirm)\\s+(?:(?:your|my|the|an?|this)\\s+)?order\\b|\\border\\s+now\\b|^order$|\\bre-?order\\b|\\b(?:make|submit|confirm|complete)\\s+(?:a\\s+|the\\s+)?payment\\b';
const JA_WORDS_SOURCE =
  '削除|購入|買う|決済(?!方法|情報|履歴)|支払(?!方法|い方法|情報|履歴|明細)|送信|振込|送金|転送|申込|申し込|解約|退会|配信停止|(?:登録|配信|購読|契約|会員)を?解除|(?<!に)登録(?!済|情報|内容|日|番号)|注文(?!履歴|詳細|一覧|番号|状況|情報|日|メモ|方法|内容)|ログイン|ログアウト|アーカイブ|公開(?!設定|範囲)|承認|購読(?!解除)|アップロード|(?<!(?:フィルター|フィルタ|検索|選択|条件|入力|表示)を)(?:リセット|クリア)|キャンセル|取消|取り消';

const EN_WORDS = new RegExp(EN_WORDS_SOURCE, 'iu');
const JA_WORDS = new RegExp(JA_WORDS_SOURCE, 'iu');
const SUBMIT_WORD = /\bsubmit\b/iu;
// Bare dismiss idioms (exact after normalizeLabel): the universal "close this dialog" button.
// "Cancel order" / "注文をキャンセル" are not bare and stay gated.
const DISMISS = new Set(['cancel', 'キャンセル', '取消', '取消し', '取り消し']);
// A name assembled from aria-label + title + text may repeat the idiom ("Cancel Cancel", "OK OK").
const onlyWords = (set: Set<string>, n: string) => n !== '' && n.split(' ').every(part => set.has(part));
const isDismiss = (n: string) => onlyWords(DISMISS, n);
const AFFIRMATIVE = new Set([
  'ok',
  'yes',
  'confirm',
  'continue',
  'proceed',
  '確定',
  '確認',
  'はい',
  '続行',
  '続ける',
  '実行',
]);
// An imperative verb at the start of a same-origin link label: these commonly execute on GET.
// Reading material about the verb ("Delete policy", "Remove filters") is not the verb.
const LINK_VERB_START =
  /^(?:log\s*out|sign\s*out|logout|signout|unsubscribe|opt\s*out|delete|remove|revoke|deactivate|archive|unlink|disconnect)(?![a-z])(?!\s+(?:polic(?:y|ies)|terms|guide|help|faq|info(?:rmation)?|instructions|docs?|documentation|filters?|sorting|selection)\b)|^(?:ログアウト|配信停止|退会|解約|削除)/iu;
const URL_ACTION_WORDS = new Set([
  'logout',
  'log-out',
  'signout',
  'sign-out',
  'unsubscribe',
  'opt-out',
  'optout',
  'delete',
  'destroy',
  'remove',
  'revoke',
  'cancel',
  'accept',
  'decline',
  'reject',
  'approve',
  'confirm',
  'verify',
  'activate',
  'deactivate',
  'disable',
  'archive',
  'unarchive',
  'restore',
  'reset',
  'clear',
  'disconnect',
  'unlink',
  'withdraw',
  'transfer',
  'purchase',
  'buy',
  'checkout',
  'send',
  'submit',
  'publish',
  'unpublish',
  'merge',
]);
// Text-entry controls: pressing Enter in one submits through the form's default button,
// whose label (not the field's own) is what the press activates.
const TEXT_ENTRY_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);

// NFKC, the four camelCase/digit splits of browser-approval.ts, lower case,
// collapsed whitespace, no leading/trailing punctuation, no Japanese verb suffix.
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .replace(/(?:しますか|します|する)$/, '');
}

// Exact, ASCII whole-word, or (non-ASCII) substring match of a normalized label.
export function matchesLabelList(label: string, entries: string[]): boolean {
  const l = normalizeLabel(label);
  if (!l) return false;
  for (const raw of entries) {
    const e = normalizeLabel(raw);
    if (!e) continue;
    if (l === e) return true;
    if (isAscii(e)) {
      if (new RegExp('(?:^|\\s)' + escapeRegExp(e) + '(?:\\s|$)').test(l)) return true;
    } else if (l.includes(e)) return true;
  }
  return false;
}

const matchesAny = (labels: string[], entries: string[]) => labels.some(l => matchesLabelList(l, entries));
const vocabulary = (n: string) => EN_WORDS.test(n) || JA_WORDS.test(n);
// "Delete" and "Remove" may only change the page, whose storage ends with the session. Whether they reach further shows in the
// requests they make, which a contained dispatch stops. Any other effect word next to them ("Delete and send") stays gated.
const CONTAINABLE_VERBS = /\b(?:delete|remove)\b|削除/giu;
function onlyContainableVerbs(n: string): boolean {
  const rest = n.replace(CONTAINABLE_VERBS, ' ').replace(/\s+/g, ' ').trim();
  return rest !== n && !vocabulary(rest) && !SUBMIT_WORD.test(rest);
}

const isActivation = (action: Action) =>
  action.action === 'press' && (action.value === 'Enter' || action.value === 'Space');

function activatedLabels(facts: ActionFacts, action: Action): string[] {
  // Enter in a text field activates the form's default button, never the field itself.
  if (
    isActivation(action) &&
    (facts.tag === 'textarea' ||
      facts.tag === 'select' ||
      (facts.tag === 'input' && TEXT_ENTRY_TYPES.has(facts.type.toLowerCase())))
  )
    return [facts.submitterName].filter(l => l !== '');
  return [facts.name, facts.submitterName].filter(l => l !== '');
}

/** Whether a consequential verdict rests only on a verb whose effect can stay in the session: standard mode may then dispatch the control with the network closed. */
export function isContainable(facts: ActionFacts, action: Action, verdict: LabelVerdict): boolean {
  if (action.action !== 'click' && !isActivation(action)) return false;
  if (verdict.reason === 'dialog') return !!facts.dialog && onlyContainableVerbs(normalizeLabel(facts.dialog.name));
  if (verdict.reason !== 'label') return false;
  const hits = activatedLabels(facts, action)
    .map(normalizeLabel)
    .filter(n => !isDismiss(n) && ((!facts.searchForm && SUBMIT_WORD.test(n)) || vocabulary(n)));
  return hits.length > 0 && hits.every(onlyContainableVerbs);
}

export function classifyLabel(facts: ActionFacts, action: Action, lists: LabelLists): LabelVerdict {
  const name = action.action;
  const activation = isActivation(action);
  // Only actions that activate a control are label-gated; typing and looking are not effects.
  if (name !== 'click' && name !== 'select' && name !== 'check' && !activation)
    return { consequential: false, reason: null };

  const labels = activatedLabels(facts, action);

  // The deny list beats everything.
  if (matchesAny(labels, lists.deny)) return { consequential: true, reason: 'deny_list' };

  // A download is label-independent: no list entry relaxes it.
  if (facts.link?.download) return { consequential: true, reason: 'download' };

  // The allow list clears label-derived risk only (form submissions, credentials and
  // protected regions are decided by the caller and never consult the lists).
  if (lists.allow.length > 0 && labels.length > 0 && labels.every(l => matchesAny([l], lists.allow)))
    return { consequential: false, reason: 'allow_list' };

  // Navigation-only links: same-origin http(s) destinations are gated by an imperative
  // link verb or by an action word in the destination URL, not by the button vocabulary.
  const link = facts.link;
  if (link && (link.protocol === 'http:' || link.protocol === 'https:') && link.sameOrigin) {
    if (labels.some(l => LINK_VERB_START.test(normalizeLabel(l)))) return { consequential: true, reason: 'link_verb' };
    if ([...link.segments, ...link.actionValues].some(v => URL_ACTION_WORDS.has(v.toLowerCase())))
      return { consequential: true, reason: 'link_url' };
    return { consequential: false, reason: null };
  }

  for (const l of labels) {
    const n = normalizeLabel(l);
    if (isDismiss(n)) continue;
    if ((!facts.searchForm && SUBMIT_WORD.test(n)) || vocabulary(n)) return { consequential: true, reason: 'label' };
  }

  // An affirmative button inherits the verdict of the dialog it confirms.
  if (
    facts.dialog &&
    labels.some(l => onlyWords(AFFIRMATIVE, normalizeLabel(l))) &&
    vocabulary(normalizeLabel(facts.dialog.name))
  )
    return { consequential: true, reason: 'dialog' };

  return { consequential: false, reason: null };
}
