/**
 * Class strings shared by the floating-surface primitives (menu, popover, select,
 * tooltip). One definition, so a popover and a dropdown cannot drift apart.
 * Semantic tokens only — `theme.css` owns every raw value.
 */
export const floatingSurface =
  'z-50 overflow-hidden rounded-md border border-border bg-surface-raised text-text shadow-popover';

export const menuItemBase =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-on-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

export const menuLabelBase = 'px-2 py-1.5 text-xs font-medium text-text-subtle';

export const menuSeparatorBase = '-mx-1 my-1 h-px bg-border';
