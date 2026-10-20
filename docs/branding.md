# Workspace branding

Team workspaces can set one accent colour (`workspaces.brand_accent`, `PATCH /api/workspaces/active/branding`).

- The owner picks one colour. The light theme uses it as is; the dark theme uses `darkAccent` (the same hue lightened until it passes).
- `checkAccentContrast` (lib/brand-accent.ts) needs 4.5:1 for text on the accent, and for the accent on `--bg` and `--surface`, in both themes. A failing colour is rejected with a message naming the worst pair.
- Removing the colour (`{accent: null}`) never needs the plan.
- The colour is applied to the join page, the participant page, the survey link and the presenter screen (`BrandStyle`, `data-brand`, lib/brand-style.ts). It only sets `--accent`, `--accent-ink` and `--focus`; the dashboard keeps the default accent. A downgrade stops applying it without clearing it (`workspaceAccent` checks `limits.branding` on every read).
- Owners and admins set it on `/dashboard/settings` (preview in both themes, contrast table, Apply, Remove).

## TODO: logo upload

The logo upload is not built. It waits for image storage (milestones M5 and M6, which this run does not build). When images exist, add the logo next to the accent: same image rules as the content images, shown on the participant and presenter screens, gated by `limits.branding`.
