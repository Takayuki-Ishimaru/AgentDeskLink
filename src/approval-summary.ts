import { SECRET_LABEL_PATTERN, TEXT_REDACTION_RULES } from './privacy.js';
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

/** Write methods a page request may be held under. Anything else is never described to a human (and never released). */
export const HELD_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export interface HeldRequestDescription {
  method: string;
  url: string;
  contentType: string;
  /** UTF-8 text of the body; absent for a request without one. */
  body?: string;
}

const HELD_MAX_FIELDS = 24;
const HELD_MAX_DEPTH = 16;
const HELD_MAX_LINE = 8192;

/** Same normalization as isSensitiveLabel (camelCase and digit boundaries), with a caller-supplied pattern. */
function secretKeyMatcher(pattern: string): (name: string) => boolean {
  const regex = new RegExp(pattern, 'iu');
  return name =>
    regex.test(
      name
        .normalize('NFKC')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2'),
    );
}
const secretMarker = (length: number) => `[secret, ${length} characters]`;
const secretLength = (value: unknown) => (typeof value === 'string' ? value.length : JSON.stringify(value).length);

/** Replaces the value of every secret-named property, at any depth, by its marker; own properties named like Object.prototype members stay visible (null prototype). */
function maskJson(value: unknown, isSecret: (name: string) => boolean, state: { masked: boolean }, depth = 0): unknown {
  if (depth > HELD_MAX_DEPTH) throw new AdlError('E_RESOURCE_LIMIT');
  if (Array.isArray(value)) return value.map(item => maskJson(item, isSecret, state, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (isSecret(key)) {
      state.masked = true;
      result[key] = secretMarker(secretLength(item));
    } else result[key] = maskJson(item, isSecret, state, depth + 1);
  }
  return result;
}

/** Lines for the approval dialog; throws E_RESOURCE_LIMIT when the request cannot be described completely (the caller blocks it as request_not_approvable). */
export function describeHeldRequest(
  request: HeldRequestDescription,
  secretKeyPattern: string = SECRET_LABEL_PATTERN,
): { lines: string[]; secret: boolean } {
  const contentType = request.contentType ?? ''; // a request without a Content-Type header
  if (!HELD_METHODS.has(request.method) || typeof request.url !== 'string' || typeof contentType !== 'string')
    throw new AdlError('E_RESOURCE_LIMIT');
  const isSecret = secretKeyMatcher(secretKeyPattern);
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  // A multipart body (file upload) is never shown as if it were text.
  if (type.startsWith('multipart/')) throw new AdlError('E_RESOURCE_LIMIT');
  const lines = [`Request ${request.method} ${redactApprovalText(request.url, 2048)}`];
  let secret = false;
  const field = (name: string, value: string, secretName: boolean) => {
    const described = describeApprovalValue(value, secretName);
    if (described.kind === 'secret') secret = true;
    lines.push(
      `${JSON.stringify(redactApprovalText(name, 128))}: ${described.kind === 'secret' ? secretMarker(described.length) : JSON.stringify(described.preview)}`,
    );
  };
  const text = (body: string) => {
    const redacted = redactApprovalText(body, HELD_MAX_LINE);
    if (redacted !== body) secret = true;
    lines.push(`Body (text/plain, ${body.length} characters): ${JSON.stringify(redacted)}`);
  };
  const body = request.body;
  if (body === undefined || body === '') lines.push('(no body)');
  else if (type === 'application/json') {
    let parsed: unknown;
    let valid = true;
    try {
      parsed = JSON.parse(body);
    } catch {
      valid = false;
    }
    if (!valid) text(body);
    else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      if (entries.length > HELD_MAX_FIELDS) throw new AdlError('E_RESOURCE_LIMIT');
      if (entries.length === 0) lines.push('Body (application/json): {}');
      for (const [key, value] of entries) {
        if (isSecret(key)) {
          secret = true;
          lines.push(`${JSON.stringify(redactApprovalText(key, 128))}: ${secretMarker(secretLength(value))}`);
        } else if (typeof value === 'string') field(key, value, false);
        else {
          const state = { masked: false };
          const json = JSON.stringify(maskJson(value, isSecret, state));
          const described = describeApprovalValue(json);
          if (state.masked || described.kind === 'secret') secret = true;
          lines.push(
            `${JSON.stringify(redactApprovalText(key, 128))}: ${described.kind === 'secret' ? secretMarker(json.length) : json}`,
          );
        }
      }
    } else {
      const state = { masked: false };
      const json = JSON.stringify(maskJson(parsed, isSecret, state));
      const redacted = redactApprovalText(json, HELD_MAX_LINE);
      if (state.masked || redacted !== json) secret = true;
      lines.push(`Body (application/json): ${redacted}`);
    }
  } else if (type === 'application/x-www-form-urlencoded') {
    const entries = [...new URLSearchParams(body)];
    if (entries.length > HELD_MAX_FIELDS) throw new AdlError('E_RESOURCE_LIMIT');
    if (entries.length === 0) text(body);
    for (const [name, value] of entries) field(name, value, isSecret(name));
  } else text(body);
  if (
    lines.length > 25 ||
    lines.some(line => line.length > HELD_MAX_LINE) ||
    Buffer.byteLength(JSON.stringify({ details: lines }), 'utf8') > 8192
  )
    throw new AdlError('E_RESOURCE_LIMIT');
  return { lines, secret };
}
