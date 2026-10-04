import { BadRequestException } from '@nestjs/common';
import { renderStatements, type EngineDefinition } from '@schemaloom/engine-sdk';
import { isOrmId, subsetModel, type OrmId } from '@schemaloom/orm';
import type { RedactedModel } from '@schemaloom/schema-model';

/**
 * Phase 18 §2.1 — a selection's model code in one ORM: the exporter over the REDACTED model,
 * cut to the selected tables and those they refer to. Shared by the Models pane route and the
 * AI's code-mode context, so the two always show the same names.
 */
export async function renderOrmCode(
  engine: EngineDefinition,
  model: RedactedModel,
  orm: string,
  entityIds: readonly string[],
  includeComments: boolean,
): Promise<{ readonly orm: OrmId; readonly text: string; readonly incomplete: boolean }> {
  if (
    !isOrmId(orm) ||
    engine.exporter === undefined ||
    !engine.capabilities.exportFormats.some((f) => f.id === orm)
  ) {
    throw new BadRequestException({ code: 'orm_unsupported', orm });
  }
  const result = await engine.exporter.export({
    model: subsetModel(model, entityIds),
    options: {
      format: orm,
      includeComments,
      includeDrops: false,
      includeIfNotExists: false,
      engineOptions: {},
    },
    context: { projectId: model.projectId, serverVersion: model.engineVersion },
  });
  return { orm, text: renderStatements(result), incomplete: result.incomplete };
}
