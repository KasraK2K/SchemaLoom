import {
  renderStatements,
  type EngineDefinition,
  type ExportOptions,
} from '@schemaloom/engine-sdk';
import type { IrObject, RedactedModel } from '@schemaloom/schema-model';
import { renderMarkdown, type ExportDoc } from './export-markdown';
import { renderPdf } from './export-pdf';

/**
 * Doc 01 §4.3 — what is rendered where.
 *
 * | Format | Where |
 * |---|---|
 * | engine DDL | here, through the engine's `exporter` |
 * | `ir-json` | here, `VisibilityFilter` -> IR serialise |
 * | `markdown` | here, with the full doc text |
 * | `pdf` | here, `pdfkit` (Phase 5 §2) |
 * | SVG / PNG | the CLIENT, uploaded with a presigned PUT — `apps/api` has no headless browser |
 */
export const CORE_EXPORT_FORMATS = ['ir-json', 'markdown', 'pdf'] as const;

/** The two formats the browser renders from the canvas and uploads (`ExportsService`). */
export const IMAGE_EXPORT_FORMATS = {
  png: { contentType: 'image/png', fileExtension: 'png' },
  svg: { contentType: 'image/svg+xml', fileExtension: 'svg' },
} as const;

export type CoreExportFormat = (typeof CORE_EXPORT_FORMATS)[number];

const isCoreFormat = (format: string): format is CoreExportFormat =>
  (CORE_EXPORT_FORMATS as readonly string[]).includes(format);

export interface RenderExportInput {
  /**
   * ALREADY redacted. The branded type IS the enforcement (doc 03 §2.1 / doc 05 §8.6):
   * a `SchemaModel` does not typecheck here, and `redact()` is its only minter — so
   * "exports respect permissions" is a compile error rather than a review habit.
   */
  readonly model: RedactedModel;
  readonly format: string;
  readonly engine: EngineDefinition;
  readonly options?: Partial<ExportOptions>;
  /** The requester's view is partial (`!isCompleteView`). A wholly hidden table leaves no
   *  stub behind, so the model alone cannot tell; the processor passes this. */
  readonly partialView?: boolean;
  /** This project's `docs` rows, for `markdown` and `pdf`. Filtered against `model` there. */
  readonly docs?: readonly ExportDoc[];
}

export interface RenderedExport {
  /** Text formats are a string; `pdf` is binary. */
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly fileExtension: string;
  /** doc 03 §10.3 — a boolean, never a count (doc 05 §8.4 L8). */
  readonly incomplete: boolean;
}

/** Raised when the runtime net below catches what the type should have stopped. */
export class UnredactedExportError extends Error {
  constructor() {
    super('export_requires_redacted_model');
    this.name = 'UnredactedExportError';
  }
}

export class UnsupportedExportFormatError extends Error {
  constructor(engineId: string, format: string) {
    super(`engine ${engineId} exports no format '${format}'`);
    this.name = 'UnsupportedExportFormatError';
  }
}

/**
 * The SECOND net. `RedactedModel`'s brand is phantom, so a cast — or a payload that took a
 * trip through JSON and came back unbranded — reaches here with the type satisfied and the
 * property not. The runtime marker is the ordinary `redacted: true` field the model
 * already carries (doc 04 §1.1), so checking it costs nothing and closes the only hole the
 * compiler cannot. Same shape as `snapshots/live-ir.ts`'s `asLive`, pointed the other way.
 */
function assertRedacted(model: RedactedModel): void {
  if (!model.redacted) throw new UnredactedExportError();
}

/** True when redaction removed or altered anything the requester can tell apart. */
function isIncomplete(model: RedactedModel): boolean {
  for (const collection of Object.values(model.objects)) {
    for (const object of Object.values<IrObject>(collection)) {
      if (object.restricted === true || object.propsRedacted === true) return true;
    }
  }
  return false;
}

export async function renderExport(input: RenderExportInput): Promise<RenderedExport> {
  const { model, format, engine } = input;
  assertRedacted(model);

  if (isCoreFormat(format)) {
    const incomplete = input.partialView === true || isIncomplete(model);
    const docOptions = { docs: input.docs ?? [], incomplete };
    switch (format) {
      case 'ir-json':
        return {
          // `null, 2` and not a compact blob: an IR export is read by a human or diffed
          // by a tool, and both want one key per line.
          body: JSON.stringify(model, null, 2),
          contentType: 'application/json; charset=utf-8',
          fileExtension: 'json',
          incomplete,
        };
      case 'markdown':
        return {
          body: renderMarkdown(model, docOptions),
          contentType: 'text/markdown; charset=utf-8',
          fileExtension: 'md',
          incomplete,
        };
      case 'pdf':
        return {
          body: await renderPdf(model, docOptions),
          contentType: 'application/pdf',
          fileExtension: 'pdf',
          incomplete,
        };
    }
  }

  const descriptor = engine.capabilities.exportFormats.find((f) => f.id === format);
  if (descriptor === undefined || engine.exporter === undefined) {
    throw new UnsupportedExportFormatError(engine.id, format);
  }

  const options: ExportOptions = {
    format,
    includeComments: descriptor.supportsComments,
    includeDrops: false,
    includeIfNotExists: false,
    engineOptions: {},
    ...input.options,
  };

  const result = await engine.exporter.export({
    model,
    options,
    context: { projectId: model.projectId, serverVersion: model.engineVersion },
  });

  return {
    body: renderStatements(result, {
      lineComment: engine.capabilities.queryLanguage.lineComment,
    }),
    contentType: 'text/plain; charset=utf-8',
    fileExtension: descriptor.fileExtension,
    // The engine already accounts for what it could not emit; redaction marks the model
    // itself. Either one makes the download dialog say "this export is incomplete".
    incomplete: result.incomplete || input.partialView === true || isIncomplete(model),
  };
}

/**
 * One export artifact, one key, derived from the `export_jobs` row id — which is what lets
 * the presigned PUT for a client-rendered image name exactly one object (doc 01 §4.3) and
 * what lets the bucket lifecycle rule sweep a project's exports by prefix.
 */
export function exportObjectKey(
  projectId: string,
  exportJobId: string,
  fileExtension: string,
): string {
  return `exports/${projectId}/${exportJobId}.${fileExtension}`;
}
