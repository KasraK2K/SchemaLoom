import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class name joiner. `clsx` flattens conditionals/arrays/objects; `tailwind-merge`
 * then drops earlier utilities that the later ones would override anyway.
 *
 * The merge is the whole point: a component sets `px-3`, a caller passes `px-6`, and
 * plain concatenation leaves both in the class list where the winner is decided by
 * stylesheet order rather than by the caller. `cn` makes the caller win.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
