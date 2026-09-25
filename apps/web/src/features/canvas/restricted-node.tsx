import { cn } from '@schemaloom/ui';

/**
 * A restricted entity — doc 04 §10.2's stub, drawn.
 *
 * IT TAKES NO ENTITY. Not a name, not an id, not a kind: a component that cannot receive
 * the object cannot leak it, which is a stronger guarantee than a renderer trusted to
 * ignore fields it was handed. The server already blanked the name to `''`
 * (`stubEntity`), and the failure this shape rules out is the tempting `entity.name ||
 * entity.id` fallback — a cuid is not a name, but it is a stable handle an outsider can
 * correlate across projects and screenshots.
 *
 * `position` is real, so the diagram does not reflow per viewer, and the node still
 * carries handles (`NodeHandles`, placed by the caller) so its edges keep drawing. A box
 * that something connects to is the entire point of a stub: "there is a table here and you
 * may not see it" is information the viewer is entitled to.
 *
 * The padlock is the literal character, matching the lock the engine's own `FieldRow`
 * draws on a masked field; `@schemaloom/ui` exports no lock icon and adding one to another
 * package for a single glyph is not worth the edit.
 */
export function RestrictedNode({ selected }: { readonly selected: boolean }) {
  return (
    <div
      data-restricted="true"
      className={cn(
        'flex min-w-40 items-center gap-1.5 rounded-lg border border-dashed bg-surface-sunken px-3 py-2 opacity-60',
        selected ? 'border-accent ring-1 ring-accent' : 'border-border',
      )}
    >
      <span aria-hidden="true" className="text-xs">
        &#128274;
      </span>
      <span className="text-xs text-text-subtle">restricted</span>
    </div>
  );
}
