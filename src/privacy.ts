// Data-only DOM rules are passed to each serialized page probe and the isolated mask engine.
// A PUBLIC child never removes an ancestor's explicit protection.
export const BROWSER_PRIVACY_RULES = {
  regionSelector: '[data-adl-sensitive],[data-adl-classification="SECRET" i],[data-adl-classification="UNKNOWN" i]',
  textSkipSelector: 'input,textarea,select,option,optgroup,button,script,style',
  ancestorCap: 128,
  textRoles: ['text','paragraph','heading','cell','columnheader','rowheader','blockquote','code','time','caption','status','alert'],
} as const;

// Keep these data-only patterns usable by both Node policy and isolated page probes.
export const SECRET_LABEL_PATTERN = '(?:^|[^a-z0-9])(?:password|passwd|pwd|passcode|secret|token|api[ _-]*key|access[ _-]*(?:key|token)|refresh[ _-]*token|private[ _-]*key|credentials?|authorization|auth|bearer|otp|cvv|cvc|session[ _-]*(?:id|token|key|cookie)|ssn|one[ _-]*time(?:[ _-]*(?:password|code))?|credit[ _-]*card|card[ _-]*number|cc[ _-]*(?:number|csc))(?=$|[^a-z0-9])|^(?:key|cookie|session|pin)(?:[ _-]*(?:id|value))?$|パスワード|暗証番号|認証(?:コード|情報|トークン|キー)|ワンタイム(?:パスワード|コード)|秘密鍵|秘密キー|シークレット|アクセストークン|APIキー';

export function isSensitiveLabel(...labels: (string | undefined)[]): boolean {
  const pattern = new RegExp(SECRET_LABEL_PATTERN, 'iu');
  return labels.some(label => typeof label === 'string' && pattern.test(label.normalize('NFKC')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2')));
}

export const TEXT_REDACTION_RULES: ReadonlyArray<readonly [string, string]> = [
  // Handle schemes before generic assignments can replace the scheme alone.
  ['\\b((?:proxy-)?authorization\\s*[:=]\\s*(?:bearer|basic|digest|token)\\s+)[a-z0-9._~+/=-]{4,}', '$1[redacted]'],
  ['\\b(bearer|basic|digest)\\s+([a-z0-9._~+/=-]{4,})', '$1 [redacted]'],
  ['([?&](?:[a-z0-9]+[_.-])*(?:(?:access|refresh|api|private|client|session)[_-]?)?(?:token|key|secret|password|passwd|pwd|signature|sig|code|auth|session|cookie))=[^&\\s"\'<>]*', '$1=[redacted]'],
  ['\\b((?:[a-z0-9]+[_.-])*(?:(?:access|refresh|api|private|client|session)[_.-]?)?(?:password|passwd|pwd|passcode|secret|token|key|credentials?|authorization|auth|bearer|session|cookie|otp|cvv|pin)(?:[_.-]?(?:id|value))?)(\\s*[=:]\\s*)([^\\s,;&]{2,})', '$1$2[redacted]'],
  ['(?:パスワード|暗証番号|認証コード|秘密鍵|アクセストークン)(\\s*[:：=]\\s*)[^\\s,;&]+', '[redacted]'],
  ['\\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|xox[baps])[-_][a-z0-9_-]{12,}\\b', '[redacted]'],
  // JWTs have a recognizable structure; length alone also matches URLs and prose.
  ['\\beyJ[a-z0-9_-]+\\.eyJ[a-z0-9_-]+\\.[a-z0-9_-]+\\b', '[redacted]'],
];

/** Personal data is independent from credentials and may be revealed by a trusted opt-in. */
export const PERSONAL_DATA_REDACTION_RULES: ReadonlyArray<readonly [string,string]> = [
  ['[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', '[redacted]'],
  ['\\b(?:employee|emp|staff|user|member)[ _-]?(?:id|no|number)\\s*[:=]\\s*[^\\s,;&]+', '[redacted]'],
  ['(?<![a-z0-9])(?:\\+\\d{1,3}[ -]?)?(?:\\(\\d{2,4}\\)|\\d{2,4})[ -]\\d{2,4}[ -]\\d{3,4}(?!\\d)', '[redacted]'],
];
