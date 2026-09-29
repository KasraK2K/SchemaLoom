import { toBlob, toSvg } from 'html-to-image';
import { IMAGE_CONTENT_TYPES, type ImageFormat } from './exports-api';

/** Space around the outermost card, in flow pixels. */
const PADDING = 32;

export interface FlowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The whole diagram's extent, from the DOM React Flow already rendered. The export menu
 * sits in the top bar, outside `ReactFlowProvider`, so it cannot call `getNodesBounds`;
 * each node wrapper's transform IS its flow position, and `offsetWidth` is unscaled.
 */
export function flowBounds(nodes: readonly FlowBounds[]): FlowBounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function nodeBox(el: HTMLElement): FlowBounds {
  const transform = getComputedStyle(el).transform;
  const m = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
  return { x: m.m41, y: m.m42, width: el.offsetWidth, height: el.offsetHeight };
}

/**
 * Render the open canvas at 1:1, whole diagram, and return it as a Blob of the format's
 * type. What is drawn is what the browser already holds: the redacted view.
 *
 * ponytail: `pixelRatio: 1` and no tiling, so a diagram past the browser's canvas limit
 * (~16k px a side) fails to render as PNG. Scale down or tile if that turns up.
 */
export async function renderCanvasImage(format: ImageFormat): Promise<Blob> {
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (viewport === null) throw new Error('Open the canvas to export an image.');
  const bounds = flowBounds([...viewport.querySelectorAll<HTMLElement>('.react-flow__node')].map(nodeBox));
  if (bounds === null) throw new Error('There is nothing on the canvas to export.');

  const width = Math.ceil(bounds.width + PADDING * 2);
  const height = Math.ceil(bounds.height + PADDING * 2);
  const options = {
    width,
    height,
    pixelRatio: 1,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    style: {
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      transform: `translate(${String(PADDING - bounds.x)}px, ${String(PADDING - bounds.y)}px) scale(1)`,
    },
  };

  if (format === 'png') {
    const blob = await toBlob(viewport, options);
    if (blob === null) throw new Error('The image could not be rendered.');
    return blob;
  }
  const dataUrl = await toSvg(viewport, options);
  const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return new Blob([svg], { type: IMAGE_CONTENT_TYPES.svg });
}
