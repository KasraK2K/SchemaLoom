import type { AnnouncedEngine } from '@schemaloom/engine-sdk';

/**
 * Doc 01 §4.2 / doc 03 §14 — what the picker advertises before an implementation exists.
 *
 * This is **deployment policy, not an SDK contract**, which is why the list lives here and
 * `engine-sdk` owns only the `AnnouncedEngine` type. The rows carry `icon` and `summary`
 * because the picker card needs both, and a component that invents them is a component that
 * knows engine ids.
 *
 * Status is derived by set difference inside `registry.catalog()`: a registration always wins
 * over an announcement. So when an engine package lands, adding its line to
 * `engines.manifest.ts` is enough — deleting the row here is optional tidying and the picker
 * is untouched either way.
 */
export const COMING_SOON: readonly AnnouncedEngine[] = [
  { id: 'mysql', displayName: 'MySQL', paradigm: 'relational', icon: 'database', summary: 'MySQL 8 and MariaDB' },
  { id: 'sqlserver', displayName: 'SQL Server', paradigm: 'relational', icon: 'database', summary: 'Microsoft SQL Server 2019+' },
  { id: 'sqlite', displayName: 'SQLite', paradigm: 'relational', icon: 'database', summary: 'Embedded SQL' },
  { id: 'mongodb', displayName: 'MongoDB', paradigm: 'document', icon: 'leaf', summary: 'Collections and documents' },
  { id: 'dynamodb', displayName: 'DynamoDB', paradigm: 'key-value', icon: 'zap', summary: 'AWS key-value and document store' },
  { id: 'cassandra', displayName: 'Cassandra', paradigm: 'wide-column', icon: 'columns', summary: 'Wide-column store' },
  { id: 'neo4j', displayName: 'Neo4j', paradigm: 'graph', icon: 'share-2', summary: 'Nodes and relationships' },
];
