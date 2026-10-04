import { parseSqlite } from './parser.js';

/**
 * Drift — two view bodies are the same query when their parse trees are, once parentheses,
 * locations and quoting are set aside. SQLite stores a view's SQL as it was written, so a design
 * imported from the same database matches as text already; this catches the same view typed
 * in another spelling (`"orders"` for `orders`, extra parentheses). False when either side
 * doesn't parse.
 */
export async function sameViewBody(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([parseSqlite(a), parseSqlite(b)]);
    return JSON.stringify(canonical(x)) === JSON.stringify(canonical(y));
  } catch {
    return false;
  }
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isNode(value)) return typeof value === 'string' ? value.toLowerCase() : value;
  // A quoted name and a bare one are the same name.
  if (
    value.type === 'backticks_quote_string' ||
    value.type === 'double_quote_string' ||
    value.type === 'default'
  ) {
    return typeof value.value === 'string' ? value.value.toLowerCase() : value.value;
  }
  const out: Node = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || key === 'parentheses' || key === 'loc') continue;
    out[key] = canonical(v);
  }
  return out;
}
