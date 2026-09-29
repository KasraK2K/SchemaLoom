import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryList, ValidationNotes } from './queries-panel';
import { isReadOnly, parseTags, type QueryValidation, type SavedQuery } from './queries-api';

const NOW = Date.parse('2026-09-28T12:00:00Z');

const query = (over: Partial<SavedQuery> = {}): SavedQuery => ({
  id: 'sq_1',
  projectId: 'prj_1',
  name: 'Top customers',
  description: null,
  queryText: 'SELECT 1',
  language: 'sql',
  tags: ['sales', 'weekly'],
  identifiersResolved: true,
  touchedEntityIds: ['ent_1'],
  createdById: 'usr_1',
  canEdit: true,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-28T10:00:00Z',
  ...over,
});

const noop = () => undefined;

const validation = (over: Partial<QueryValidation> = {}): QueryValidation => ({
  parsed: true,
  parseErrors: [],
  identifiers: [],
  touchedEntityIds: [],
  statementKinds: ['SELECT'],
  ...over,
});

describe('<QueryList>', () => {
  it('renders name, tags and when it was updated', () => {
    const html = renderToStaticMarkup(
      <QueryList queries={[query()]} onOpen={noop} onDelete={noop} onShow={noop} now={NOW} />,
    );
    expect(html).toContain('Top customers');
    expect(html).toContain('sales, weekly');
    expect(html).toContain('Updated 2 hours ago');
    expect(html).toContain('Delete Top customers');
  });

  it('offers delete only to someone who may edit, and Show only with touched tables', () => {
    const html = renderToStaticMarkup(
      <QueryList
        queries={[query({ canEdit: false, touchedEntityIds: [] })]}
        onOpen={noop}
        onDelete={noop}
        onShow={noop}
        now={NOW}
      />,
    );
    expect(html).not.toContain('Delete');
    expect(html).not.toContain('Show');
  });

  it('says so when the library is empty', () => {
    const html = renderToStaticMarkup(
      <QueryList queries={[]} onOpen={noop} onDelete={noop} onShow={noop} />,
    );
    expect(html).toContain('No saved queries yet.');
  });
});

describe('<ValidationNotes>', () => {
  it('warns when a statement is not a SELECT', () => {
    const v = validation({ statementKinds: ['SELECT', 'DELETE'] });
    expect(isReadOnly(v)).toBe(false);
    expect(renderToStaticMarkup(<ValidationNotes validation={v} />)).toContain(
      'Not read-only: this query contains SELECT, DELETE.',
    );
  });

  it('counts unknown and ambiguous identifiers, and stays quiet for a clean SELECT', () => {
    const ident = {
      range: { start: 0, end: 1 },
      role: 'entity',
      messageCode: null,
      suggestions: [],
    };
    const v = validation({
      identifiers: [
        { ...ident, text: 'a', status: 'unknown' },
        { ...ident, text: 'b', status: 'ambiguous' },
        { ...ident, text: 'c', status: 'resolved' },
      ],
    });
    expect(renderToStaticMarkup(<ValidationNotes validation={v} />)).toContain(
      '2 identifiers not found',
    );
    expect(renderToStaticMarkup(<ValidationNotes validation={validation()} />)).toBe(
      '<div class="flex flex-col gap-1 text-xs"></div>',
    );
  });
});

describe('parseTags', () => {
  it('trims, drops empties and dedupes', () => {
    expect(parseTags(' a, b ,,a ')).toEqual(['a', 'b']);
  });
});
