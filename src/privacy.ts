// Data-only DOM rules are passed to each serialized page probe and the isolated mask engine.
// A PUBLIC child never removes an ancestor's explicit protection.
export const BROWSER_PRIVACY_RULES = {
  personalContextLabelPattern:
    '^(?:氏名|お名前|姓名|姓|名|住所|所在地|郵便番号|メール(?:アドレス)?|電話(?:番号)?|full[ _-]?name|given[ _-]?name|family[ _-]?name|name|postal[ _-]?code|zip[ _-]?code|street[ _-]?address|address|e-?mail|phone(?:[ _-]?number)?)[ \\t]*[:：]?[ \\t]*$',
  regionSelector: '[data-adl-sensitive],[data-adl-classification="SECRET" i],[data-adl-classification="UNKNOWN" i]',
  textSkipSelector: 'input,textarea,select,option,optgroup,button,script,style',
  ancestorCap: 128,
  textRoles: [
    'text',
    'paragraph',
    'heading',
    'cell',
    'columnheader',
    'rowheader',
    'blockquote',
    'code',
    'time',
    'caption',
    'status',
    'alert',
  ],
} as const;

// Keep these data-only patterns usable by both Node policy and isolated page probes.
export const SECRET_LABEL_PATTERN =
  '(?:^|[^a-z0-9])(?:password|passwd|pwd|passcode|secret|token|api[ _-]*key|access[ _-]*(?:key|token)|refresh[ _-]*token|private[ _-]*key|credentials?|authorization|auth|bearer|otp|cvv|cvc|session[ _-]*(?:id|token|key|cookie)|ssn|one[ _-]*time(?:[ _-]*(?:password|code))?|credit[ _-]*card|card[ _-]*number|cc[ _-]*(?:number|csc))(?=$|[^a-z0-9])|^(?:key|cookie|session|pin)(?:[ _-]*(?:id|value))?$|パスワード|暗証番号|認証(?:コード|情報|トークン|キー)|ワンタイム(?:パスワード|コード)|秘密鍵|秘密キー|シークレット|アクセストークン|APIキー';

/** Context labels and autocomplete tokens; arbitrary names in prose cannot be inferred reliably. */
export const PERSONAL_LABEL_PATTERN =
  '氏名|お名前|姓名|住所|郵便番号|(?:^|[^a-z])(?:full[ _-]?name|given[ _-]?name|family[ _-]?name|postal[ _-]?code|zip[ _-]?code|street[ _-]?address|address[ _-]?line[ _-]?[12])(?:$|[^a-z])|^(?:姓|名)$';

export function isSensitiveLabel(...labels: (string | undefined)[]): boolean {
  const pattern = new RegExp(SECRET_LABEL_PATTERN, 'iu');
  return labels.some(
    label =>
      typeof label === 'string' &&
      pattern.test(
        label
          .normalize('NFKC')
          .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/([A-Za-z])([0-9])/g, '$1 $2')
          .replace(/([0-9])([A-Za-z])/g, '$1 $2'),
      ),
  );
}

