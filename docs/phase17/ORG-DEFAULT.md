# Phase 17b: an org default appearance

Status: **built 2026-10-05**. Roadmap row 17b. Builds on `APPEARANCE.md` (four themes,
saved per account).

An owner wants everyone joining the team to start on the same look, for example Blueprint
Graphite, without telling each new person where the setting is.

## 0. The decisions

| #   | Question         | Decision                                                                                                                                                         |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What it sets     | **A starting theme, variant and mode for new accounts.** It's a default, not a lock; people still change their own.                                              |
| D2  | When it applies  | **Once, when an account is created through the org**: invite sign-up, SSO JIT and SCIM (row 14b). An existing account that joins another org keeps its own look. |
| D3  | Existing members | **Not changed.** There is no "apply to everyone"; it would overwrite choices people made.                                                                        |
| D4  | Who sets it      | **Owners and admins**, like other org administration.                                                                                                            |

## 1. What the user sees

- Settings → a new **General** page (the org settings nav has none yet) with **Appearance for
  new members**: the same theme cards and variant swatches as the personal picker, plus mode
  (System, Light, Dark) and **None** (new people start on Studio Jade, as today).
- A new member's first screen is already in the org's look, with nothing flashing first,
  because the account row holds it before the first `/auth/me`.
- The personal Appearance menu is unchanged.

## 2. Data and code

- **Storage:** `Organization.settings` (JSON, existing) gains
  `defaultAppearance: { theme, variant, mode } | null`, validated by `appearanceInputSchema`
  (which already rejects another theme's variant). There's no migration.
- **Applying it:** one helper, `applyOrgAppearance(tx, userId, orgId)`, copies the default into
  `User.uiTheme`, `uiVariant` and `theme`. It's called inside the transaction callback that
  every `SignupPolicy.createUser` caller already passes, where the new account gets its first
  org membership: invite acceptance (`auth.service.ts`), SSO JIT (`sso.service.ts:324`) and
  SCIM (row 14b). An open-mode sign-up with no org gets nothing.
- **Route:** `PATCH /organizations/:orgSlug/settings` (`@Authenticated`, owner or admin
  checked in the service, like the other org routes). It's the first writer of
  `Organization.settings`, so it adds the missing `orgSettingsSchema` to `packages/contracts`
  (`allowGuestInvites`, `defaultAppearance`), takes a partial and validates the merged result. Audited `org.settings_changed`.
- **Web:** `features/org-settings/general-settings.tsx`, which reuses the picker from the
  personal Appearance menu.

## 3. Tests

- Unit: settings merge (a partial patch keeps `allowGuestInvites`), bad variant refused.
- Api integration: an invite sign-up, an SSO JIT user and a SCIM user start on the default;
  an existing user accepting an invite keeps theirs; a member gets 404 on the route.
- Routes spec; E2E (workflow 16): set Blueprint Graphite, sign up through an invite, and see
  `data-theme="blueprint"` on the first page.

## 4. Open questions (defaults are the recommendation)

| #   | Question                         | Default                                              |
| --- | -------------------------------- | ---------------------------------------------------- |
| Q1  | Include the mode (light/dark)?   | **Yes**, with System as the usual choice.            |
| Q2  | Admins or owners only?           | **Owners and admins** (D4).                          |
| Q3  | Lock the look for the whole org? | **No.** Appearance is personal; it's a default only. |

## 5. As built

- **Invite sign-up applies at account creation, not at accept.** The membership row is made later,
  in `InvitationsService.accept`, so `register` resolves the org from the invite token inside the
  `createUser` transaction. A person who signs up by magic link or OAuth and only then accepts an
  invite is an existing account and keeps Studio Jade. Accepting never touches appearance.
- **SCIM is not wired yet.** Row 14b is `proposed`; its create path must call
  `applyOrgAppearance(tx, userId, orgId)` and add the §3 SCIM test when it lands.
- **A `GET /organizations/:orgSlug/settings` route was added** (owner or admin) because the General
  page has to read the current value. A plain member gets 404 on both routes, as §3 asks.
- The picker moved out of the personal Appearance panel into `components/appearance-picker.tsx`;
  the panel and Settings → General both use it.
