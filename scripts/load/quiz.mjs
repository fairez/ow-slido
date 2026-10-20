// Load test for the quiz leaderboard: joins many simulated participants, runs timed questions and
// measures how long after the last answer the leaderboard shows up on the presenter and on every phone.
//
//   NEXT_DIST_DIR=.next-load PORT=3300 NODE_ENV=production DATABASE_URL=$TEST_DATABASE_URL \
//     npx tsx server.ts          (after `NEXT_DIST_DIR=.next-load npx next build`)
//   node scripts/load/quiz.mjs --base http://localhost:3300 --participants 500 --rounds 3 --out docs/load-test-quiz.md
//
// The server must run against the test database: the script marks its own host as verified and puts the
// workspace on Pro there, and stops if it cannot find that host in TEST_DATABASE_URL.
import { writeFileSync } from "node:fs";
import os from "node:os";
import { config } from "dotenv";
import pg from "pg";
import { io } from "socket.io-client";

config({ path: ".env.local" });

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const BASE = argOf("base", "http://localhost:3300").replace(/\/$/, "");
const PARTICIPANTS = Number(argOf("participants", "500"));
const ROUNDS = Number(argOf("rounds", "3"));
const TIME_LIMIT = Number(argOf("time-limit", "20"));
const ANSWER_SPREAD_MS = Number(argOf("spread-ms", "6000"));
const OUT = argOf("out", "");
const TARGET_P95_MS = 1000;
const FALLBACK_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

/** Each simulated phone gets its own address: the app's per-IP limits assume one device per address. */
const fakeIp = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

function cookiesOf(response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function call(method, path, { cookie = "", body, ip = "10.255.0.1" } = {}) {
  const headers = { "x-real-ip": ip };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: leave it null and let the caller look at the status.
  }
  return { status: response.status, json, response };
}

