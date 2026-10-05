/**
 * Phase 12 — a starting schema the engine ships. Starting from one is "Import SQL" with the
 * text already filled in: the web app creates the project and runs the ordinary import, so a
 * template has no write path of its own.
 *
 * On `EngineDefinition` (the server half), not the static facet: the browser lists templates
 * from `GET /engines` and fetches only the source it is about to import.
 */
export interface ProjectTemplate {
  /** kebab-case, unique within the engine, stable */
  readonly id: string;
  /** 'E-commerce' */
  readonly title: string;
  /** one line for the picker */
  readonly summary: string;
  /** shown in the picker; `templates/import-cleanly` checks it against the import */
  readonly tableCount: number;
  /** one of `capabilities.importFormats` */
  readonly importFormat: string;
  readonly source: string;
  /**
   * Phase 12b — cards the project opens with. The web writes them as one ops batch after
   * the import, skipping a table name it can't find. `color` is an area token
   * (`area-1` … `area-16`); `templates/import-cleanly` checks every table name exists.
   */
  readonly areas?: readonly TemplateArea[];
}

export interface TemplateArea {
  readonly name: string;
  readonly color: string;
  readonly tables: readonly string[];
}

/** What `GET /engines` lists: everything but the source. */
export type ProjectTemplateSummary = Omit<ProjectTemplate, 'importFormat' | 'source' | 'areas'>;
