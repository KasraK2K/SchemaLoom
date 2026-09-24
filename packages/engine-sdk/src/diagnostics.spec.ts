import { describe, expect, it } from 'vitest';
import {
  diagnosticTypeRank,
  renderDiagnostic,
  sortDiagnostics,
  type Diagnostic,
  type QuickFix,
} from './diagnostics.js';
import { FALLBACK_TERMINOLOGY } from './terminology.js';

function diag(overrides: Partial<Diagnostic> & Pick<Diagnostic, 'target'>): Diagnostic {
  return { code: 'e.x', severity: 'error', params: {}, ...overrides };
}

describe('diagnostic ordering (§2.5)', () => {
  it('orders by target type rank, then id, then code, then propPath, then range start', () => {
    const input: readonly Diagnostic[] = [
      diag({ code: 'e.b', target: { type: 'field', id: 'f1' } }),
      diag({ code: 'e.a', target: { type: 'field', id: 'f1' } }),
      diag({ code: 'e.a', target: { type: 'entity', id: 'e9' } }),
      diag({ code: 'e.a', target: { type: 'entity', id: 'e1' } }),
      diag({ code: 'e.a', target: { type: 'project', id: 'p1' } }),
      diag({ code: 'e.a', target: { type: 'field', id: 'f1', propPath: ['b'] } }),
      diag({ code: 'e.a', target: { type: 'field', id: 'f1', propPath: ['a'] } }),
    ];
    expect(sortDiagnostics(input).map((d) => `${d.target.type}/${d.target.id}/${d.code}/${(d.target.propPath ?? []).join('.')}`)).toEqual([
      'project/p1/e.a/',
      'entity/e1/e.a/',
      'entity/e9/e.a/',
      'field/f1/e.a/',
      'field/f1/e.a/a',
      'field/f1/e.a/b',
      'field/f1/e.b/',
    ]);
  });

  it('breaks a final tie on range.start, with no range sorting first', () => {
    const target = { type: 'project', id: 'p1' } as const;
    const withRange = (start: number): Diagnostic =>
      diag({ target, range: { start, end: start + 1, line: 1, column: start } });
    const sorted = sortDiagnostics([withRange(9), diag({ target }), withRange(2)]);
    expect(sorted.map((d) => d.range?.start ?? -1)).toEqual([-1, 2, 9]);
  });

  it('does not mutate its input', () => {
    const input = [diag({ target: { type: 'field', id: 'z' } }), diag({ target: { type: 'entity', id: 'a' } })];
    const before = [...input];
    sortDiagnostics(input);
    expect(input).toEqual(before);
  });

  it('ranks project before every IR object type, in IR_OBJECT_TYPES order', () => {
    expect(diagnosticTypeRank('project')).toBe(-1);
    expect(diagnosticTypeRank('area')).toBe(0);
    expect(diagnosticTypeRank('entity')).toBeLessThan(diagnosticTypeRank('field'));
    expect(diagnosticTypeRank('field')).toBeLessThan(diagnosticTypeRank('link'));
  });
});

describe('renderDiagnostic', () => {
  const messages = {
    'e.link-type-mismatch': '{source} ({sourceType}) is not compatible with {target}',
    'e.fix.rename-to': 'Rename to {name}',
  };

  it('renders a structured diagnostic per recipient', () => {
    const d = diag({
      code: 'e.link-type-mismatch',
      params: {
        source: { type: 'field', id: 'f1' },
        sourceType: 'uuid',
        target: { type: 'field', id: 'f2' },
      },
      target: { type: 'link', id: 'l1' },
    });
    const rendered = renderDiagnostic(messages, FALLBACK_TERMINOLOGY, d, (ref) =>
      ref.id === 'f1' ? 'orders.employee_id' : null,
    );
    // f2 is invisible to this subject, so its NAME never crosses the boundary.
    expect(rendered).toBe('orders.employee_id (uuid) is not compatible with a restricted object');
  });

  it('renders a quick fix label from the same catalog', () => {
    const fix: QuickFix = {
      labelCode: 'e.fix.rename-to',
      labelParams: { name: 'employee_id' },
      targetVersion: 3,
      edit: { op: 'setName', value: 'employee_id' },
    };
    expect(renderDiagnostic(messages, FALLBACK_TERMINOLOGY, fix, () => null)).toBe(
      'Rename to employee_id',
    );
  });

  it('renders an unknown code as the code itself rather than crashing', () => {
    const d = diag({ code: 'e.never-seen', target: { type: 'project', id: 'p1' } });
    expect(renderDiagnostic(messages, FALLBACK_TERMINOLOGY, d, () => null)).toBe('e.never-seen');
  });
});
