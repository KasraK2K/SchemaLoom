import { Button, FilePlus2, Sparkles, Upload } from '@schemaloom/ui';

const STARTING_POINTS = [
  {
    id: 'blank',
    icon: FilePlus2,
    title: 'Start blank',
    body: 'Drop a first table on the canvas and grow the schema by hand.',
    action: 'New table',
  },
  {
    id: 'import',
    icon: Upload,
    title: 'Import SQL or Prisma',
    body: 'Paste a SQL dump, a migration or a schema.prisma, or load a template. Every object keeps its engine properties.',
    action: 'Import',
  },
  {
    id: 'describe',
    icon: Sparkles,
    title: 'Describe your app',
    body: 'Say what you are building and let AI draft a first schema for you to edit.',
    action: 'Describe',
  },
] as const;

/**
 * The centre pane until the canvas lands (build-order steps 23-24). It is a teaching
 * empty state, not a placeholder: a blank canvas tells a new user nothing about which
 * of the three ways in exists.
 *
 * A card whose handler is absent stays `disabled` rather than disappearing, so the shape
 * of the screen does not change for a caller who cannot import.
 */
export function CanvasEmptyState({
  onNewEntity,
  onImport,
  onDescribe,
}: {
  onNewEntity?: () => void;
  onImport?: () => void;
  /** Phase 12: opens the import dialog on its Describe box */
  onDescribe?: () => void;
}) {
  const handlers: Record<string, (() => void) | undefined> = {
    blank: onNewEntity,
    import: onImport,
    describe: onDescribe,
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-text">This project is empty</h1>
        <p className="mt-1 text-sm text-text-muted">
          Three ways to begin. You can mix them later — importing does not overwrite what you have
          drawn.
        </p>
      </div>

      <ul className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
        {STARTING_POINTS.map((point) => (
          <li
            key={point.title}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-panel"
          >
            <point.icon className="size-5 text-accent-text" aria-hidden="true" />
            <h2 className="text-sm font-medium text-text">{point.title}</h2>
            <p className="text-sm text-text-muted">{point.body}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-auto self-start"
              disabled={handlers[point.id] === undefined}
              onClick={handlers[point.id]}
            >
              {point.action}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
