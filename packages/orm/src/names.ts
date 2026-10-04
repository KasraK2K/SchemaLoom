/** Phase 8 — identifiers and literals for the TypeScript and Python writers. */

const JS_RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof new null return super switch this throw ' +
    'true try typeof var void while with yield let static implements interface package private ' +
    'protected public await arguments eval'
  ).split(' '),
);

const PY_RESERVED = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return try while ' +
    'with yield'
  ).split(' '),
);

const words = (name: string): string[] =>
  name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);

/** `order_items` → `orderItems`; never empty, never a reserved word, never starts with a digit. */
export function camelCase(name: string): string {
  const parts = words(name);
  const joined = parts
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`,
    )
    .join('');
  return safeJs(joined === '' ? 'x' : joined);
}

/** `order_items` → `OrderItems` */
export function pascalCase(name: string): string {
  const joined = words(name)
    .map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1).toLowerCase())
    .join('');
  return safeJs(joined === '' ? 'X' : joined);
}

function safeJs(name: string): string {
  const leading = /^[0-9]/.test(name) ? `_${name}` : name;
  return JS_RESERVED.has(leading) ? `${leading}_` : leading;
}

/** A Python identifier as `inspectdb` makes one: lower case, `_` for the rest, `_field` after a
 *  keyword. */
export function pythonName(name: string): string {
  let cleaned = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (cleaned === '' || /^[0-9]/.test(cleaned)) cleaned = `number_${cleaned}`;
  if (PY_RESERVED.has(cleaned) || cleaned.endsWith('_') || cleaned.includes('__')) {
    cleaned = `${cleaned.replace(/_+$/, '').replace(/__+/g, '_')}_field`;
  }
  return cleaned;
}

/** Unique names in one scope; the second `id` becomes `id2`. */
export class Names {
  private readonly used = new Set<string>();
  constructor(taken: Iterable<string> = []) {
    for (const name of taken) this.used.add(name);
  }
  take(preferred: string): string {
    let name = preferred;
    for (let n = 2; this.used.has(name); n++) name = `${preferred}${String(n)}`;
    this.used.add(name);
    return name;
  }
}

/** A single-quoted TypeScript string. */
export const tsString = (text: string): string =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** A template literal's body (for `sql\`…\``). */
export const tsTemplate = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/** A single-quoted Python string. */
export const pyString = (text: string): string =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** `/** … *\/` lines for a doc, or none. */
export function jsDoc(doc: { excerpt: string } | null, indent: string): string[] {
  if (doc === null || doc.excerpt === '') return [];
  const lines = doc.excerpt.replace(/\*\//g, '*\\/').split('\n');
  if (lines.length === 1) return [`${indent}/** ${lines[0] ?? ''} */`];
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`.trimEnd()), `${indent} */`];
}
