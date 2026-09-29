import type { CommentTargetType } from '@schemaloom/contracts';
import type { AtomSet, RestrictedFieldMode } from '../access';

/**
 * The pure half of comments: who sees a target, what a TipTap body mentions, and how a
 * body is redacted for one reader. No Nest, no Prisma, so the gateway and the service
 * cannot disagree about the rule.
 */

export interface CommentTarget {
  readonly projectId: string;
  readonly targetType: CommentTargetType;
  readonly targetId: string;
  /** The entity itself, or the field's entity: where authority is measured (doc 05 §7.8). */
  readonly entityId: string;
  /** A field with `isRestricted` — its comments follow field visibility (doc 05 §8). */
  readonly restricted: boolean;
}

/** Doc 05 §7.10 / §8: `schema:view` at the entity, plus `field:viewRestricted` for a restricted field. */
export function seesTarget(atoms: AtomSet, target: Pick<CommentTarget, 'restricted'>): boolean {
  return atoms.has('schema:view') && (!target.restricted || atoms.has('field:viewRestricted'));
}

/** Q2 — the stored body of a root that was deleted while it had replies. */
export const TOMBSTONE = { type: 'doc', deleted: true } as const;

export function isTombstone(content: unknown): boolean {
  return isObject(content) && content.deleted === true;
}

type Node = Record<string, unknown>;

const isObject = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const childrenOf = (node: Node): unknown[] => (Array.isArray(node.content) ? node.content : []);

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!isObject(node)) return;
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

const attrsOf = (node: Node): Node => (isObject(node.attrs) ? node.attrs : {});

const labelOf = (node: Node): string => {
  const label = attrsOf(node).label;
  return typeof label === 'string' ? label : '';
};

/** A user mention (`@tiptap/extension-mention`): `attrs.id`, no `attrs.targetType`. */
const isUserMention = (node: Node): boolean =>
  node.type === 'mention' &&
  typeof attrsOf(node).id === 'string' &&
  attrsOf(node).targetType === undefined;

/** The user ids a body @-mentions, deduplicated, in document order. */
export function mentionedUserIds(doc: unknown): string[] {
  const ids: string[] = [];
  walk(doc, (node) => {
    if (isUserMention(node)) ids.push(attrsOf(node).id as string);
  });
  return [...new Set(ids)];
}

/** `comments.plain_text`: text nodes and mention labels, blocks separated by newlines. */
export function plainTextOf(doc: unknown): string {
  const out: string[] = [];
  const block = (node: unknown): void => {
    if (!isObject(node)) return;
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
    else if (isUserMention(node)) out.push(`@${labelOf(node)}`);
    for (const child of childrenOf(node)) block(child);
    if (node.type === 'paragraph') out.push('\n');
  };
  block(doc);
  return out.join('').trim();
}

export interface RedactionRules {
  readonly visibleEntityIds: ReadonlySet<string>;
  readonly mode: RestrictedFieldMode;
  /** The label a user mention renders with for THIS reader ("A team member" for a guest). */
  readonly userLabel: (userId: string, stored: string) => string;
}

/**
 * Doc 05 §8.3 `redactRichText`, for one reader. An object mention (`attrs.targetType`)
 * survives only when its entity is visible; otherwise it becomes a restricted pill
 * (`mask`) or the text "restricted" (`hide`).
 *
 * ponytail: field object mentions always redact (fail closed) — nothing authors them in
 * Phase 4. Resolve them against field visibility when the docs editor starts writing them.
 */
export function redactRichText(doc: unknown, rules: RedactionRules): unknown {
  const visit = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    if (node.type === 'mention') {
      const attrs = attrsOf(node);
      if (attrs.targetType !== undefined) {
        const ok =
          attrs.targetType === 'entity' && rules.visibleEntityIds.has(String(attrs.targetId));
        if (ok) return node;
        return rules.mode === 'hide'
          ? { type: 'text', text: 'restricted' }
          : { type: 'mention', attrs: { restricted: true } };
      }
      if (typeof attrs.id === 'string') {
        return { ...node, attrs: { ...attrs, label: rules.userLabel(attrs.id, labelOf(node)) } };
      }
      return node;
    }
    return Array.isArray(node.content) ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(doc);
}
