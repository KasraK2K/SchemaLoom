import type { LinkStyle } from '@/engines';

/**
 * Crow's-foot notation (§6.1), as SVG markers.
 *
 * WHICH marker goes on which end is the ENGINE's call: `EngineUiPlugin.linkStyles` maps a
 * link kind to a `LinkStyle`, and the contract is explicit that this is "appearance only,
 * which is the half core genuinely cannot derive". Core owns the glyphs; the engine owns
 * the assignment.
 *
 * `orient="auto-start-reverse"` is why there is ONE set and not a start set plus a
 * mirrored end set: at the start of a path the marker is rotated 180°, so a foot drawn
 * opening toward +x opens toward its own node at either end, which is what the notation
 * means.
 *
 * `context-stroke` makes a marker take the colour of the path that references it, so a
 * selected or restricted edge does not end in a marker of the wrong colour. A browser
 * without it falls back to black, which is legible rather than invisible.
 */
export type MarkerKind = LinkStyle['sourceMarker'];

const MARKER_IDS: Readonly<Record<Exclude<MarkerKind, 'none'>, string>> = {
  one: 'sl-crow-one',
  many: 'sl-crow-many',
  arrow: 'sl-crow-arrow',
};

export function markerUrl(marker: MarkerKind | undefined): string | undefined {
  if (marker === undefined || marker === 'none') return undefined;
  return `url(#${MARKER_IDS[marker]})`;
}

/** Rendered once per canvas. Markers are looked up by id in the document, so they only
 *  have to exist somewhere — a zero-size svg keeps them out of the layout. */
export function CrowFootDefs() {
  return (
    <svg aria-hidden="true" className="absolute size-0" focusable="false">
      <defs>
        <marker
          id={MARKER_IDS.one}
          viewBox="0 0 12 12"
          markerWidth={12}
          markerHeight={12}
          refX={11}
          refY={6}
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M6 1 L6 11" fill="none" stroke="context-stroke" strokeWidth={1.5} />
        </marker>

        <marker
          id={MARKER_IDS.many}
          viewBox="0 0 12 12"
          markerWidth={12}
          markerHeight={12}
          refX={12}
          refY={6}
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          {/* Apex away from the card, the three toes opening onto it. */}
          <path
            d="M0 6 L12 1 M0 6 L12 6 M0 6 L12 11"
            fill="none"
            stroke="context-stroke"
            strokeWidth={1.5}
          />
        </marker>

        <marker
          id={MARKER_IDS.arrow}
          viewBox="0 0 12 12"
          markerWidth={10}
          markerHeight={10}
          refX={11}
          refY={6}
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M1 2 L11 6 L1 10 z" fill="context-stroke" stroke="none" />
        </marker>
      </defs>
    </svg>
  );
}
