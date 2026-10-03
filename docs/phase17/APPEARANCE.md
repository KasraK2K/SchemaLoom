# Roadmap 17: Appearance themes

Status: **built** 2026-10-03. The owner approved the plan (four themes, the choice saved to
the account, no org default yet) and the mockup the same day. Amended the same day at the
owner's request: the themes were too alike, so each now differs in type, corners, cards,
links and canvas, a colour also changes the greys, and a click applies at once. A hover
preview was tried and removed: themes resize the shell, so the panel jumped under the
pointer and re-rendered in a loop.

## What a user gets

The **appearance button** in the top bar (the icon shows the mode) opens a panel docked on
the right, with no backdrop, so the page shows the result. A click on a theme, a colour or a
mode applies and saves it; there is no Apply step. A theme is a working style, not a palette:

| Theme         | Feels like       | Type                                                  | Corners and controls                    | Table cards                              | Links          | Canvas                                               |
| ------------- | ---------------- | ----------------------------------------------------- | --------------------------------------- | ---------------------------------------- | -------------- | ---------------------------------------------------- |
| **Studio**    | Balanced         | Geist                                                 | Soft, segmented tabs                    | Filled, area-tinted header               | Curves         | Dots                                                 |
| **Blueprint** | A drafting table | IBM Plex; mono capitals on buttons, tabs, table names | Square, outlined quiet buttons          | Outline on the paper, double-rule header | Right angles   | Minor and major ruled grid, blue paper in both modes |
| **Float**     | An airy studio   | Geist at a 17px root                                  | Pills, 16px cards, floating glass shell | Borderless, shadowed, tinted header      | Thicker curves | No grid: a soft wash of the accent                   |
| **Compact**   | A terminal       | Geist Mono everywhere, 13px root                      | Square, bracketed text tabs             | Striped rows, no header fill, capitals   | Straight       | Plain                                                |

Colour also moves the greys: Studio swaps its neutral scale (sage with Jade, slate with
Cobalt, sand with Amber, mauve with Rose); the other themes mix a few percent of the accent
into canvas, sunken, hover and border greys.

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
- **Tests.** The contract's spec, the auth route table, and e2e workflow 16 (a click picks,
  hovering changes nothing, see it applied, find it on the account and in a fresh
  browser; a wrong variant is a 400).

## Later

- An organisation default for new members (owner's call, not built).
- Float with very narrow windows: below `lg` the inspector is hidden as in every theme, and
  the dock and bar still float.
