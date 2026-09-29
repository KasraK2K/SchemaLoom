import { isDeepStrictEqual } from 'node:util';
import {
  compareEngineVersion,
  parseEngineProps,
  propsUpgradePath,
  type EngineDefinition,
  type EnginePropsKind,
  type EngineProps,
  type EngineRegistry,
} from '@schemaloom/engine-sdk';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { toProps } from '../schema/row-read';

/**
 * Doc 00 Q19 / doc 03 §15.1 — the operator job that moves a project off an older engine
 * major. Until it runs, `EngineGate` keeps the project read-only.
 *
 * Deliberate, never a side effect of opening a page: one transaction per project, under the
 * same advisory lock the sharing writes take, run as the system (no actor). Every object's
 * props go through the engine's `propsUpgrades` chain and must then pass the NEW
 * `propsSchemas`. One rejection rolls the whole project back, so it stays read-only and
 * nothing is half-converted. Changed rows get a `version` bump (C7) so a stale client 409s
 * and reloads instead of writing old-shape props back.
 *
 * Snapshots keep their own stamp and stay refused across majors (§15.2).
 */

export type UpgradeResult =
  | {
      readonly status: 'upgraded';
      readonly from: string;
      readonly to: string;
      readonly rowsChanged: number;
    }
  | { readonly status: 'current' }
  | { readonly status: 'skipped'; readonly reason: 'engine-missing' | 'project-newer-than-engine' };

export class UpgradeRejectedError extends Error {
  constructor(
    readonly projectId: string,
    readonly rejected: readonly string[],
  ) {
    super(
      `project ${projectId}: ${String(rejected.length)} object(s) fail the new props schemas ` +
        `(${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? ', …' : ''}); nothing was changed`,
    );
  }
}

type Tx = Prisma.TransactionClient;

interface PropsRow {
  /** for the error message and the write */
  readonly label: string;
  readonly subKind: string | null;
  readonly engineProps: unknown;
  write(tx: Tx, props: EngineProps): Promise<unknown>;
}

const json = (props: EngineProps): Prisma.InputJsonValue => props as Prisma.InputJsonValue;
const bump = { increment: 1 } as const;

/** Every table that stores `engineProps`, as (kind, rows). Mirrors `EnginePropsKind`. */
async function propsRows(tx: Tx, projectId: string): Promise<[EnginePropsKind, PropsRow[]][]> {
  const where = { projectId };
  const [namespace, customType, entity, field, constraint, index, indexColumn, link] =
    await Promise.all([
      tx.namespace.findMany({ where, select: { id: true, engineProps: true } }),
      tx.customType.findMany({ where, select: { id: true, kind: true, engineProps: true } }),
      tx.entity.findMany({ where, select: { id: true, kind: true, engineProps: true } }),
      tx.field.findMany({ where, select: { id: true, engineProps: true } }),
      tx.constraint.findMany({ where, select: { id: true, engineProps: true } }),
      tx.schemaIndex.findMany({ where, select: { id: true, engineProps: true } }),
      tx.schemaIndexColumn.findMany({
        where,
        select: { indexId: true, ordinal: true, engineProps: true },
      }),
      tx.link.findMany({ where, select: { id: true, kind: true, engineProps: true } }),
    ]);

  return [
    [
      'namespace',
      namespace.map((r) => ({
        label: `namespace ${r.id}`,
        subKind: null,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.namespace.update({
            where: { id: r.id },
            data: { engineProps: json(p), version: bump },
          }),
      })),
    ],
    [
      'customType',
      customType.map((r) => ({
        label: `customType ${r.id}`,
        subKind: r.kind,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.customType.update({
            where: { id: r.id },
            data: { engineProps: json(p), version: bump },
          }),
      })),
    ],
    [
      'entity',
      entity.map((r) => ({
        label: `entity ${r.id}`,
        subKind: r.kind,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.entity.update({ where: { id: r.id }, data: { engineProps: json(p), version: bump } }),
      })),
    ],
    [
      'field',
      field.map((r) => ({
        label: `field ${r.id}`,
        subKind: null,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.field.update({ where: { id: r.id }, data: { engineProps: json(p), version: bump } }),
      })),
    ],
    [
      'constraint',
      constraint.map((r) => ({
        label: `constraint ${r.id}`,
        subKind: null,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.constraint.update({
            where: { id: r.id },
            data: { engineProps: json(p), version: bump },
          }),
      })),
    ],
    [
      'index',
      index.map((r) => ({
        label: `index ${r.id}`,
        subKind: null,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.schemaIndex.update({
            where: { id: r.id },
            data: { engineProps: json(p), version: bump },
          }),
      })),
    ],
    // Index columns have no version of their own; their index's row carries it.
    [
      'indexColumn',
      indexColumn.map((r) => ({
        label: `indexColumn ${r.indexId}#${String(r.ordinal)}`,
        subKind: null,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.schemaIndexColumn.update({
            where: { indexId_ordinal: { indexId: r.indexId, ordinal: r.ordinal } },
            data: { engineProps: json(p) },
          }),
      })),
    ],
    [
      'link',
      link.map((r) => ({
        label: `link ${r.id}`,
        subKind: r.kind,
        engineProps: r.engineProps,
        write: (t: Tx, p: EngineProps) =>
          t.link.update({ where: { id: r.id }, data: { engineProps: json(p), version: bump } }),
      })),
    ],
  ];
}

