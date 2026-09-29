'use client';

import type { SchemaModel } from '@schemaloom/schema-model';
import { Search, cn } from '@schemaloom/ui';
import { useReactFlow } from '@xyflow/react';
import { useId, useMemo, useState } from 'react';
import { useTerminology } from '@/engines';
import { searchModel, type SearchHit } from './search';
import { useCanvasStore } from './store';

/**
 * DESIGN §5 — the canvas toolbar's search box. Matches run in the browser over the model
 * the canvas already holds (`searchModel`); picking a hit selects the entity (or opens
 * the column in the inspector) and centres it. Must render inside `<ReactFlow>`.
 */
export function CanvasSearch({ model }: { readonly model: SchemaModel }) {
  const flow = useReactFlow();
  const t = useTerminology();
  const select = useCanvasStore((s) => s.select);
  const selectField = useCanvasStore((s) => s.selectField);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const hits = useMemo(() => searchModel(model, query, 12), [model, query]);

  const pick = (hit: SearchHit) => {
    if (hit.fieldId === null) select([hit.entityId]);
    else selectField(hit.entityId, hit.fieldId);
    void flow.fitView({ nodes: [{ id: hit.entityId }], padding: 0.4, duration: 200, maxZoom: 1 });
    setQuery('');
  };

  return (
    <div className="relative w-64">
      <Search
        className="pointer-events-none absolute top-2 left-2 size-3.5 text-text-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        role="combobox"
        aria-label={`Search ${t.term('entity').other.toLowerCase()}, ${t.term('field').other.toLowerCase()} and docs`}
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        placeholder="Search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter') {
            const hit = hits[active];
            if (hit !== undefined) pick(hit);
          } else if (e.key === 'Escape') setQuery('');
          else return;
          e.preventDefault();
        }}
        className="h-8 w-full rounded-md border border-border bg-surface pr-2 pl-7 text-xs text-text shadow-panel placeholder:text-text-subtle"
      />
      {hits.length === 0 ? null : (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded-md border border-border bg-surface-raised p-1 text-xs shadow-panel"
        >
          {hits.map((hit, i) => (
            <li
              key={`${hit.entityId}:${hit.fieldId ?? ''}`}
              role="option"
              aria-selected={i === active}
            >
              <button
                type="button"
                className={cn(
                  'w-full rounded px-2 py-1 text-left',
                  i === active && 'bg-surface-hover',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(hit);
                }}
              >
                <span className="font-mono text-text">{hit.label}</span>
                {hit.snippet === null ? null : (
                  <span className="block truncate text-text-muted">{hit.snippet}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
