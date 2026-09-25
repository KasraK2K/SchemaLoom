'use client';

import type { Index } from '@schemaloom/schema-model';
import { Button } from '@schemaloom/ui';
import { CapabilityGate } from './capability-gate';
import { useEngine } from './engine-provider';
import { useTerminology } from './use-terminology';

/**
 * §16.5's worked example: the panel HIDES ITSELF for an engine whose capabilities say it has
 * no indexes. Suppose a Cassandra engine registers with `features.indexes: false` — this file
 * needs no edit, because the gate asks the facet the registry resolved and never asks which
 * engine it is.
 *
 * Every word on screen comes from the engine's terminology bundle: "Indexes" for PostgreSQL,
 * whatever the engine calls them elsewhere, in singular, plural AND verb forms.
 */
export function IndexesPanel({
  indexes,
  onAdd,
}: {
  readonly indexes: readonly Index[];
  readonly onAdd?: () => void;
}) {
  const t = useTerminology();
  const { capabilities } = useEngine();
  const defaultType = capabilities.indexTypes.find((type) => type.isDefault);

  return (
    <CapabilityGate feature="indexes">
      <section className="flex flex-col gap-2 p-3" aria-label={t.msg('list.title', 'index')}>
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">{t.msg('list.title', 'index')}</h2>
          <span className="text-xs text-text-subtle">
            {t.msg('list.count', 'index', { count: indexes.length })}
          </span>
        </header>

        {indexes.length === 0 ? (
          <p className="text-xs text-text-subtle">{t.msg('list.empty', 'index')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {indexes.map((index) => (
              <li key={index.id} className="flex items-center gap-2 text-xs text-text">
                <span className="truncate">{index.name}</span>
                {index.isUnique ? (
                  <span className="rounded bg-accent-subtle px-1 text-[10px] text-accent-text">
                    UQ
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-text-subtle">{index.kind}</span>
              </li>
            ))}
          </ul>
        )}

        <Button size="sm" variant="outline" onClick={onAdd} className="self-start">
          {indexes.length === 0
            ? t.msg('action.addFirst', 'index')
            : t.msg('action.add', 'index')}
        </Button>
        {defaultType === undefined ? null : (
          <p className="text-[11px] text-text-subtle">{defaultType.summary}</p>
        )}
      </section>
    </CapabilityGate>
  );
}
