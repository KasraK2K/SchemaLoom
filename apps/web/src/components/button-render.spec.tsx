import { Button } from '@schemaloom/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * Lives in apps/web rather than in packages/ui because this is where react-dom and
 * its types are installed. It also proves the cross-package wiring: @schemaloom/ui is
 * consumed from source and renders.
 */
describe('<Button>', () => {
  it('renders a button element with the default variant', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('Save');
    expect(html).toContain('bg-accent');
    expect(html).toContain('h-9');
  });

  it('renders each variant with its own classes', () => {
    expect(renderToStaticMarkup(<Button variant="danger">Drop</Button>)).toContain('bg-danger');
    expect(renderToStaticMarkup(<Button variant="outline">Cancel</Button>)).toContain(
      'border-border',
    );
    expect(renderToStaticMarkup(<Button variant="ghost">More</Button>)).toContain(
      'text-text-muted',
    );
  });

  it('renders each size', () => {
    expect(renderToStaticMarkup(<Button size="sm">S</Button>)).toContain('h-7');
    expect(renderToStaticMarkup(<Button size="lg">L</Button>)).toContain('h-11');
    expect(renderToStaticMarkup(<Button size="icon">I</Button>)).toContain('size-9');
  });

  it('lets a caller override a variant class instead of stacking both', () => {
    const html = renderToStaticMarkup(<Button className="bg-surface">Muted</Button>);
    // Whole-token comparison: `bg-accent` is a substring of `hover:bg-accent-hover`,
    // which legitimately survives the merge.
    const classes = (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
    expect(classes).toContain('bg-surface');
    expect(classes).not.toContain('bg-accent');
  });

  it('forwards native button attributes', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" disabled aria-label="Save project">
        Save
      </Button>,
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-label="Save project"');
  });

  it('renders the child element instead of a button when asChild is set', () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/login">Sign in</a>
      </Button>,
    );
    expect(html).toContain('<a');
    expect(html).not.toContain('<button');
    expect(html).toContain('bg-accent');
  });
});
