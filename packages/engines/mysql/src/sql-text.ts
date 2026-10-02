import { RESERVED_WORDS } from './reserved-words.js';

const UNQUOTED = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(RESERVED_WORDS);

/** A name as a MySQL user would write it: bare when that is valid, backtick-quoted otherwise. */
export function quoteIdentifier(name: string): string {
  if (UNQUOTED.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  return `\`${name.replace(/`/g, '``')}\``;
}
