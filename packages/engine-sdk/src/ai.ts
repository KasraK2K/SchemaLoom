import type { Id, IrObjectRef, RedactedModel } from './ir.js';

/**
 * Doc 03 §13 — `AiProfile`, the tagged-block output format and join-path suggestions.
 *
 * The OUTPUT format is the same for every engine (tagged blocks, §13.3), so core owns the
 * parser and ships it here: `createTaggedBlockStream` for the SSE path, `parseTaggedOutput`
 * for the non-streaming ones, and `parseAiOutput`, the mode-to-shape mapping an engine's
 * `parseOutput` delegates to. The engine contributes the context serializer, the system
 * prompt and the per-mode instructions — everything that has to know the engine's nouns.
 */

export type AiMode = 'query' | 'explain' | 'code' | 'draft-docs' | 'draft-schema';

export const AI_MODES = [
  'query',
  'explain',
  'code',
  'draft-docs',
  'draft-schema',
] as const satisfies readonly AiMode[];

export interface AiPromptContext {
  readonly projectName: string;
  readonly serverVersion: string | null;
  readonly mode: AiMode;
}

export interface AiContextOptions {
  /** The user's canvas selection (spec §6.3 step 1). Empty = the whole visible model. */
  readonly selectedEntityIds: readonly Id[];
  readonly includeDocs: boolean;
  readonly includeIndexes: boolean;
  readonly includeCustomTypes: boolean;
  /** per-object doc truncation, default 240 characters */
  readonly maxDocChars: number;
  /** soft cap; the serialiser trims in a fixed order until it fits (§13.2) */
  readonly tokenBudget: number;
}

export interface AiSerializedContext {
  readonly text: string;
  /** cheap heuristic (chars/3.6 for this format), used for budget decisions and usage logging */
  readonly approxTokens: number;
  /** what the budget forced out, so the UI can say "documentation trimmed to fit" */
  readonly omitted: readonly {
    readonly what: 'docs' | 'indexes' | 'fields' | 'entities';
    readonly count: number;
  }[];
}

export interface AiDocSuggestion {
  readonly target: IrObjectRef;
  readonly plainText: string;
  /** Structured field-doc slots when the model filled them (doc 02 `docs.structured`). */
  readonly facts?: Readonly<Record<string, string>>;
}

export type AiParsedOutput =
  | {
      readonly mode: 'query' | 'explain';
      /** null when the model produced no query block (it refused, or asked a question) */
      readonly query: string | null;
      readonly explanation: string;
      readonly assumptions: readonly string[];
      readonly parseWarnings: readonly string[];
    }
  | {
      /** Phase 18 — ORM code, plus the same query in the engine's SQL (`query`), which core
       *  validates so the stored message's touched ids come from the validator (L25). */
      readonly mode: 'code';
      readonly code: string | null;
      readonly query: string | null;
      readonly explanation: string;
      readonly assumptions: readonly string[];
      readonly parseWarnings: readonly string[];
    }
  | {
      readonly mode: 'draft-docs';
      readonly suggestions: readonly AiDocSuggestion[];
      readonly parseWarnings: readonly string[];
    }
  | {
      /** Native DDL, routed back through `importer.import` by core — never a parsed IR. */
      readonly mode: 'draft-schema';
      readonly source: string;
      readonly importFormat: string;
      readonly parseWarnings: readonly string[];
    };

export interface AiProfile {
  buildSystemPrompt(ctx: AiPromptContext): string;
  serializeContext(model: RedactedModel, options: AiContextOptions): AiSerializedContext;
  /** Appended verbatim to the system prompt, per mode: which tags to emit and in what order. */
  readonly outputInstructions: Readonly<Record<AiMode, string>>;
  /** tolerant: accepts a bare fenced code block as the query and records a warning */
  parseOutput(text: string, mode: AiMode): AiParsedOutput;
  /** optional; defaults to defaultJoinPaths (§13.4) */
  suggestJoinPaths?(input: JoinPathInput): readonly JoinPathSuggestion[];
}

/**
 * Phase 18 — code mode's output instructions, the same for every engine but the name of its
 * SQL. Core appends the chosen ORM's own guidance and puts the model code in `<models>`.
 */
