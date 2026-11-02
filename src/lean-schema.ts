import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * Tool definitions are sent to the model with every session, so the JSON Schema a tool advertises leaves out
 * what the server enforces anyway and what a caller never decides on: the $schema URL (JSON Schema 2020-12 is
 * the MCP default dialect), additionalProperties:false, string-length and array-size bounds, `minimum: 0`
 * and maxima of 1000 or more (pixel, byte and millisecond limits). Enums, required lists, structure and every
 * other bound stay (positive integers become `minimum: 1`).
 * Validation is unchanged: the original zod schema still checks every call, so an unknown key, an over-long
 * string or an out-of-range number is rejected exactly as before.
 */
export function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (!node || typeof node !== 'object') return node;
  const integer = (node as { type?: unknown }).type === 'integer';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'minLength' || key === 'maxLength') continue;
    if (key === 'minItems' || key === 'maxItems') continue;
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'minimum' && value === 0) continue;
    if ((key === 'maximum' || key === 'exclusiveMaximum') && typeof value === 'number' && value >= 1000) continue;
    if (key === 'exclusiveMinimum' && value === 0 && integer) {
      out.minimum = 1;
      continue;
    }
    // Property names are data, not keywords.
    out[key] =
      key === 'properties' && value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, tidy(schema)]))
        : tidy(value);
  }
  return out;
}

const LEAN = Symbol('lean');

/**
 * Wraps a schema so that its advertised JSON Schema is tidied (and optionally patched by hand for one tool).
 * Idempotent: a schema that is already lean is returned as is.
 */
export function lean<I, O>(
  schema: StandardSchemaWithJSON<I, O>,
  patch?: (json: Record<string, unknown>) => Record<string, unknown>,
): StandardSchemaWithJSON<I, O> {
  if ((schema as { [LEAN]?: true })[LEAN]) return schema;
  const std = schema['~standard'];
  return {
    '~standard': {
      ...std,
      jsonSchema: {
        input: options => {
          const json = tidy(std.jsonSchema.input(options)) as Record<string, unknown>;
          return patch ? patch(json) : json;
        },
        output: options => std.jsonSchema.output(options),
      },
    },
    [LEAN]: true,
  } as StandardSchemaWithJSON<I, O>;
}
