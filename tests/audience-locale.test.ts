// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events, interactions, templates, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { resolveLocaleFrom, audienceTarget, audienceLocaleCookie } from "@/lib/i18n/locale";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

// getLocale reads the request through next/headers; each test sets what the browser would send.
const jar: Record<string, string> = {};
const incoming: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { value: jar[name] } : undefined) }),
  headers: async () => new Headers(incoming),
}));

type Handler = (req: Request) => Promise<Response>;
type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let createEvent: Handler;
let patchEvent: IdHandler;
let duplicateEvent: IdHandler;
let fromTemplate: Handler;
let putLocale: Handler;
let login: Handler;
let getLocale: () => Promise<string>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  ({ POST: createEvent } = await import("@/app/api/events/route"));
  ({ PATCH: patchEvent } = await import("@/app/api/events/[id]/route"));
  ({ POST: duplicateEvent } = await import("@/app/api/events/[id]/duplicate/route"));
  ({ POST: fromTemplate } = await import("@/app/api/events/from-template/route"));
  ({ PUT: putLocale } = await import("@/app/api/auth/locale/route"));
  ({ POST: login } = await import("@/app/api/auth/login/route"));
  ({ getLocale } = await import("@/lib/i18n/server"));
});
beforeEach(async () => {
  await truncateAll(db);
  for (const key of Object.keys(jar)) delete jar[key];
  for (const key of Object.keys(incoming)) delete incoming[key];
});
afterAll(() => pool.end());

