import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';

describe('cn', () => {
  it('keeps the last of two conflicting utilities in the same group', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('resolves conflicts between our semantic colour tokens', () => {
    expect(cn('bg-surface', 'bg-accent')).toBe('bg-accent');
    expect(cn('text-text-muted', 'text-danger-text')).toBe('text-danger-text');
  });

  it('keeps utilities from different groups', () => {
    expect(cn('px-2', 'py-4')).toBe('px-2 py-4');
    expect(cn('bg-surface', 'text-text')).toBe('bg-surface text-text');
  });

  it('flattens conditionals, arrays and objects before merging', () => {
    expect(cn('text-sm', false, undefined, null, ['font-medium'])).toBe('text-sm font-medium');
    expect(cn('p-2', { 'p-4': true, hidden: false })).toBe('p-4');
  });

  it('lets a caller override a component default', () => {
    // The reason this helper exists at all.
    const componentDefault = 'inline-flex h-9 rounded-md bg-accent px-3';
    expect(cn(componentDefault, 'h-7 bg-danger')).toBe('inline-flex rounded-md px-3 h-7 bg-danger');
  });

  it('returns an empty string for no input', () => {
    expect(cn()).toBe('');
  });
});
