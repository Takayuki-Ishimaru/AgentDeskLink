import { TEXT_REDACTION_RULES } from './privacy.js';
import { AdlError } from './types.js';

export interface ApprovalValue {
  kind: 'public' | 'secret';
  length: number;
  preview?: string;
}

/** Consent text must be complete. Snapshot text clipping is not appropriate here. */
export function redactApprovalText(text: string, maxChars = 4096): string {
  if (
    typeof text !== 'string' ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > 8192 ||
    text.length > maxChars ||
    text.includes('\0')
  )
    throw new AdlError('E_RESOURCE_LIMIT');
  let result = text;
  for (const [source, replacement] of TEXT_REDACTION_RULES)
    result = result.replace(new RegExp(source, 'gi'), replacement);
  if (result.length > maxChars) throw new AdlError('E_RESOURCE_LIMIT');
  return result;
}

export function describeApprovalValue(value: string, secret = false): ApprovalValue {
  const preview = redactApprovalText(value);
  return secret || preview !== value
    ? { kind: 'secret', length: value.length }
    : { kind: 'public', length: value.length, preview };
}

export interface ApprovalFormDescription {
  method: string;
  url: string;
  fields: { name: string; value: string; secret: boolean }[];
}

/** All inspected named fields must be supplied; callers must not pre-truncate. */
export function describeApprovalForm(form: ApprovalFormDescription): string[] {
  if (!['GET', 'POST'].includes(form.method) || form.fields.length > 24) throw new AdlError('E_RESOURCE_LIMIT');
  const header = `Form ${form.method} ${redactApprovalText(form.url, 2048)}`;
  const lines = [
    header,
    ...form.fields.map(field => {
      const name = redactApprovalText(field.name, 128);
      const value = describeApprovalValue(field.value, field.secret);
      return `${JSON.stringify(name)}: ${value.kind === 'secret' ? `[secret, ${value.length} characters]` : JSON.stringify(value.preview)}`;
    }),
  ];
  if (lines.some(line => line.length > 8192) || Buffer.byteLength(JSON.stringify({ details: lines }), 'utf8') > 8192)
    throw new AdlError('E_RESOURCE_LIMIT');
  return lines;
}