export const TEXT_REDACTION_RULES: ReadonlyArray<readonly [string, string]> = [
  // Handle schemes before generic assignments can replace the scheme alone.
  ['\\b((?:proxy-)?authorization\\s*[:=]\\s*(?:bearer|basic|digest|token)\\s+)[a-z0-9._~+/=-]{4,}', '$1[redacted]'],
  ['\\b(bearer|basic|digest)\\s+([a-z0-9._~+/=-]{4,})', '$1 [redacted]'],
  [
    '([?&](?:[a-z0-9]+[_.-])*(?:(?:access|refresh|api|private|client|session)[_-]?)?(?:token|key|secret|password|passwd|pwd|signature|sig|code|auth|session|cookie))=[^&\\s"\'<>]*',
    '$1=[redacted]',
  ],
  [
    '\\b((?:[a-z0-9]+[_.-])*(?:(?:access|refresh|api|private|client|session)[_.-]?)?(?:password|passwd|pwd|passcode|secret|token|key|credentials?|authorization|auth|bearer|session|cookie|otp|cvv|pin)(?:[_.-]?(?:id|value))?)(\\s*[=:]\\s*)([^\\s,;&]{2,})',
    '$1$2[redacted]',
  ],
  ['(?:パスワード|暗証番号|認証コード|秘密鍵|アクセストークン)(\\s*[:：=]\\s*)[^\\s,;&]+', '[redacted]'],
  ['\\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|xox[baps])[-_][a-z0-9_-]{12,}\\b', '[redacted]'],
  // JWTs have a recognizable structure; length alone also matches URLs and prose.
  ['\\beyJ[a-z0-9_-]+\\.eyJ[a-z0-9_-]+\\.[a-z0-9_-]+\\b', '[redacted]'],
  // AWS access key IDs use fixed prefixes. Secret access keys are exactly 40
  // base64 characters; a digit plus a non-hex letter keeps 40-hex hashes visible.
  ['\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA|ASCA)[A-Z0-9]{16}\\b', '[redacted]'],
  [
    '\\b((?:aws[_ -]?)?secret[_ -]?(?:access[_ -]?)?key\\b[^a-z0-9/+\\[]{1,4})[a-z0-9/+]{40}(?![a-z0-9/+=])',
    '$1[redacted]',
  ],
  ['(?<![a-z0-9/+=])(?=[a-z0-9/+]{0,39}[0-9])(?=[a-z0-9/+]{0,39}[g-z])[a-z0-9/+]{40}(?![a-z0-9/+=])', '[redacted]'],
];

/** Personal data is independent from credentials and may be revealed by a trusted opt-in. */
export const PERSONAL_DATA_REDACTION_RULES: ReadonlyArray<readonly [string, string]> = [
  // Keep the label, delimiters and field instructions. A row uses the same pipe separator as browser observations.
  [
    '((?:氏名|お名前|姓名)[ \\t]*[:：=|][ \\t]*)(?![ \\t]*(?:必須|任意|未入力|入力|漢字で|ひらがなで|カタカナで|全角で|半角で|記入|選択|例[:：]))[^\\n\\r,，;；<>|。]{1,80}',
    '$1[redacted]',
  ],
  [
    '((?:住所|所在地)[ \\t]*[:：=|][ \\t]*)(?![ \\t]*(?:必須|任意|未入力|入力|記入|選択|例[:：]))[^\\n\\r,，;；<>|。]{1,160}',
    '$1[redacted]',
  ],
  // A labelled product code is not a postal address. Bare and explicitly labelled postal codes remain protected.
  [
    '(?<!(?:製品番号|製品コード|商品番号|商品コード|品番|SKU)[ \\t]*[:：=|][ \\t]*)(?<![0-9０-９])〒?[0-9０-９]{3}[-－][0-9０-９]{4}(?![0-9０-９])',
    '[redacted]',
  ],
  // Require a prefecture and a numbered street/block; a prefecture mentioned in ordinary prose remains readable.
  [
    '(?:東京都|北海道|(?:京都|大阪)府|[一-龯]{2,3}県)[^\\s,，;；<>|0-9０-９]{1,30}?(?:市|区|町|村|郡)[^\\s,，;；<>|0-9０-９]{0,30}[0-9０-９]+(?:丁目|番地?|号|[-－])[0-9０-９一-龯ァ-ヶーA-Za-z－-]{0,40}',
    '[redacted]',
  ],
  ['[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', '[redacted]'],
  ['\\b(?:employee|emp|staff|user|member)[ _-]?(?:id|no|number)\\s*[:=]\\s*[^\\s,;&]+', '[redacted]'],
  ['(?<![a-z0-9])(?:\\+\\d{1,3}[ -]?)?(?:\\(\\d{2,4}\\)|\\d{2,4})[ -]\\d{2,4}[ -]\\d{3,4}(?!\\d)', '[redacted]'],
];

/** Stable explanations only; never include the original personal value in diagnostics. */
export const PERSONAL_DATA_RULE_REASONS = [
  'personal_name',
  'personal_address',
  'postal_code',
  'personal_address',
  'email',
  'personal_identifier',
  'phone',
] as const;
