import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button.js';

/**
 * The class-name half of Button. The rendering half lives in apps/web
 * (`src/components/button-render.spec.tsx`) because this package has no DOM test
 * environment and no react-dom types of its own.
 */
describe('buttonVariants', () => {
  it('applies the default variant and size when none is given', () => {
    const cls = buttonVariants();
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('h-9');
  });

  it('emits a distinct class set per variant', () => {
    expect(buttonVariants({ variant: 'danger' })).toContain('bg-danger');
    expect(buttonVariants({ variant: 'outline' })).toContain('border-border');
    expect(buttonVariants({ variant: 'ghost' })).toContain('text-text-muted');
    expect(buttonVariants({ variant: 'secondary' })).toContain('bg-surface-sunken');
  });

  it('emits a distinct class set per size', () => {
    expect(buttonVariants({ size: 'sm' })).toContain('h-7');
    expect(buttonVariants({ size: 'lg' })).toContain('h-11');
    expect(buttonVariants({ size: 'icon' })).toContain('size-9');
  });

  it('always carries the shared base classes', () => {
    for (const variant of ['primary', 'secondary', 'outline', 'ghost', 'danger'] as const) {
      expect(buttonVariants({ variant })).toContain('inline-flex');
      expect(buttonVariants({ variant })).toContain('disabled:opacity-50');
    }
  });
});
