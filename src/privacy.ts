// Data-only DOM rules are passed to each serialized page probe and the isolated mask engine.
// A PUBLIC child never removes an ancestor's explicit protection.
export const BROWSER_PRIVACY_RULES = {
  regionSelector: '[data-adl-sensitive],[data-adl-classification="SECRET" i],[data-adl-classification="UNKNOWN" i]',
  textSkipSelector: 'input,textarea,select,option,optgroup,button,script,style',
  ancestorCap: 128,
} as const;

// Keep these data-only patterns usable by both Node policy and isolated page probes.
export const SECRET_LABEL_PATTERN = '(?:^|[^a-z0-9])(?:password|passwd|pwd|passcode|secret|token|api[ _-]*key|access[ _-]*(?:key|token)|refresh[ _-]*token|private[ _-]*key|key|credentials?|authorization|auth|bearer|otp|cvv|cvc|session(?:[ _-]*id)?|cookie|pin|ssn|one[ _-]*time(?:[ _-]*(?:password|code))?|credit[ _-]*card|card[ _-]*number|cc[ _-]*(?:number|csc))(?=$|[^a-z0-9])|パスワード|暗証番号|認証(?:コード|情報|トークン|キー)|ワンタイム(?:パスワード|コード)|秘密鍵|秘密キー|シークレット|アクセストークン|APIキー';

export function isSensitiveLabel(...labels: (string | undefined)[]): boolean {
  const pattern = new RegExp(SECRET_LABEL_PATTERN, 'iu');
  return labels.some(label => typeof label === 'string' && pattern.test(label.normalize('NFKC')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2')));
}

export const TEXT_REDACTION_RULES: ReadonlyArray<readonly [string, string]> = [
  ['([?&][a-z0-9_]*(?:token|key|secret|password|passwd|pwd|signature|sig|code|auth|session|api|access)[a-z0-9_]*)=[^&\\s"\'<>]*', '$1=[redacted]'],
  ['\\b([a-z0-9_.-]*(?:password|passwd|pwd|passcode|secret|token|key|credential|authorization|auth|bearer|session|cookie|otp|cvv|pin)[a-z0-9_.-]*)(\\s*[=:]\\s*)([^\\s,;&]{2,})', '$1$2[redacted]'],
  ['(?:パスワード|暗証番号|認証コード|秘密鍵|アクセストークン)(\\s*[:：=]\\s*)[^\\s,;&]+', '[redacted]'],
  ['\\b(bearer|basic|digest|token)\\s+([a-z0-9._~+/=-]{4,})', '$1 [redacted]'],
  ['[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', '[redacted]'],
  ['\\b(?:employee|emp|staff|user|member)[_-]?(?:id|no|number)\\s*[:=]\\s*[^\\s,;&]+', '[redacted]'],
  ['\\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|xox[baps])[-_][a-z0-9_-]{12,}\\b', '[redacted]'],
  ['\\b[a-z0-9+/_-]{28,}={0,2}\\b', '[redacted]'],
];