export function codeModeInstructions(sqlDialect: string): string {
  return [
    'The user wants code for their ORM. <models> holds this schema as that ORM’s model code;',
    'use only the classes, tables and fields named there.',
    'Answer with these blocks, in this order, and nothing outside them:',
    '<code>',
    'the code, no markdown fence',
    '</code>',
    '<query>',
    `the same query as one ${sqlDialect} statement, no markdown fence`,
    '</query>',
    '<explanation>',
    'one or two sentences on what the code does',
    '</explanation>',
    '<assumptions>',
    '- one line per assumption',
    '</assumptions>',
    'If the code reads or writes no single query (a seed script, a repository), put the main',
    'query it runs in <query>, or omit <query>. If the request cannot be done with the listed',
    'schema, omit <code> and <query> and say why in <explanation>.',
  ].join('\n');
}

/**
 * Phase 22 §2.3 — draft-schema's rules, the same for every engine. Each engine's
 * `outputInstructions['draft-schema']` ends with them (conformance checks it).
 */
export const DRAFT_SCHEMA_RULES = [
  'When a <schema> block is present, it is the project you are adding to. In this mode you',
  'create new tables, so "use only the tables listed" applies to what already exists:',
  '- Reuse what exists. Reference existing tables by their real names and key columns, and',
  '  never re-create a table that is in <schema>. Add a column to an existing table with',
  '  ALTER TABLE … ADD COLUMN only when the description asks for it. Never rename, change or',
  '  drop anything that exists.',
  '- Make relations explicit: foreign keys as named constraints, a join table for each',
  '  many-to-many, and an ON DELETE action chosen for each foreign key.',
  '- Follow the conventions visible in <schema>: naming case, key type, timestamp columns.',
  '- When asked to revise a draft, change only what the request asks and return the whole',
  '  revised draft.',
].join('\n');

/** The defaults core passes when a caller does not choose (§13 `maxDocChars`). */
export const DEFAULT_AI_CONTEXT_OPTIONS: AiContextOptions = {
  selectedEntityIds: [],
  includeDocs: true,
  includeIndexes: true,
  includeCustomTypes: true,
  maxDocChars: 240,
  tokenBudget: 24_000,
};

/** §13's `approxTokens` heuristic, one place. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

// --- §13.3 tagged blocks, streaming -------------------------------------------------------

export type AiOutputEvent =
  | { readonly type: 'block-open'; readonly tag: string }
  | { readonly type: 'block-delta'; readonly tag: string; readonly text: string }
  | { readonly type: 'block-close'; readonly tag: string };

const OPEN_TAG = /^<([a-z][a-z0-9_-]{0,31})>/;
/** Could `s` (which starts with `<`) still grow into an opening tag? */
const OPEN_TAG_PREFIX = /^<(?:[a-z][a-z0-9_-]{0,31})?$/;

/**
 * Incremental and tolerant of a chunk boundary anywhere, including inside a tag. Text outside
 * a block is dropped. Inside a block only the block's OWN closing tag ends it, so `a < b` or
 * `<b>` inside a query is content, and blocks do not nest. `end()` closes a block the model
 * never closed (the stream was cut off), so the consumer always sees a balanced sequence.
 */
export function createTaggedBlockStream(): {
  push(chunk: string): readonly AiOutputEvent[];
  end(): readonly AiOutputEvent[];
} {
  let buffer = '';
  let open: string | null = null;

  const drain = (final: boolean): AiOutputEvent[] => {
    const events: AiOutputEvent[] = [];
    for (;;) {
      if (open === null) {
        const lt = buffer.indexOf('<');
        if (lt === -1) {
          buffer = '';
          return events;
        }
        buffer = buffer.slice(lt);
        const match = OPEN_TAG.exec(buffer);
        if (match?.[1] !== undefined) {
          open = match[1];
          buffer = buffer.slice(match[0].length);
          events.push({ type: 'block-open', tag: open });
          continue;
        }
        if (!final && OPEN_TAG_PREFIX.test(buffer)) return events; // wait for the rest
        buffer = buffer.slice(1);
        continue;
      }

      const close = `</${open}>`;
      const at = buffer.indexOf(close);
      if (at !== -1) {
        if (at > 0) events.push({ type: 'block-delta', tag: open, text: buffer.slice(0, at) });
        events.push({ type: 'block-close', tag: open });
        buffer = buffer.slice(at + close.length);
        open = null;
        continue;
      }
      // Hold back the longest suffix that could still become the closing tag.
      let keep = final ? 0 : Math.min(close.length - 1, buffer.length);
      while (keep > 0 && !close.startsWith(buffer.slice(buffer.length - keep))) keep -= 1;
      const emit = buffer.slice(0, buffer.length - keep);
      if (emit !== '') events.push({ type: 'block-delta', tag: open, text: emit });
      buffer = buffer.slice(buffer.length - keep);
      if (final) {
        events.push({ type: 'block-close', tag: open });
        open = null;
        buffer = '';
      }
      return events;
    }
  };

  return {
    push: (chunk) => {
      buffer += chunk;
      return drain(false);
    },
    end: () => drain(true),
  };
}

