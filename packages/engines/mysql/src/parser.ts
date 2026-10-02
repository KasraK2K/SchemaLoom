/**
 * node-sql-parser, loaded lazily so `./static` never pulls it into a browser chunk. Its types
 * are loose; the AST is read through the narrow helpers in `import-ast.ts`.
 */

export type Ast = Record<string, unknown>;

interface NodeSqlParser {
  astify(
    sql: string,
    options: { database: string; parseOptions?: { includeLocations: boolean } },
  ): unknown;
  exprToSQL(expr: unknown, options: { database: string }): string;
  sqlify(ast: unknown, options: { database: string }): string;
}

let loaded: Promise<NodeSqlParser> | undefined;

function load(): Promise<NodeSqlParser> {
  loaded ??= import('node-sql-parser').then((module): NodeSqlParser => {
    const exported = module as unknown as {
      Parser?: new () => NodeSqlParser;
      default?: { Parser: new () => NodeSqlParser };
    };
    const Parser = exported.Parser ?? exported.default?.Parser;
    if (Parser === undefined) throw new Error('node-sql-parser has no Parser export');
    return new Parser();
  });
  return loaded;
}

export interface MySqlParser {
  /** Every statement in `sql`. Tries the target's dialect first, then the other one: the
   *  MariaDB grammar knows `uuid` columns, the MySQL one some ALTER forms MariaDB's lacks. */
  parse(sql: string, options?: { readonly locations?: boolean }): readonly Ast[];
  /** An expression AST back to SQL text, backtick-quoted. */
  expression(expr: unknown): string;
  /** A SELECT AST back to SQL text. */
  select(ast: unknown): string;
}

export async function loadMySqlParser(mariaDbFirst: boolean): Promise<MySqlParser> {
  const parser = await load();
  const dialects = mariaDbFirst ? ['MariaDB', 'MySQL'] : ['MySQL', 'MariaDB'];
  return {
    parse(sql, options) {
      let last: unknown;
      const parseOptions = options?.locations === true ? { includeLocations: true } : undefined;
      for (const database of dialects) {
        try {
          const ast = parser.astify(sql, {
            database,
            ...(parseOptions === undefined ? {} : { parseOptions }),
          });
          return (Array.isArray(ast) ? ast : [ast]).filter(
            (node): node is Ast => typeof node === 'object' && node !== null,
          );
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof Error ? last : new Error('could not parse the statement');
    },
    expression: (expr) => parser.exprToSQL(expr, { database: 'MySQL' }),
    select: (ast) => parser.sqlify(ast, { database: 'MySQL' }),
  };
}

/** A parse error's first line, without the parser's long "expected …" list. */
export function parseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const found = /but "([^"]*)" found/.exec(message)?.[1];
  const line = /line (\d+)/i.exec(message)?.[1];
  if (found !== undefined) {
    return `syntax error near “${found}”${line === undefined ? '' : ` on line ${line}`}`;
  }
  return message.split('\n')[0]?.slice(0, 200) ?? 'syntax error';
}
