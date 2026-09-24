/**
 * Doc 03 §16.2 — nothing hard-codes a noun. Core owns the message catalog; engines own only
 * the nouns. No React here: this module is exported from the "." entry.
 */

export interface Term {
  /** Title Case singular: 'Table' */
  readonly one: string;
  /** Title Case plural: 'Tables' */
  readonly other: string;
  /** overrides the derived a/an; needed for 'an index', 'a namespace' */
  readonly indefinite?: 'a' | 'an';
}

export type CoreTermKey =
  | 'namespace'
  | 'entity'
  | 'field'
  | 'link'
  | 'index'
  | 'constraint'
  | 'customType'
  | 'query'
  | 'area';

export interface TerminologyBundle {
  readonly terms: Readonly<Record<CoreTermKey, Term>>;
  /** keyed by `EntityKindDescriptor.id` — 'table' -> Table, 'view' -> View */
  readonly entityKindTerms: Readonly<Record<string, Term>>;
  /** keyed by `LinkKindDescriptor.id` */
  readonly linkKindTerms: Readonly<Record<string, Term>>;
  /** keyed by `ConstraintKindDescriptor.id` */
  readonly constraintKindTerms: Readonly<Record<string, Term>>;
  /** keyed by `CustomTypeKindDescriptor.id` — drives the type picker's group headings (§5.4) */
  readonly customTypeKindTerms: Readonly<Record<string, Term>>;
}

/** The term a message is about: a core key, or a specific kind. */
export type TermSubject =
  | CoreTermKey
  | `entityKind:${string}`
  | `linkKind:${string}`
  | `constraintKind:${string}`
  | `customTypeKind:${string}`;

export type CoreMessageId =
  | 'action.add'
  | 'action.addFirst'
  | 'action.delete'
  | 'action.duplicate'
  | 'action.rename'
  | 'list.title'
  | 'list.empty'
  | 'list.count'
  | 'list.searchPlaceholder'
  | 'inspector.title'
  | 'inspector.noSelection'
  | 'confirm.delete'
  | 'confirm.deleteMany'
  | 'tab.details'
  | 'tab.docs'
  | 'tab.indexes'
  | 'tab.constraints'
  | 'tab.comments'
  | 'palette.jumpTo'
  | 'palette.create'
  | 'canvas.dropHint'
  | 'export.includeComments'
  | 'import.applyTo'
  // the rejected-drag sentences, moved out of engine-sdk prose (§7)
  | 'link.selfNotAllowed'
  | 'link.typeMismatch'
  | 'link.crossNamespace'
  | 'link.arityMismatch'
  | 'link.kindNotAllowed'
  | 'link.compositeNotAllowed'
  // rendered in place of any object ref the recipient may not see (§2.4)
  | 'diag.restrictedObject';

export const CORE_MESSAGE_TEMPLATES: Readonly<Record<CoreMessageId, string>> = {
  'action.add': 'Add {oneLower}',
  'action.addFirst': 'Add your first {oneLower}',
  'action.delete': 'Delete {oneLower}',
  'action.duplicate': 'Duplicate {oneLower}',
  'action.rename': 'Rename {oneLower}',
  'list.title': '{other}',
  'list.empty': 'No {otherLower} yet',
  'list.count': '{count} {oneLower|otherLower}',
  'list.searchPlaceholder': 'Search {otherLower}…',
  'inspector.title': '{one} details',
  'inspector.noSelection': 'Select {a} {oneLower} to see its details',
  'confirm.delete': 'Delete {a} {oneLower}? This cannot be undone.',
  'confirm.deleteMany': 'Delete {count} {otherLower}? This cannot be undone.',
  'tab.details': 'Details',
  'tab.docs': 'Documentation',
  'tab.indexes': '{other}',
  'tab.constraints': '{other}',
  'tab.comments': 'Comments',
  'palette.jumpTo': 'Jump to {oneLower}…',
  'palette.create': 'Create {a} {oneLower}',
  'canvas.dropHint': 'Drag from a {oneLower} to another to create {a} {oneLower}',
  'export.includeComments': 'Include documentation as comments',
  'import.applyTo': 'Apply to {otherLower}',
  'link.selfNotAllowed': 'A {oneLower} cannot link to itself',
  'link.typeMismatch': '{from} and {to} are not compatible types',
  'link.crossNamespace': 'Both {otherLower} must be in the same {namespace}',
  'link.arityMismatch': 'Both ends must use the same number of {otherLower}',
  'link.kindNotAllowed': 'This {oneLower} cannot link to {a} {targetLower}',
  'link.compositeNotAllowed': 'This {oneLower} supports only single-{oneLower} links',
  'diag.restrictedObject': 'a restricted object',
};

