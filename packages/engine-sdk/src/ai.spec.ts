import { describe, expect, it } from 'vitest';
import {
  createTaggedBlockStream,
  defaultJoinPaths,
  parseAiOutput,
  parseTaggedOutput,
  type AiOutputEvent,
} from './ai.js';
import type { RedactedModel } from './ir.js';

const OPTIONS = { fenceLanguages: ['sql'], importFormat: 'ddl' };

/** Feed `text` in pieces of `size` and merge adjacent deltas, so chunking cannot matter. */
function run(text: string, size: number): AiOutputEvent[] {
  const stream = createTaggedBlockStream();
  const events: AiOutputEvent[] = [];
  for (let i = 0; i < text.length; i += size) events.push(...stream.push(text.slice(i, i + size)));
  events.push(...stream.end());
  const merged: AiOutputEvent[] = [];
  for (const event of events) {
    const last = merged[merged.length - 1];
    if (event.type === 'block-delta' && last?.type === 'block-delta' && last.tag === event.tag) {
      merged[merged.length - 1] = { ...last, text: last.text + event.text };
    } else merged.push(event);
  }
  return merged;
}

const RESPONSE =
  'Sure.\n<query>\nSELECT * FROM t WHERE a < b AND x <> y\n</query>\n<explanation>\nOne line.\n</explanation>\n<assumptions>\n- paid only\n- USD\n</assumptions>';

describe('createTaggedBlockStream', () => {
  it('yields the same events whatever the chunk size, including a tag split across chunks', () => {
    const whole = run(RESPONSE, RESPONSE.length);
    expect(whole.map((e) => e.type)).toEqual([
      'block-open', 'block-delta', 'block-close',
      'block-open', 'block-delta', 'block-close',
      'block-open', 'block-delta', 'block-close',
    ]);
    for (const size of [1, 2, 3, 5, 7, 13]) expect(run(RESPONSE, size)).toEqual(whole);
    expect(whole[1]).toEqual({ type: 'block-delta', tag: 'query', text: '\nSELECT * FROM t WHERE a < b AND x <> y\n' });
  });

  it('closes an unterminated block on end()', () => {
    expect(run('<query>SELECT 1', 4)).toEqual([
      { type: 'block-open', tag: 'query' },
      { type: 'block-delta', tag: 'query', text: 'SELECT 1' },
      { type: 'block-close', tag: 'query' },
    ]);
  });

  it('does not nest: only the open block’s own closing tag ends it', () => {
    expect(parseTaggedOutput('<query>a <explanation>b</explanation> c</query>')).toEqual([
      { tag: 'query', text: 'a <explanation>b</explanation> c' },
    ]);
  });
});

describe('parseAiOutput', () => {
  it('reads the three query-mode blocks', () => {
    const out = parseAiOutput(RESPONSE, 'query', OPTIONS);
    expect(out).toEqual({
      mode: 'query',
      query: 'SELECT * FROM t WHERE a < b AND x <> y',
      explanation: 'One line.',
      assumptions: ['paid only', 'USD'],
      parseWarnings: [],
    });
  });

  it('accepts a bare ```sql block with a warning', () => {
    const out = parseAiOutput('Try:\n```sql\nSELECT 1\n```\n', 'query', OPTIONS);
    expect(out.mode === 'query' && out.query).toBe('SELECT 1');
    expect(out.parseWarnings.length).toBeGreaterThan(0);
  });

  it('never throws, and a tagless refusal becomes the explanation', () => {
    for (const text of ['', '<', '</x>', '<query></query>', '```', '\u0000']) {
      expect(() => parseAiOutput(text, 'explain', OPTIONS)).not.toThrow();
    }
    const out = parseAiOutput('That table is not in the schema I was given.', 'query', OPTIONS);
    expect(out.mode === 'query' && out.query).toBeNull();
    expect(out.mode === 'query' && out.explanation).toBe('That table is not in the schema I was given.');
  });

  it('parses draft-docs targets and skips malformed blocks', () => {
    const out = parseAiOutput('<doc>\nfield fd_1\nThe email.\n</doc><doc>nonsense</doc>', 'draft-docs', OPTIONS);
    expect(out.mode === 'draft-docs' && out.suggestions).toEqual([
      { target: { type: 'field', id: 'fd_1' }, plainText: 'The email.' },
    ]);
    expect(out.parseWarnings).toHaveLength(1);
  });

  it('parses draft-schema DDL', () => {
    const out = parseAiOutput('<ddl>\nCREATE TABLE a (id int);\n</ddl>', 'draft-schema', OPTIONS);
    expect(out).toEqual({ mode: 'draft-schema', source: 'CREATE TABLE a (id int);', importFormat: 'ddl', parseWarnings: [] });
  });
});

describe('defaultJoinPaths', () => {
  const entity = (id: string, restricted?: true) => ({ id, name: restricted ? '' : id, ...(restricted ? { restricted } : {}) });
  const link = (id: string, from: string, to: string) => ({
    id,
    from: { entityId: from, fieldIds: [] },
    to: { entityId: to, fieldIds: [] },
  });
  const model = {
    objects: {
      entity: Object.fromEntries(
        [entity('orders'), entity('items'), entity('products'), entity('secret', true)].map((e) => [e.id, e]),
      ),
      link: Object.fromEntries(
        [link('l1', 'items', 'orders'), link('l2', 'items', 'products'), link('l3', 'orders', 'secret'), link('l4', 'secret', 'products')].map(
          (l) => [l.id, l],
        ),
      ),
    },
  } as unknown as RedactedModel;

  it('routes through visible entities only and names what to add', () => {
    const [path] = defaultJoinPaths({ model, selectedEntityIds: ['orders', 'products'], maxHops: 3, maxSuggestions: 5 });
    expect(path?.reason).toBe('orders -> items -> products');
    expect(path?.addedEntityIds).toEqual(['items']);
    expect(path?.connects).toEqual(['orders', 'products']);
  });

  it('respects maxHops', () => {
    expect(defaultJoinPaths({ model, selectedEntityIds: ['orders', 'products'], maxHops: 1, maxSuggestions: 5 })).toEqual([]);
  });
});
