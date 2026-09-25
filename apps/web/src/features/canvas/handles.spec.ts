import { describe, expect, it } from 'vitest';
import { NODE_HANDLE, fieldHandleId, parseHandleId } from './handles';

describe('handle ids', () => {
  it('round-trips a field handle', () => {
    const id = fieldHandleId('f_abc', 'source');
    expect(id).toBe('f_abc:source');
    expect(parseHandleId(id)).toEqual({ fieldId: 'f_abc', side: 'source' });
  });

  it('reads the card-level handle as an endpoint with no field', () => {
    expect(parseHandleId(NODE_HANDLE.target)).toEqual({ fieldId: null, side: 'target' });
  });

  it('rejects anything that is not a handle id', () => {
    // These arrive from DOM attributes, so this is a parse and not a cast.
    expect(parseHandleId(null)).toBeNull();
    expect(parseHandleId(undefined)).toBeNull();
    expect(parseHandleId('')).toBeNull();
    expect(parseHandleId('f_abc')).toBeNull();
    expect(parseHandleId('f_abc:middle')).toBeNull();
    expect(parseHandleId(':source')).toBeNull();
  });
});