async function host(email = "host@example.com", locale?: "en" | "id") {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword("correct horse battery"), emailVerifiedAt: new Date(), locale })
    .returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${createSessionToken(user.id)}` };
}

const json = (cookie: string | undefined, body: unknown, method = "POST") =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const eventBody = (extra: Record<string, unknown> = {}) => ({
  name: "All hands",
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T12:00:00.000Z",
  ...extra,
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("resolveLocaleFrom", () => {
  it("takes the participant's choice, then the event, then the host setting, then Accept-Language, then en", () => {
    const all = { participantChoice: "id", eventAudience: "en", hostSetting: "en", acceptLanguage: "en" };
    expect(resolveLocaleFrom(all)).toBe("id");
    expect(resolveLocaleFrom({ ...all, participantChoice: undefined })).toBe("en");
    expect(resolveLocaleFrom({ eventAudience: "id", hostSetting: "en", acceptLanguage: "en" })).toBe("id");
    expect(resolveLocaleFrom({ hostSetting: "id", acceptLanguage: "en" })).toBe("id");
    expect(resolveLocaleFrom({ acceptLanguage: "fr;q=0.9,id-ID;q=0.8" })).toBe("id");
    expect(resolveLocaleFrom({})).toBe("en");
  });

  it("skips values it does not support instead of stopping at them", () => {
    expect(resolveLocaleFrom({ participantChoice: "xx", eventAudience: "id" })).toBe("id");
    expect(resolveLocaleFrom({ participantChoice: "", eventAudience: null, hostSetting: "fr", acceptLanguage: "id" })).toBe("id");
  });
});

describe("audienceTarget", () => {
  it("recognises the four audience pages and nothing else", () => {
    expect(audienceTarget("/join/123456")).toEqual({ kind: "join", key: "123456" });
    expect(audienceTarget("/e/abc")).toEqual({ kind: "event", key: "abc" });
    expect(audienceTarget("/present/abc")).toEqual({ kind: "present", key: "abc" });
    expect(audienceTarget("/survey/abc")).toEqual({ kind: "survey", key: "abc" });
    expect(audienceTarget("/dashboard/events/abc")).toBeNull();
    expect(audienceTarget("/events/abc")).toBeNull();
    expect(audienceTarget("/e/%E0%A4%A")).toBeNull();
  });
});

describe("event audience language", () => {
  it("defaults to English and stores a chosen language", async () => {
    const h = await host();
    const plain = (await (await createEvent(json(h.cookie, eventBody()))).json()).event;
    expect(plain.audienceLocale).toBe("en");
    const res = await createEvent(json(h.cookie, eventBody({ audienceLocale: "id" })));
    expect(res.status).toBe(201);
    expect((await res.json()).event.audienceLocale).toBe("id");
  });

  it("rejects an unknown language and keeps the stored one on a PATCH that omits it", async () => {
    const h = await host();
    expect((await createEvent(json(h.cookie, eventBody({ audienceLocale: "fr" })))).status).toBe(400);
    expect((await createEvent(json(h.cookie, eventBody({ audienceLocale: "ID-id" })))).status).toBe(400);

    const { event } = await (await createEvent(json(h.cookie, eventBody({ audienceLocale: "id" })))).json();
    expect((await patchEvent(json(h.cookie, { audienceLocale: "de" }, "PATCH"), ctx(event.id))).status).toBe(400);
    const renamed = await patchEvent(json(h.cookie, { name: "Renamed" }, "PATCH"), ctx(event.id));
    expect((await renamed.json()).event.audienceLocale).toBe("id");
    const switched = await patchEvent(json(h.cookie, { audienceLocale: "en" }, "PATCH"), ctx(event.id));
    expect((await switched.json()).event.audienceLocale).toBe("en");
  });

  it("is kept by Duplicate", async () => {
    const h = await host();
    const { event } = await (await createEvent(json(h.cookie, eventBody({ audienceLocale: "id" })))).json();
    const copy = (await (await duplicateEvent(json(h.cookie, {}), ctx(event.id))).json()).event;
    expect(copy.id).not.toBe(event.id);
    expect(copy.audienceLocale).toBe("id");
  });

  it("is chosen when an event is made from a template", async () => {
    const h = await host();
    const [template] = await db.insert(templates).values({ workspaceId: h.workspaceId, name: "Kickoff", kind: "event" }).returning();
    const res = await fromTemplate(json(h.cookie, eventBody({ templateId: template.id, audienceLocale: "id" })));
    expect(res.status).toBe(201);
    expect((await res.json()).event.audienceLocale).toBe("id");
    const blank = await fromTemplate(json(h.cookie, eventBody({ templateId: template.id })));
    expect((await blank.json()).event.audienceLocale).toBe("en");
  });
});

describe("host language", () => {
  it("PUT /api/auth/locale saves it on the account and sets the lang cookie", async () => {
    const h = await host();
    const res = await putLocale(json(h.cookie, { locale: "id" }, "PUT"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^lang=id;/);
    const [row] = await db.select().from(users).where(eq(users.id, h.user.id));
    expect(row.locale).toBe("id");
  });

  it("needs a session and a supported language", async () => {
    const h = await host();
    expect((await putLocale(json(undefined, { locale: "id" }, "PUT"))).status).toBe(401);
    expect((await putLocale(json(h.cookie, { locale: "fr" }, "PUT"))).status).toBe(400);
    expect((await putLocale(json(h.cookie, {}, "PUT"))).status).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, h.user.id));
    expect(row.locale).toBeNull();
  });

  it("login hands the saved language to a new device, and sets nothing for a user who never chose", async () => {
    await host("saved@example.com", "id");
    await host("unset@example.com");
    const saved = await login(json(undefined, { email: "saved@example.com", password: "correct horse battery" }));
    expect(saved.status).toBe(200);
    const cookies = saved.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("lang=id;"))).toBe(true);

    const unset = await login(json(undefined, { email: "unset@example.com", password: "correct horse battery" }));
    expect(unset.headers.getSetCookie().some((c) => c.startsWith("lang="))).toBe(false);
  });
});

describe("getLocale on each kind of page", () => {
  async function makeEvent(audienceLocale: "en" | "id") {
    const h = await host();
    const [event] = await db
      .insert(events)
      .values({
        ownerId: h.user.id,
        workspaceId: h.workspaceId,
        name: "E",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3600_000),
        joinCode: "654321",
        audienceLocale,
      })
      .returning();
    return event;
  }

  it("host pages use the lang cookie, then Accept-Language, ignoring any event", async () => {
    await makeEvent("id");
    incoming["accept-language"] = "id";
    expect(await getLocale()).toBe("id");
    jar.lang = "en";
    expect(await getLocale()).toBe("en");
  });

  it("join, participant and survey pages follow the event, whatever the host cookie and browser say", async () => {
    const event = await makeEvent("id");
    const [survey] = await db
      .insert(interactions)
      .values({ eventId: event.id, type: "survey", title: "S", position: 1, config: { questions: [] } })
      .returning();
    jar.lang = "en";
    incoming["accept-language"] = "en";
    for (const path of ["/join/654321", `/e/${event.id}`, `/survey/${survey.id}`]) {
      incoming["x-audience-path"] = path;
      expect(await getLocale(), path).toBe("id");
    }
  });

  it("a participant's choice for that event wins, but only for that event", async () => {
    const event = await makeEvent("id");
    incoming["x-audience-path"] = `/e/${event.id}`;
    jar[audienceLocaleCookie(event.id)] = "en";
    expect(await getLocale()).toBe("en");
    delete jar[audienceLocaleCookie(event.id)];
    jar[audienceLocaleCookie("00000000-0000-4000-8000-000000000000")] = "en";
    expect(await getLocale()).toBe("id");
  });

  it("the presenter follows the event even when the browser holds a participant choice", async () => {
    const event = await makeEvent("id");
    incoming["x-audience-path"] = `/present/${event.id}`;
    jar[audienceLocaleCookie(event.id)] = "en";
    expect(await getLocale()).toBe("id");
  });

  it("an unknown event falls back to the host order", async () => {
    incoming["x-audience-path"] = "/e/00000000-0000-4000-8000-000000000000";
    incoming["accept-language"] = "id";
    expect(await getLocale()).toBe("id");
    incoming["x-audience-path"] = "/join/000000";
    jar.lang = "en";
    expect(await getLocale()).toBe("en");
  });
});
