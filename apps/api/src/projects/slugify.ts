/**
 * `projects_slug_uq` is `(workspace_id, lower(slug)) WHERE deleted_at IS NULL`, so every
 * project needs a slug and nothing routes by it yet — the canvas URL is
 * `/:orgSlug/p/:projectId`. So it is DERIVED from the name rather than accepted from the
 * request: one less field on the trust boundary, and no way for a client to plant a slug
 * that does not match the name shown beside it.
 *
 * A collision is the caller's to resolve — `ProjectsService.create` turns the unique
 * violation into a 409 naming the slug, which reads as "you already have a project called
 * that here". Auto-suffixing (`storefront-2`) was the alternative and is worse: it needs a
 * read inside the transaction that still races another insert, and it silently produces a
 * second project with a near-identical name, which is usually a double-submit.
 */
const FALLBACK = 'project';

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Drop combining marks, so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK : slug;
}
