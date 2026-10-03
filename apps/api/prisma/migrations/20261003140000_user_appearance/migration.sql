-- Appearance themes: the user's theme and colour variant. The mode (light/dark/system) is
-- the existing `theme` column. Plain text, validated by @schemaloom/contracts' appearance
-- schema; an unknown value reads back as the default.
ALTER TABLE users ADD COLUMN ui_theme TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE users ADD COLUMN ui_variant TEXT NOT NULL DEFAULT 'jade';
