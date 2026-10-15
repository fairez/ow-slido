# OW Slido — project notes for agents

- Product spec: `tasks/prd-slido-clone.md` (MVP). Stories live in `scripts/ralph/prd.json`; progress log is `scripts/ralph/progress.txt`.
- Stack: Next.js (App Router) + TypeScript, PostgreSQL, Socket.IO via a custom server. Node 22.
- Environment: Postgres 16 on localhost. Dev DB `ow_slido`, test DB `ow_slido_test`, credentials in `.env.local` (gitignored, never commit or print it). Do not touch other databases on this Postgres server.
- Redis and Docker are NOT installed. Use in-memory adapters behind interfaces (rate limiter, pub/sub); do not try to install system packages.
- Use only the npm registry for dependencies; no global installs.
- Run `npm run lint`, `typecheck`, `test` before every commit.