async function expectOk(promise, what) {
  const result = await promise;
  if (result.status >= 400) throw new Error(`${what} failed with ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : "n/a");

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? NaN };
}

async function withTestDb(fn) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.local)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setUpHost() {
  const email = `load-${Date.now()}@example.com`;
  const signup = await expectOk(
    call("POST", "/api/auth/signup", { body: { email, password: "load-test-password-1" } }),
    "host signup",
  );
  const cookie = cookiesOf(signup.response);
  await withTestDb(async (db) => {
    const verified = await db.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);
    if (verified.rowCount !== 1) {
      throw new Error("The host is not in TEST_DATABASE_URL: start the server against the test database.");
    }
    await db.query(
      `INSERT INTO subscriptions (workspace_id, plan_override, plan_override_reason)
       SELECT m.workspace_id, 'pro', 'load test' FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1
       ON CONFLICT (workspace_id) DO UPDATE SET plan_override = 'pro', plan_override_reason = 'load test'`,
      [email],
    );
  });
  return { email, cookie };
}

function connectSocket(eventId, role, cookie) {
  return io(BASE, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { eventId, role },
    extraHeaders: { cookie },
    reconnection: false,
  });
}

function whenConnected(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", (error) => reject(new Error(`socket: ${error.message}`)));
  });
}

async function main() {
  console.log(`Quiz load test: ${PARTICIPANTS} participants, ${ROUNDS} questions, ${BASE}`);
  const host = await setUpHost();

  const eventResult = await expectOk(
    call("POST", "/api/events", {
      cookie: host.cookie,
      body: { name: "Load test", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" },
    }),
    "create event",
  );
  const event = eventResult.json.event;

  const questions = [];
  for (let r = 0; r < ROUNDS; r++) {
    const created = await expectOk(
      call("POST", `/api/events/${event.id}/interactions`, {
        cookie: host.cookie,
        body: {
          type: "quiz",
          prompt: `Question ${r + 1}`,
          options: ["a", "b", "c", "d"].map((id) => ({ id, text: `Option ${id}` })),
          correctOptionIds: ["a"],
          timeLimitSeconds: TIME_LIMIT,
          points: 1000,
        },
      }),
      "create question",
    );
    questions.push(created.json.interaction.id);
  }

  // Join, pick a nickname, open a socket: one simulated phone each.
  const joinStarted = now();
  const phones = await pool(Array.from({ length: PARTICIPANTS }, (_, i) => i), 50, async (i) => {
    const ip = fakeIp(i);
    const joined = await expectOk(call("POST", "/api/join", { ip, body: { code: event.joinCode } }), "join");
    const cookie = cookiesOf(joined.response);
    await expectOk(call("PUT", `/api/events/${event.id}/nickname`, { cookie, ip, body: { nickname: `Player ${i + 1}` } }), "nickname");
    const socket = connectSocket(event.id, "participant", cookie);
    await whenConnected(socket);
    return { i, ip, cookie, socket, closedAt: null };
  });
  const hostSocket = connectSocket(event.id, "host", host.cookie);
  await whenConnected(hostSocket);
  console.log(`Joined ${phones.length} participants in ${ms(now() - joinStarted)}`);

  const rounds = [];
  const allPhoneTimes = [];
  for (let r = 0; r < ROUNDS; r++) {
    const interactionId = questions[r];
    const liveSeen = phones.map(
      (p) =>
        new Promise((resolve) => {
          const handler = (message) => {
            if (message.interactionId === interactionId && message.state === "live") {
              p.socket.off("state-changed", handler);
              resolve();
            }
          };
          p.socket.on("state-changed", handler);
        }),
    );
    await expectOk(call("POST", `/api/events/${event.id}/interactions/${interactionId}/start`, { cookie: host.cookie }), "start");
    await Promise.all(liveSeen);

    // Answers arrive spread over a few seconds, like a room tapping at different speeds.
    let lastAckAt = 0;
    await pool(phones, PARTICIPANTS, async (p) => {
      await sleep(Math.random() * ANSWER_SPREAD_MS);
      const optionIds = [["a", "b", "c", "d"][Math.floor(Math.random() * 4)]];
      await expectOk(
        call("POST", `/api/interactions/${interactionId}/quiz-answer`, { cookie: p.cookie, ip: p.ip, body: { optionIds } }),
        "answer",
      );
      lastAckAt = Math.max(lastAckAt, now());
    });

    // The host closes the question the moment the last answer is in: the worst case for the leaderboard.
    const presenterSeen = new Promise((resolve) => {
      hostSocket.on("state-changed", function handler(message) {
        if (message.interactionId === interactionId && message.state === "closed") {
          hostSocket.off("state-changed", handler);
          resolve();
        }
      });
    });
    const phoneTimes = [];
    let fallbacks = 0;
    const phoneDone = phones.map(
      (p) =>
        new Promise((resolve, reject) => {
          const finish = (standing) => {
            if (!standing) return reject(new Error("quiz result has no standing"));
            if (standing.players !== PARTICIPANTS) {
              return reject(new Error(`standing counts ${standing.players} players, expected ${PARTICIPANTS}`));
            }
            phoneTimes.push(now() - lastAckAt);
            resolve();
          };
          // Like the participant screen: the server pushes the result; asking for it is the fallback.
          const timer = setTimeout(async () => {
            p.socket.off("quiz:outcome", onOutcome);
            try {
              const result = await expectOk(
                call("GET", `/api/interactions/${interactionId}/quiz-result`, { cookie: p.cookie, ip: p.ip }),
                "quiz-result",
              );
              fallbacks++;
              finish(result.json.standing);
            } catch (error) {
              reject(error);
            }
          }, FALLBACK_MS);
          function onOutcome(message) {
            if (message.interactionId !== interactionId) return;
            clearTimeout(timer);
            p.socket.off("quiz:outcome", onOutcome);
            finish(message.outcome.standing);
          }
          p.socket.on("quiz:outcome", onOutcome);
        }),
    );
    let messageAt = 0;
    presenterSeen.then(() => (messageAt = now()));
    await expectOk(call("POST", `/api/events/${event.id}/interactions/${interactionId}/close`, { cookie: host.cookie }), "close");
    const closeDoneAt = now();
    await presenterSeen;
    const presenter = await expectOk(
      call("GET", `/api/events/${event.id}/present?closed=${interactionId}`, { cookie: host.cookie }),
      "presenter state",
    );
    const presenterMs = now() - lastAckAt;
    console.log(`  breakdown: close request ${ms(closeDoneAt - lastAckAt)}, closed message at host ${ms(messageAt - lastAckAt)}`);
    const top = presenter.json.interaction?.leaderboard;
    if (!Array.isArray(top) || top.length === 0) throw new Error("presenter state has no leaderboard");
    await Promise.all(phoneDone);

    const phoneStats = summarize(phoneTimes);
    rounds.push({ round: r + 1, presenterMs, phone: phoneStats });
    allPhoneTimes.push(...phoneTimes);
    console.log(
      `Question ${r + 1}: presenter ${ms(presenterMs)}, phones p50 ${ms(phoneStats.p50)} p95 ${ms(phoneStats.p95)} max ${ms(phoneStats.max)}${fallbacks ? `, ${fallbacks} phones needed the fallback request` : ""}`,
    );
    await sleep(500);
  }

  for (const p of phones) p.socket.close();
  hostSocket.close();

  const presenterWorst = Math.max(...rounds.map((x) => x.presenterMs));
  const pooled = summarize(allPhoneTimes);
  const phoneP50 = pooled.p50;
  const phoneP95 = pooled.p95;
  const passed = presenterWorst < TARGET_P95_MS && phoneP95 < TARGET_P95_MS;
  console.log(
    `\nPresenter worst ${ms(presenterWorst)}; phones over all questions p50 ${ms(phoneP50)} p95 ${ms(phoneP95)} (target p95 < ${TARGET_P95_MS} ms): ${passed ? "PASS" : "FAIL"}`,
  );

  if (OUT) {
    writeFileSync(OUT, report({ rounds, presenterWorst, phoneP50, phoneP95, passed }));
    console.log(`Wrote ${OUT}`);
  }
  process.exit(passed ? 0 : 1);
}

function machine() {
  const cpus = os.cpus();
  return `${cpus[0]?.model ?? "unknown CPU"}, ${cpus.length} vCPU, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.type()} ${os.release()}, Node ${process.version}`;
}

function report({ rounds, presenterWorst, phoneP50, phoneP95, passed }) {
  const rows = rounds
    .map((x) => `| ${x.round} | ${ms(x.presenterMs)} | ${ms(x.phone.p50)} | ${ms(x.phone.p95)} | ${ms(x.phone.max)} |`)
    .join("\n");
  return `# Quiz load test

Run on ${new Date().toISOString().slice(0, 10)} with \`scripts/load/quiz.mjs\`.

- Machine: ${machine()}. The app server, PostgreSQL and the 500 simulated clients all ran on this one machine.
- Server: production build (\`next build\`, \`NODE_ENV=production tsx server.ts\`) against the test database.
- Load: ${PARTICIPANTS} participants, each with a nickname and a Socket.IO connection; ${rounds.length} questions of ${TIME_LIMIT} s, one answer per participant spread randomly over ${ANSWER_SPREAD_MS / 1000} s.
- Each simulated phone sends its own \`x-real-ip\`, because join is limited to 300 per minute per address.

## What is measured

The clock starts when the last answer of a question is acknowledged. The host closes the question right then (the
worst case: nothing is waiting for the timer). The leaderboard is updated when the question closes, so the figures
include the close itself:

- **Presenter**: from the last answer to the presenter state with the top 10 (\`GET /present\`, fetched after the \`closed\` message).
- **Phones**: from the last answer to each participant holding their own rank (the \`quiz:outcome\` message pushed after the \`closed\` message; \`GET quiz-result\` if none arrives within ${FALLBACK_MS / 1000} s). p50 and p95 are over all participants of the question.

## Result

| Question | Presenter | Phones p50 | Phones p95 | Phones max |
| --- | --- | --- | --- | --- |
${rows}

Presenter, worst question: ${ms(presenterWorst)}. Phones, all ${PARTICIPANTS * rounds.length} samples: p50 ${ms(phoneP50)}, p95 ${ms(phoneP95)}.
Target: p95 under ${TARGET_P95_MS} ms. **${passed ? "Met" : "Missed"}.**

## What the first run showed

Before the fix the same load missed the target: the presenter had the top 10 after 1.4 to 1.9 s and the phones' p95 was
1.8 s. The close itself took about 250 ms; the rest was 500 phones each fetching \`quiz-result\` at the same moment,
which keeps the single Node process busy (500 plain requests to \`/api/health\` take about 1 s on this machine) and
delays the presenter's request too. Two changes:

- The server pushes every participant their own result as a \`quiz:outcome\` message to their personal Socket.IO room when
  the question closes (\`publishQuizOutcomes\`), built from one read of the answers and the ranking in the store. The phone
  asks \`quiz-result\` only if nothing arrives within ${FALLBACK_MS / 1000} s.
- \`MemoryLeaderboardStore\` sorts an event once after a change and keeps the ranking (with a participant index) until the
  next change, so \`rankOf\` no longer sorts the whole event per call.

## Run it again

\`\`\`
NEXT_DIST_DIR=.next-load npx next build
NEXT_DIST_DIR=.next-load PORT=3300 NODE_ENV=production DATABASE_URL="$TEST_DATABASE_URL" AI_PROVIDER=mock BILLING_PROVIDER=mock npx tsx server.ts
node scripts/load/quiz.mjs --base http://localhost:3300 --participants 500 --rounds 3 --out docs/load-test-quiz.md
\`\`\`
`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