export async function upgradeProject(
  db: Pick<PrismaClient, '$transaction'>,
  registry: EngineRegistry,
  projectId: string,
): Promise<UpgradeResult> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`;
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { organizationId: true, engineId: true, enginePluginVersion: true },
      });
      if (project === null) throw new Error(`project ${projectId} not found`);

      const engine: EngineDefinition | undefined = registry.tryGet(project.engineId);
      const verdict = compareEngineVersion(project.enginePluginVersion, engine);
      if (verdict.action === 'ok') return { status: 'current' };
      if (engine === undefined || verdict.reason !== 'project-older-major') {
        return {
          status: 'skipped',
          reason: verdict.reason === 'project-older-major' ? 'engine-missing' : verdict.reason,
        };
      }

      const path = propsUpgradePath(project.enginePluginVersion, engine);
      const rejected: string[] = [];
      const writes: [PropsRow, EngineProps][] = [];
      for (const [kind, rows] of await propsRows(tx, projectId)) {
        for (const row of rows) {
          const before = toProps(row.engineProps);
          const after = path.reduce(
            (props, step) => step.upgrade(kind, row.subKind, props),
            before,
          );
          const parsed = parseEngineProps(engine, kind, row.subKind, after);
          if (!parsed.ok) rejected.push(row.label);
          else if (!isDeepStrictEqual(before, parsed.props)) writes.push([row, parsed.props]);
        }
      }
      // Validate everything before writing anything: the throw rolls back, and the message
      // names what the engine's upgrade got wrong.
      if (rejected.length > 0) throw new UpgradeRejectedError(projectId, rejected);

      for (const [row, props] of writes) await row.write(tx, props);
      await tx.project.update({
        where: { id: projectId },
        data: { enginePluginVersion: engine.version },
      });
      await tx.auditLog.create({
        data: {
          organizationId: project.organizationId,
          projectId,
          action: 'project.engine_upgraded',
          resourceType: 'project',
          resourceId: projectId,
          metadata: {
            engineId: engine.id,
            from: project.enginePluginVersion,
            to: engine.version,
            rowsChanged: writes.length,
          },
        },
      });
      return {
        status: 'upgraded',
        from: project.enginePluginVersion,
        to: engine.version,
        rowsChanged: writes.length,
      };
    },
    // An operator job over a whole project: Prisma's 5 s interactive default is for requests.
    { timeout: 10 * 60_000, maxWait: 60_000 },
  );
}
