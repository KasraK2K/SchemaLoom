import { APPEARANCE_THEMES, type AppearanceTheme } from '@schemaloom/contracts';

/**
 * What the Appearance dialog says and shows about each theme. The ids and the variant
 * lists are the contract's (`APPEARANCE_THEMES`); this adds words and swatch colours.
 * Swatches are each variant's dark-mode accent, the colour people recognise it by.
 */
export interface ThemeInfo {
  readonly label: string;
  readonly summary: string;
  readonly variants: Readonly<Record<string, { readonly label: string; readonly swatch: string }>>;
}

export const THEME_INFO: Readonly<Record<AppearanceTheme, ThemeInfo>> = {
  studio: {
    label: 'Studio',
    summary: 'Balanced and soft, docked panels',
    variants: {
      jade: { label: 'Jade', swatch: '#29a383' },
      cobalt: { label: 'Cobalt', swatch: '#3b9eff' },
      amber: { label: 'Amber', swatch: '#ffc53d' },
      rose: { label: 'Rose', swatch: '#e93d82' },
    },
  },
  blueprint: {
    label: 'Blueprint',
    summary: 'A drafting table: ruled, sharp, outlined',
    variants: {
      blue: { label: 'Blue', swatch: '#5aa9ff' },
      graphite: { label: 'Graphite', swatch: '#c2cfdd' },
      olive: { label: 'Olive', swatch: '#a9c25a' },
    },
  },
  float: {
    label: 'Float',
    summary: 'Airy glass panels over the canvas',
    variants: {
      mist: { label: 'Mist', swatch: '#3fa3d6' },
      dusk: { label: 'Dusk', swatch: '#f0806f' },
      moss: { label: 'Moss', swatch: '#8cc06e' },
    },
  },
  compact: {
    label: 'Compact',
    summary: 'Dense and monospace, like a terminal',
    variants: {
      phosphor: { label: 'Phosphor', swatch: '#3ddc84' },
      amber: { label: 'Amber', swatch: '#f2b544' },
      ice: { label: 'Ice', swatch: '#7fd4f5' },
    },
  },
};

/** The contract's order: the first variant is a theme's default. */
export const variantsOf = (theme: AppearanceTheme): readonly string[] => APPEARANCE_THEMES[theme];
