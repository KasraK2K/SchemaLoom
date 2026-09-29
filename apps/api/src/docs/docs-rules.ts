import type { DocTargetType } from '@schemaloom/contracts';
import type { RedactedModel } from '@schemaloom/schema-model';
import type { ResourceRef } from '../access';

/**
 * The pure half of docs: which targets a reader may see, where `docs:edit` is measured,
 * what a stored TipTap body may contain, and the text derived from it. No Nest, no
 * Prisma, so it is tested without either.
 */

type Node = Record<string, unknown>;

const isObject = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Visible to THIS reader, decided on their redacted model (doc 05 §8, L8): a project the
 * guard already let them open, an area that survived redaction, an entity or field that
 * is present and not a stub / masked slot. A hidden field is simply absent.
 */
export function targetVisible(
  model: RedactedModel,
  projectId: string,
  targetType: DocTargetType,
  targetId: string,
): boolean {
  switch (targetType) {
    case 'project':
      return targetId === projectId;
    case 'area':
      return model.objects.area[targetId] !== undefined;
    case 'entity':
      return isShown(model.objects.entity[targetId]);
    case 'field':
      return isShown(model.objects.field[targetId]);
  }
}

const isShown = (object: { restricted?: true } | undefined): boolean =>
  object !== undefined && object.restricted !== true;

/** Where `docs:edit` is measured: a field answers at its entity (doc 05 §7.8). Call only
 *  after `targetVisible`. */
export function authorityRef(
  model: RedactedModel,
  targetType: DocTargetType,
  targetId: string,
): ResourceRef {
  if (targetType === 'field') {
    return { type: 'entity', id: model.objects.field[targetId]?.entityId ?? targetId };
  }
  return { type: targetType, id: targetId };
}

// ---------------------------------------------------------------------------------------
// TipTap sanitising
// ---------------------------------------------------------------------------------------

/** `@tiptap/starter-kit` v3, which is all the docs editor loads. */
const NODES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
]);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link']);

/** Deeper than any list a person nests; a bound so a crafted body cannot blow the stack. */
const MAX_DEPTH = 40;

const SAFE_HREF = /^(https?:|mailto:)/i;
const LANGUAGE = /^[a-z0-9+#-]{1,32}$/i;

/** Only the attributes each node type needs, each checked. Everything else is dropped. */
function attrsFor(type: string, raw: unknown): Node | undefined {
  const attrs = isObject(raw) ? raw : {};
  if (type === 'heading') {
    const level = attrs.level;
    return { level: typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1 };
  }
  if (type === 'orderedList') {
    const start = attrs.start;
    return { start: typeof start === 'number' && Number.isInteger(start) && start >= 0 ? start : 1 };
  }
  if (type === 'codeBlock') {
    const language = attrs.language;
    return { language: typeof language === 'string' && LANGUAGE.test(language) ? language : null };
  }
  return undefined;
}

function sanitizeMarks(raw: unknown): Node[] {
  if (!Array.isArray(raw)) return [];
  const out: Node[] = [];
  for (const mark of raw) {
    if (!isObject(mark) || typeof mark.type !== 'string' || !MARKS.has(mark.type)) continue;
    if (mark.type === 'link') {
      const href = isObject(mark.attrs) ? mark.attrs.href : undefined;
      // `javascript:` and friends never reach another reader's DOM.
      if (typeof href !== 'string' || !SAFE_HREF.test(href.trim())) continue;
      out.push({ type: 'link', attrs: { href: href.trim() } });
    } else {
      out.push({ type: mark.type });
    }
  }
  return out;
}

function sanitizeNode(raw: unknown, depth: number): Node | null {
  if (!isObject(raw) || typeof raw.type !== 'string' || !NODES.has(raw.type) || depth > MAX_DEPTH) {
    return null;
  }
  const type = raw.type;
  if (type === 'text') {
    if (typeof raw.text !== 'string' || raw.text === '') return null;
    const marks = sanitizeMarks(raw.marks);
    return marks.length === 0 ? { type, text: raw.text } : { type, text: raw.text, marks };
  }
  const node: Node = { type };
  const attrs = attrsFor(type, raw.attrs);
  if (attrs !== undefined) node.attrs = attrs;
  if (Array.isArray(raw.content)) {
    node.content = raw.content.flatMap((child) => sanitizeNode(child, depth + 1) ?? []);
  }
  return node;
}

/**
 * Doc 02 §7 — the node/mark allow-list, applied before `richTextSchema`. Unknown nodes
 * (a mention, an image, anything a future extension emits) are dropped with their
 * subtree, unknown marks and attributes are dropped. Null when the input is not a doc.
 *
 * Mentions are deliberately not allowed: `redactRichText`'s object-mention rule is still
 * the fail-closed Phase 4 one (comment-rules.ts), so a doc that could carry them would
 * need a per-reader redaction pass on every read.
 */
export function sanitizeRichText(raw: unknown): Node | null {
  if (!isObject(raw) || raw.type !== 'doc') return null;
  return sanitizeNode(raw, 0);
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock']);

/** `docs.plain_text`: text nodes, one line per block, no blank runs. Feeds the IR excerpt
 *  (assembleModel) and the AI context. */
export function docPlainText(doc: unknown): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!isObject(node)) return;
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
    else if (node.type === 'hardBreak') out.push('\n');
    if (Array.isArray(node.content)) for (const child of node.content) visit(child);
    if (typeof node.type === 'string' && BLOCKS.has(node.type)) out.push('\n');
  };
  visit(doc);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
