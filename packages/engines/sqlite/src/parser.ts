/**
 * node-sql-parser's SQLite grammar, loaded lazily so `./static` never pulls it into a browser
 * chunk. The query validator reads table and column references from its tree.
 */

export type Ast = Record<string, unknown>;

interface NodeSqlParser {
  astify(
    sql: string,
    options: { database: string; parseOptions?: { includeLocations: boolean } },
  ): unknown;
}

let loaded: Promise<NodeSqlParser> | undefined;

export async function parseSqlite(sql: string): Promise<readonly Ast[]> {
  loaded ??= import('node-sql-parser').then((module): NodeSqlParser => {
    const exported = module as unknown as {
      Parser?: new () => NodeSqlParser;
      default?: { Parser: new () => NodeSqlParser };
    };
    const Parser = exported.Parser ?? exported.default?.Parser;
    if (Parser === undefined) throw new Error('node-sql-parser has no Parser export');
    return new Parser();
  });
  const ast = (await loaded).astify(sql, {
    database: 'Sqlite',
    parseOptions: { includeLocations: true },
  });
  return (Array.isArray(ast) ? ast : [ast]).filter(
    (node): node is Ast => typeof node === 'object' && node !== null,
  );
}
