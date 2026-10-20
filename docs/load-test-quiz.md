# Quiz load test

Run on 2026-10-20 with `scripts/load/quiz.mjs`.

- Machine: Intel(R) Xeon(R) Gold 6231C CPU @ 3.20GHz, 2 vCPU, 1.9 GiB RAM, Linux 6.8.0-124-generic, Node v22.23.2. The app server, PostgreSQL and the 500 simulated clients all ran on this one machine.
- Server: production build (`next build`, `NODE_ENV=production tsx server.ts`) against the test database.
- Load: 500 participants, each with a nickname and a Socket.IO connection; 3 questions of 20 s, one answer per participant spread randomly over 6 s.
- Each simulated phone sends its own `x-real-ip`, because join is limited to 300 per minute per address.

## What is measured

The clock starts when the last answer of a question is acknowledged. The host closes the question right then (the
worst case: nothing is waiting for the timer). The leaderboard is updated when the question closes, so the figures
include the close itself:

- **Presenter**: from the last answer to the presenter state with the top 10 (`GET /present`, fetched after the `closed` message).
- **Phones**: from the last answer to each participant holding their own rank (the `quiz:outcome` message pushed after the `closed` message; `GET quiz-result` if none arrives within 3 s). p50 and p95 are over all participants of the question.

## Result

| Question | Presenter | Phones p50 | Phones p95 | Phones max |
| --- | --- | --- | --- | --- |
| 1 | 113 ms | 92 ms | 102 ms | 103 ms |
| 2 | 88 ms | 71 ms | 78 ms | 78 ms |
| 3 | 94 ms | 72 ms | 80 ms | 82 ms |

Presenter, worst question: 113 ms. Phones, all 1500 samples: p50 75 ms, p95 98 ms.
Target: p95 under 1000 ms. **Met.**

## What the first run showed

Before the fix the same load missed the target: the presenter had the top 10 after 1.4 to 1.9 s and the phones' p95 was
1.8 s. The close itself took about 250 ms; the rest was 500 phones each fetching `quiz-result` at the same moment,
which keeps the single Node process busy (500 plain requests to `/api/health` take about 1 s on this machine) and
delays the presenter's request too. Two changes:

- The server pushes every participant their own result as a `quiz:outcome` message to their personal Socket.IO room when
  the question closes (`publishQuizOutcomes`), built from one read of the answers and the ranking in the store. The phone
  asks `quiz-result` only if nothing arrives within 3 s.
- `MemoryLeaderboardStore` sorts an event once after a change and keeps the ranking (with a participant index) until the
  next change, so `rankOf` no longer sorts the whole event per call.

## Run it again

```
NEXT_DIST_DIR=.next-load npx next build
NEXT_DIST_DIR=.next-load PORT=3300 NODE_ENV=production DATABASE_URL="$TEST_DATABASE_URL" AI_PROVIDER=mock BILLING_PROVIDER=mock npx tsx server.ts
node scripts/load/quiz.mjs --base http://localhost:3300 --participants 500 --rounds 3 --out docs/load-test-quiz.md
```
