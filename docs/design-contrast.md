# Design token contrast

Checked with `docs/antislop/skills/antislop-human/contrast-check.py`. Normal text needs 4.5:1, large text 3:1. Every pair below passes both.

| Text on background | Light | Dark |
|---|---|---|
| `--ink` on `--bg` | 15.99:1 | 15.03:1 |
| `--ink` on `--surface` | 16.95:1 | 13.58:1 |
| `--ink-muted` on `--bg` | 6.97:1 | 8.00:1 |
| `--ink-muted` on `--surface` | 7.39:1 | 7.23:1 |
| `--accent-ink` on `--accent` | 5.30:1 | 5.96:1 |
| `--accent` on `--bg` (links, focus ring) | 4.99:1 | 5.96:1 |
| `--accent` on `--surface` | 5.30:1 | 5.39:1 |
| `--error` on `--bg` | 7.03:1 | 7.22:1 |
| `--error` on `--surface` | 7.46:1 | 6.52:1 |
| `--success` on `--bg` | 7.09:1 | 8.84:1 |
| `--success` on `--surface` | 7.52:1 | 7.99:1 |

`--border` is a separator, not text, so it is not in the table. The toggle button uses `--ink` on `--bg`.