export interface TaggedBlock {
  readonly tag: string;
  readonly text: string;
}

/** The non-streaming half: the same splitter over a whole response, so the two cannot drift. */
export function parseTaggedOutput(text: string): readonly TaggedBlock[] {
  const stream = createTaggedBlockStream();
  const blocks: { tag: string; text: string }[] = [];
  for (const event of [...stream.push(text), ...stream.end()]) {
    if (event.type === 'block-open') blocks.push({ tag: event.tag, text: '' });
    const last = blocks[blocks.length - 1];
    if (event.type === 'block-delta' && last !== undefined) last.text += event.text;
  }
  return blocks.map((b) => ({ tag: b.tag, text: b.text.trim() }));
}

/** The first ``` fenced block, preferring one tagged with a language in `languages`. */
export function firstFencedBlock(text: string, languages: readonly string[]): string | null {
  const fences = [...text.matchAll(/```([A-Za-z0-9_-]*)[^\S\n]*\n([\s\S]*?)```/g)];
  const preferred = fences.find((m) => languages.includes((m[1] ?? '').toLowerCase()));
  const body = (preferred ?? fences[0])?.[2];
  return body === undefined ? null : body.trim();
}

function bulletList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line !== '');
}

const DOC_TARGET = /^(entity|field)\s+(\S+)\s*$/;

export interface ParseAiOutputOptions {
  /** fenced-block languages accepted as the query / DDL when the model emitted no tags */
  readonly fenceLanguages: readonly string[];
  /** the `importFormats` id `draft-schema` source is in */
  readonly importFormat: string;
}

/**
 * §13.3's tolerant parse: never throws. A missing `<explanation>` is '' plus a warning; a
 * bare fenced block with no tags at all is accepted as the query (or DDL) with a warning.
 *
 * `draft-docs` blocks are `<doc>` with the target on the first line — `field <id>` or
 * `entity <id>`, echoed from the target list core put in the prompt — and the text after it.
 * The ids are UNTRUSTED model output: core keeps a suggestion only if its target is one it
 * asked about.
 */
export function parseAiOutput(
  text: string,
  mode: AiMode,
  options: ParseAiOutputOptions,
): AiParsedOutput {
  const warnings: string[] = [];
  let blocks: readonly TaggedBlock[];
  try {
    blocks = parseTaggedOutput(typeof text === 'string' ? text : '');
  } catch {
    blocks = [];
    warnings.push('the response could not be split into blocks');
  }
  const first = (tag: string): string | null => blocks.find((b) => b.tag === tag)?.text ?? null;
  const safeText = typeof text === 'string' ? text : '';

  if (mode === 'draft-docs') {
    const suggestions: AiDocSuggestion[] = [];
    for (const block of blocks.filter((b) => b.tag === 'doc')) {
      const [head = '', ...rest] = block.text.split('\n');
      const target = DOC_TARGET.exec(head.trim());
      const body = rest.join('\n').trim();
      if (target?.[1] === undefined || target[2] === undefined || body === '') {
        warnings.push('a <doc> block had no target line or no text');
        continue;
      }
      suggestions.push({
        target: { type: target[1] === 'entity' ? 'entity' : 'field', id: target[2] },
        plainText: body,
      });
    }
    if (suggestions.length === 0) warnings.push('no <doc> suggestions in the response');
    return { mode, suggestions, parseWarnings: warnings };
  }

  if (mode === 'draft-schema') {
    let source = first('ddl');
    if (source === null) {
      source = firstFencedBlock(safeText, options.fenceLanguages);
      warnings.push(
        source === null
          ? 'no <ddl> block in the response'
          : 'accepted a bare fenced block as the DDL',
      );
    }
    return {
      mode,
      source: source ?? '',
      importFormat: options.importFormat,
      parseWarnings: warnings,
    };
  }

  let query = first('query');
  // A bare fence in code mode is the ORM code, never the SQL.
  if (query === null && blocks.length === 0 && mode !== 'code') {
    query = firstFencedBlock(safeText, options.fenceLanguages);
    if (query !== null) warnings.push('accepted a bare fenced block as the query');
  }
  if (query === '') query = null;
  let explanation = first('explanation');
  if (explanation === null) {
    warnings.push('no <explanation> block in the response');
    // A reply with no tags at all is usually the model saying why it cannot answer.
    explanation = blocks.length === 0 && query === null ? safeText.trim() : '';
  }
  const assumptions = bulletList(first('assumptions') ?? '');
  if (mode === 'code') {
    const code = first('code');
    if (code === null) warnings.push('no <code> block in the response');
    return {
      mode,
      code: code === '' ? null : code,
      query,
      explanation,
      assumptions,
      parseWarnings: warnings,
    };
  }
  return { mode, query, explanation, assumptions, parseWarnings: warnings };
}

