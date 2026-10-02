import { UnprocessableEntityException } from '@nestjs/common';
import { visibleFields, type ConnectionField, type ConnectionValues } from '@schemaloom/engine-sdk';

const MAX_TEXT = 1_024;
/** §10.1 — a CA bundle (RDS's is ~170 KB) fits; the json body limit is 6 MB. */
const MAX_FILE = 262_144;
const MAX_LIST = 64;
const MAX_LIST_ITEM = 128;

const invalid = (field: string, message: string): never => {
  throw new UnprocessableEntityException({ code: 'introspect.invalid_connection', field, message });
};

/**
 * The trust boundary for `connection`: the engine's `connectionFields` are the schema. Unknown
 * keys are refused rather than dropped, so a typo never silently connects with a default.
 *
 * Field ids core relies on: `host` (what the SSRF guard resolves; every introspecting engine
 * must declare it), `sslmode` (`disable` needs the private-hosts flag or a tunnel, Phase 6
 * §3.3, §10.3) and the `ssh*` ids of `SSH_TUNNEL_FIELDS`. Only visible fields (§10.1) are
 * validated and kept; a hidden one's value is dropped.
 */
export function validateConnection(
  fields: readonly ConnectionField[],
  input: unknown,
  allowPrivate: boolean,
): ConnectionValues & { readonly host: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('connection', 'Connection details are required.');
  }
  const raw = input as Record<string, unknown>;
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const key of Object.keys(raw)) {
    if (!byId.has(key)) invalid(key, `Unknown connection field "${key}".`);
  }

  const out: Record<string, string | number | readonly string[]> = {};
  for (const field of visibleFields(fields, raw)) {
    const value = raw[field.id];
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required && field.default === undefined) {
        invalid(field.id, `${field.label} is required.`);
      }
      if (field.default !== undefined) out[field.id] = field.default;
      continue;
    }
    switch (field.kind) {
      case 'number': {
        const n = typeof value === 'string' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65_535) {
          invalid(field.id, `${field.label} must be a whole number.`);
        }
        out[field.id] = n as number;
        break;
      }
      case 'list': {
        if (
          !Array.isArray(value) ||
          value.length > MAX_LIST ||
          !value.every((v) => typeof v === 'string' && v.length <= MAX_LIST_ITEM)
        ) {
          invalid(field.id, `${field.label} must be a list of names.`);
        }
        out[field.id] = value as string[];
        break;
      }
      case 'file': {
        if (typeof value !== 'string' || value.length > MAX_FILE || !value.includes('-----BEGIN')) {
          invalid(field.id, `${field.label} must be a PEM file (-----BEGIN …).`);
        }
        out[field.id] = value as string;
        break;
      }
      default: {
        if (typeof value !== 'string' || value.length > MAX_TEXT) {
          invalid(field.id, `${field.label} must be text.`);
        }
        if (field.kind === 'select' && !(field.options ?? []).includes(value as string)) {
          invalid(field.id, `${field.label} must be one of ${(field.options ?? []).join(', ')}.`);
        }
        out[field.id] = value as string;
      }
    }
  }

  const host = out.host;
  if (typeof host !== 'string' || host.trim() === '') invalid('host', 'Host is required.');
  // Through a tunnel the leg the api can see is SSH-encrypted (§10.3.4). Which values mean
  // "no TLS" is the engine's to declare (`ConnectionField.insecureValues`).
  if (!allowPrivate && out.ssh !== 'ssh') {
    for (const field of fields) {
      const value = out[field.id];
      if (typeof value === 'string' && field.insecureValues?.includes(value) === true) {
        invalid(
          field.id,
          `This server requires TLS to reach a database. Choose another ${field.label}.`,
        );
      }
    }
  }
  return { ...out, host: (host as string).trim() };
}
