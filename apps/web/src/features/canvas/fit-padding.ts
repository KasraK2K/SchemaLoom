import type { FitViewOptions } from '@xyflow/react';

/**
 * How much room "fit to view" leaves around the diagram. Float's panels float over the
 * canvas (bar on top, dock on the left, inspector on the right), so a fit there keeps
 * the tables clear of them; every other theme docks its panels beside the canvas.
 * Read from <html> at call time: the theme attribute is set before the first paint.
 */
export function fitPadding(extra = 0.2): NonNullable<FitViewOptions['padding']> {
  if (typeof document === 'undefined' || document.documentElement.dataset.theme !== 'float') {
    return extra;
  }
  return { top: '96px', left: '100px', right: '420px', bottom: '90px' };
}