// --- §13.4 join paths -----------------------------------------------------------------------

export interface JoinPathInput {
  readonly model: RedactedModel;
  readonly selectedEntityIds: readonly Id[];
  readonly maxHops: number;
  readonly maxSuggestions: number;
}

export interface JoinPathStep {
  readonly linkId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
}

export interface JoinPathSuggestion {
  readonly steps: readonly JoinPathStep[];
  /** entities the user must add to the selection for this path to work — the one-click add */
  readonly addedEntityIds: readonly string[];
  readonly connects: readonly [string, string];
  readonly reason: string;
}

/**
 * BFS over visible links, one shortest path per pair of selected entities, ranked by
 * (hop count, added entities, reason). Stubs and restricted links are not edges, so a path
 * never routes through something the user cannot see. Neighbours are visited in (name, id)
 * order, so the result is deterministic.
 */
export function defaultJoinPaths(input: JoinPathInput): readonly JoinPathSuggestion[] {
  const entities = input.model.objects.entity;
  const visible = (id: Id): boolean => {
    const e = entities[id];
    return e !== undefined && e.restricted !== true;
  };
  const name = (id: Id): string => entities[id]?.name ?? id;

  const adjacency = new Map<Id, { to: Id; linkId: string }[]>();
  const edge = (from: Id, to: Id, linkId: string): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, linkId });
    adjacency.set(from, list);
  };
  for (const link of Object.values(input.model.objects.link)) {
    if (link.restricted === true) continue;
    const a = link.from.entityId;
    const b = link.to.entityId;
    if (a === b || !visible(a) || !visible(b)) continue;
    edge(a, b, link.id);
    edge(b, a, link.id);
  }
  for (const list of adjacency.values()) {
    list.sort(
      (x, y) =>
        name(x.to).localeCompare(name(y.to)) ||
        x.to.localeCompare(y.to) ||
        x.linkId.localeCompare(y.linkId),
    );
  }

  const selected = [...new Set(input.selectedEntityIds)]
    .filter(visible)
    .sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));
  const selectedSet = new Set(selected);
  const out: JoinPathSuggestion[] = [];

  for (let i = 0; i < selected.length; i += 1) {
    const start = selected[i];
    if (start === undefined) continue;
    const previous = new Map<Id, { from: Id; linkId: string }>();
    const depth = new Map<Id, number>([[start, 0]]);
    const queue: Id[] = [start];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) break;
      const d = depth.get(node) ?? 0;
      if (d >= input.maxHops) continue;
      for (const next of adjacency.get(node) ?? []) {
        if (depth.has(next.to)) continue;
        depth.set(next.to, d + 1);
        previous.set(next.to, { from: node, linkId: next.linkId });
        queue.push(next.to);
      }
    }
    for (const goal of selected.slice(i + 1)) {
      if (!previous.has(goal)) continue;
      const steps: JoinPathStep[] = [];
      for (let at = goal; at !== start;) {
        const step = previous.get(at);
        if (step === undefined) break;
        steps.unshift({ linkId: step.linkId, fromEntityId: step.from, toEntityId: at });
        at = step.from;
      }
      const path = [start, ...steps.map((s) => s.toEntityId)];
      out.push({
        steps,
        addedEntityIds: path.filter((id) => !selectedSet.has(id)),
        connects: [start, goal],
        reason: path.map(name).join(' -> '),
      });
    }
  }

  return out
    .sort(
      (a, b) =>
        a.steps.length - b.steps.length ||
        a.addedEntityIds.length - b.addedEntityIds.length ||
        a.reason.localeCompare(b.reason),
    )
    .slice(0, input.maxSuggestions);
}
