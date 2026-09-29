import {
  constantProps,
  type EngineDefinition,
  type EngineRegistry,
  type PropsUpgrade,
} from '@schemaloom/engine-sdk';
import { z } from 'zod';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client';
import { EngineGate, ProjectReadOnlyException } from './engine-gate.service';
import { UpgradeRejectedError, upgradeProject } from './engine-upgrade';

/**
 * Doc 00 Q19 against a real Postgres (`DATABASE_URL_TEST`): an engine at 2.0.0 whose only
 * breaking change renames the field prop `defaultValue` to `default`.
 */

const url = process.env.DATABASE_URL_TEST;
const TAG = 'engine-upgrade-spec';
const ORG = `org_${TAG}`;
const PROJECT = `prj_${TAG}`;

const STRICT = z.object({}).strict();
const renameDefault: PropsUpgrade = {
  fromMajor: 1,
  upgrade: (kind, _subKind, props) => {
    if (kind !== 'field' || !('defaultValue' in props)) return props;
    const { defaultValue, ...rest } = props;
    return { ...rest, default: defaultValue };
  },
};
const engine = {
  id: 'upgradesql',
  version: '2.0.0',
  propsSchemas: {
    namespace: constantProps(STRICT),
    customType: constantProps(STRICT),
    entity: constantProps(z.object({ fillfactor: z.number().optional() }).strict()),
    field: constantProps(z.object({ default: z.string().optional() }).strict()),
    constraint: constantProps(STRICT),
    index: constantProps(STRICT),
    indexColumn: constantProps(STRICT),
    link: constantProps(STRICT),
  },
  propsUpgrades: [renameDefault],
} as unknown as EngineDefinition;
const registry = {
  tryGet: (id: string) => (id === engine.id ? engine : undefined),
} as unknown as EngineRegistry;

describe.skipIf(url === undefined)('engine major upgrade (doc 00 Q19)', () => {
  const db = new PrismaClient({ datasourceUrl: url });

  const cleanup = async (): Promise<void> => {
    await db.auditLog.deleteMany({ where: { projectId: PROJECT } });
    await db.organization.deleteMany({ where: { id: ORG } });
  };

  beforeEach(async () => {
    await cleanup();
    await db.organization.create({ data: { id: ORG, name: TAG, slug: TAG } });
    await db.workspace.create({
      data: { id: `ws_${TAG}`, organizationId: ORG, name: TAG, slug: TAG },
    });
    await db.project.create({
      data: {
        id: PROJECT,
        organizationId: ORG,
        workspaceId: `ws_${TAG}`,
        name: TAG,
        slug: TAG,
        engineId: engine.id,
        engineVersion: '1',
        enginePluginVersion: '1.2.0',
      },
    });
    await db.entity.create({
      data: {
        id: `ent_${TAG}`,
        projectId: PROJECT,
        name: 'orders',
        engineProps: { fillfactor: 70 },
      },
    });
    await db.field.create({
      data: {
        id: `fld_${TAG}`,
        projectId: PROJECT,
        entityId: `ent_${TAG}`,
        name: 'created_at',
        dataType: 'timestamptz',
        engineProps: { defaultValue: 'now()' },
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it('is read-only before, converts the props, stamps the project and is writable after', async () => {
    const gate = new EngineGate(registry);
    await expect(db.$transaction((tx) => gate.checkWrite(tx, PROJECT))).rejects.toBeInstanceOf(
      ProjectReadOnlyException,
    );

    const result = await upgradeProject(db, registry, PROJECT);
    expect(result).toEqual({ status: 'upgraded', from: '1.2.0', to: '2.0.0', rowsChanged: 1 });

    const field = await db.field.findUniqueOrThrow({ where: { id: `fld_${TAG}` } });
    expect(field.engineProps).toEqual({ default: 'now()' });
    expect(field.version).toBe(1);
    const entity = await db.entity.findUniqueOrThrow({ where: { id: `ent_${TAG}` } });
    expect(entity.version).toBe(0); // unchanged props, untouched row

    const project = await db.project.findUniqueOrThrow({ where: { id: PROJECT } });
    expect(project.enginePluginVersion).toBe('2.0.0');
    const audit = await db.auditLog.findFirstOrThrow({
      where: { projectId: PROJECT, action: 'project.engine_upgraded' },
    });
    expect(audit.metadata).toMatchObject({ from: '1.2.0', to: '2.0.0', rowsChanged: 1 });

    await db.$transaction((tx) => gate.checkWrite(tx, PROJECT)); // writable now
    expect(await upgradeProject(db, registry, PROJECT)).toEqual({ status: 'current' });
  });

  it('rolls everything back when one object fails the new schemas', async () => {
    await db.entity.update({ where: { id: `ent_${TAG}` }, data: { engineProps: { bogus: 1 } } });

    await expect(upgradeProject(db, registry, PROJECT)).rejects.toBeInstanceOf(
      UpgradeRejectedError,
    );

    const field = await db.field.findUniqueOrThrow({ where: { id: `fld_${TAG}` } });
    expect(field.engineProps).toEqual({ defaultValue: 'now()' });
    const project = await db.project.findUniqueOrThrow({ where: { id: PROJECT } });
    expect(project.enginePluginVersion).toBe('1.2.0');
  });
});
