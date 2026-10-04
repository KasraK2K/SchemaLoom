import type { EngineProps } from '@schemaloom/engine-sdk';

/** Byte comparison, NOT `localeCompare`: the output must not depend on the server's locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function propString(props: EngineProps, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
