/**
 * "when it was last touched", as words.
 *
 * `now` is a parameter, not a call to `Date.now()` inside the loop, so the formatting is
 * deterministic and testable — the alternative is a test that passes until it is run at
 * a month boundary.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder of thresholds: it is in the
 * runtime already and it gets "last month" vs "1 month ago" right.
 */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const delta = then - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return FORMATTER.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}
