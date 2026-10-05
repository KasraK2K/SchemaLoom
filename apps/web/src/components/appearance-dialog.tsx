'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@schemaloom/ui';
import { AppearancePicker } from '@/components/appearance-picker';
import { useTheme } from '@/components/theme-provider';

/**
 * Pick a theme, its colour and the mode. A click applies and saves it at once; the panel
 * docks to the right with no backdrop, so the page itself shows the result. No hover
 * preview: a theme can resize the shell (Float's dock, Compact's rail), and previewing on
 * pointer-over made the panel jump under the pointer and re-render in a loop.
 */
export function AppearanceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { look, theme, setAppearance } = useTheme();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-transparent"
        className="top-3 right-3 bottom-3 left-auto flex w-[22rem] max-w-[calc(100vw-1.5rem)] translate-x-0 translate-y-0 flex-col overflow-y-auto bg-surface-raised"
      >
        <DialogTitle>Appearance</DialogTitle>
        <DialogDescription>
          Click a theme, colour or mode to apply it. A theme changes the layout, density and type,
          not only the colour.
        </DialogDescription>

        <div className="mt-4">
          <AppearancePicker look={look} mode={theme} onChange={setAppearance} />
        </div>

        <DialogFooter className="mt-auto pt-5">
          <Button
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
