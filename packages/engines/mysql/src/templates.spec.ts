import { describe, expect, it } from 'vitest';
import { IMPORTER } from './importer.js';
import { TEMPLATES } from './templates.js';
import { VALIDATOR } from './validator.js';

describe('MySQL templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s imports with no validator errors, and arrives documented',
    async (_id, template) => {
      let n = 0;
      const context = { projectId: 'p1', serverVersion: 'MySQL 8.4' };
      const { model, docs } = await IMPORTER.import(
        template.source,
        { format: 'ddl', defaultNamespace: null, caseFolding: 'preserve', engineOptions: {} },
        { ...context, newId: () => `id${String((n += 1)).padStart(5, '0')}` },
      );
      const errors = VALIDATOR.validate({ model, context }).filter((d) => d.severity === 'error');
      expect(errors.map((d) => `${d.code} ${d.target.id}`)).toEqual([]);
      // Every table carries a COMMENT.
      const tables = Object.values(model.objects.entity).map((e) => e.id);
      expect(tables.every((id) => docs?.some((d) => d.target.id === id))).toBe(true);
    },
  );
});