export const FALLBACK_TERMINOLOGY: TerminologyBundle = {
  terms: {
    namespace: { one: 'Namespace', other: 'Namespaces' },
    entity: { one: 'Entity', other: 'Entities', indefinite: 'an' },
    field: { one: 'Field', other: 'Fields' },
    link: { one: 'Link', other: 'Links' },
    index: { one: 'Index', other: 'Indexes', indefinite: 'an' },
    constraint: { one: 'Constraint', other: 'Constraints' },
    customType: { one: 'Type', other: 'Types' },
    query: { one: 'Query', other: 'Queries' },
    area: { one: 'Area', other: 'Areas', indefinite: 'an' },
  },
  entityKindTerms: {},
  linkKindTerms: {},
  constraintKindTerms: {},
  customTypeKindTerms: {},
};

/** kind-subject prefix -> the bundle map it reads, and the core term it degrades to. */
const KIND_SUBJECTS = {
  entityKind: { map: 'entityKindTerms', core: 'entity' },
  linkKind: { map: 'linkKindTerms', core: 'link' },
  constraintKind: { map: 'constraintKindTerms', core: 'constraint' },
  customTypeKind: { map: 'customTypeKindTerms', core: 'customType' },
} as const satisfies Record<string, { map: keyof TerminologyBundle; core: CoreTermKey }>;

/** A `Record<Union, T>` lookup is statically total but a bundle comes from an engine, so the
 *  runtime miss is real. Widening to a string index is what makes it visible. */
function lookup(map: Readonly<Record<string, Term>>, key: string): Term | undefined {
  return map[key];
}

/**
 * Total. A missing key falls back to `FALLBACK_TERMINOLOGY`'s term for the same subject and
 * then to the generic core term, so the worst case renders "Add entity", never "Add undefined".
 */
export function resolveTerm(bundle: TerminologyBundle, subject: TermSubject): Term {
  const colon = subject.indexOf(':');
  if (colon === -1) {
    return (
      lookup(bundle.terms, subject) ??
      lookup(FALLBACK_TERMINOLOGY.terms, subject) ??
      FALLBACK_TERMINOLOGY.terms.entity
    );
  }
  const prefix = subject.slice(0, colon);
  const id = subject.slice(colon + 1);
  if (!Object.hasOwn(KIND_SUBJECTS, prefix)) return FALLBACK_TERMINOLOGY.terms.entity;
  const spec = KIND_SUBJECTS[prefix as keyof typeof KIND_SUBJECTS];
  return lookup(bundle[spec.map], id) ?? resolveTerm(bundle, spec.core);
}

function indefiniteArticle(term: Term): string {
  return term.indefinite ?? (/^[aeiou]/i.test(term.one) ? 'an' : 'a');
}

/**
 * ~25 lines, no i18n dependency. Placeholders: `{one}` `{other}` `{oneLower}` `{otherLower}`
 * `{a}` `{count}`, `{x|y}` which selects by `count` (1 -> x, otherwise y), and any key of
 * `vars`. An unknown placeholder is left verbatim so a template bug is visible.
 */
export function formatMessage(
  bundle: TerminologyBundle,
  id: CoreMessageId,
  subject: TermSubject,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const term = resolveTerm(bundle, subject);
  const count = typeof vars?.count === 'number' ? vars.count : 1;
  const slots: Readonly<Record<string, string>> = {
    one: term.one,
    other: term.other,
    oneLower: term.one.toLowerCase(),
    otherLower: term.other.toLowerCase(),
    a: indefiniteArticle(term),
  };
  const fill = (key: string, whole: string): string => {
    const slot = slots[key];
    if (slot !== undefined) return slot;
    const value = vars?.[key];
    return value === undefined ? whole : String(value);
  };
  return CORE_MESSAGE_TEMPLATES[id].replace(/\{([^}]+)\}/g, (whole: string, key: string) => {
    const bar = key.indexOf('|');
    if (bar === -1) return fill(key, whole);
    return fill(count === 1 ? key.slice(0, bar) : key.slice(bar + 1), whole);
  });
}
