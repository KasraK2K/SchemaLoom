import { describe, expect, it } from 'vitest';
import { fixtureFacet } from './fixture-engine.js';
import { parseEngineProps } from './props.js';
import { renderDiagnostic } from './diagnostics.js';

describe('parseEngineProps', () => {
  it('accepts good props and returns the zod-parsed value', () => {
    const result = parseEngineProps(fixtureFacet, 'entity', 'table', { fillfactor: 90 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.props).toEqual({ fillfactor: 90 });
  });

  it('resolves per sub-kind: a view takes none of the table props', () => {
    expect(parseEngineProps(fixtureFacet, 'entity', 'view', {}).ok).toBe(true);
    expect(parseEngineProps(fixtureFacet, 'entity', 'view', { fillfactor: 90 }).ok).toBe(false);
  });

  it('rejects an unknown key, because every props schema is .strict()', () => {
    const result = parseEngineProps(fixtureFacet, 'entity', 'table', { compression: 'lz4' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('fixturesql.props-invalid');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  it('puts the zod path on target.propPath so the inspector can highlight the input', () => {
    const result = parseEngineProps(fixtureFacet, 'entity', 'table', { fillfactor: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.target).toMatchObject({
      type: 'entity',
      propPath: ['fillfactor'],
    });
  });

  it('routes indexColumn diagnostics to the owning index, which is the IR object', () => {
    const result = parseEngineProps(fixtureFacet, 'indexColumn', null, { opclass: 'text_ops' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.target.type).toBe('index');
  });

  it('produces a diagnostic the engine catalog can render', () => {
    const result = parseEngineProps(fixtureFacet, 'field', null, { default: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const first = result.diagnostics[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const rendered = renderDiagnostic(
      fixtureFacet.diagnosticMessages,
      fixtureFacet.terminology,
      first,
      () => null,
    );
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toBe('fixturesql.props-invalid');
  });
});
