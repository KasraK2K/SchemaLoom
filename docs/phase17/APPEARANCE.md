# Roadmap 17: Appearance themes

Status: **built** 2026-10-03. The owner approved the plan (four themes, the choice saved to
the account, no org default yet) and the mockup the same day.

## What a user gets

The **appearance button** in the top bar (the icon shows the mode) picks a theme, one of its colour variants, and the mode
(light, dark, system). A theme is a working style, not a palette:

| Theme         | Panels and canvas                                                                 | Type                    | Variants                  |
| ------------- | --------------------------------------------------------------------------------- | ----------------------- | ------------------------- |
| **Studio**    | Docked panels, 10px cards with area-tinted headers, dotted canvas                 | Geist                   | Jade, Cobalt, Amber, Rose |
| **Blueprint** | Sharp 2px corners, hairlines and no shadows, ruled canvas, spec-box table headers | IBM Plex Sans and Mono  | Blue, Graphite, Olive     |
| **Float**     | The bar, an icon dock and the inspector float, frosted, over a full-bleed canvas  | Geist                   | Mist, Dusk, Moss          |
| **Compact**   | Shorter bar, icon rail, denser rows (root size 14px), flat, no canvas grid        | Geist, mono column data | Phosphor, Amber, Ice      |

Behaviour, routes and permissions are the same in every theme.

## How it is built

- **Contract.** `@schemaloom/contracts` `appearance.ts`: the theme ids, each theme's variants
  (the first is its default), and the schema that refuses another theme's variant.
- **API.** `users.ui_theme` and `users.ui_variant`; the mode is the existing `users.theme`.
  `GET /auth/me` returns `appearance`, `PUT /auth/me/appearance` saves it.
- **Before paint.** The inline script in `layout.tsx` sets `.light`/`.dark`,
  `data-theme` and `data-variant` on `<html>` from local storage, validated against the
  contract's table. `ThemeProvider` then adopts the account's choice (a plain fetch, so a
  signed-out page never redirects) and saves changes only for a signed-in user.
- **Tokens.** `packages/config/tailwind/themes.css` overrides `theme.css`'s semantic tokens
  per theme and mode (surfaces, text, borders, shadows, area tints, radius scale, fonts,
  density) and the accent tokens per variant. Every combination passes AA for text on its
  surface, accent text on its tint, and text on an accent fill.
- **Structure.** Custom Tailwind variants (`theme-float:`, `theme-blueprint:`…) for what a
  token cannot express: Float's floating shell, the rail sidebar, Blueprint's tabs and card
  headers, the canvas grid (two `Background`s, one hidden per theme) and Float's
  fit-to-view padding. CSS, not React state, so the first paint is already right.
- **Fonts.** IBM Plex comes from `@fontsource`; a face downloads only when text uses it.
- **Tests.** The contract's spec, the auth route table, and e2e workflow 16 (pick a theme,
  see it applied, find it on the account and in a fresh browser; a wrong variant is a 400).

## Later

- An organisation default for new members (owner's call, not built).
- Float with very narrow windows: below `lg` the inspector is hidden as in every theme, and
  the dock and bar still float.
