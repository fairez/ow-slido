import type { Server as HttpServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { Server, type Socket } from "socket.io";
import { events, participants } from "@/db/schema";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { verifyModeratorToken } from "@/lib/moderator-token";
import { participantCookieName, verifyParticipantToken } from "@/lib/participant-token";
import { eventRoom, hostRoom, setPublisher, type Publisher } from "./publisher";

export type SocketRole = "participant" | "host" | "moderator";

function parseCookies(header: string | undefined) {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) out.set(name, rest.join("="));
  }
  return out;
}

/** Returns the role granted to the socket for the event, or null if it is not allowed in. */
async function authorize(socket: Socket): Promise<SocketRole | null> {
  const { eventId, role, token: moderatorToken } = socket.handshake.auth as { eventId?: unknown; role?: unknown; token?: unknown };
  if (typeof eventId !== "string" || !isUuid(eventId)) return null;
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const db = getDb();

  if (role === "moderator") {
    return typeof moderatorToken === "string" && (await verifyModeratorToken(eventId, moderatorToken)) ? "moderator" : null;
  }

  if (role === "host") {
    const user = await getUserFromToken(cookies.get(SESSION_COOKIE));
    if (!user) return null;
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.ownerId, user.id)));
    return event ? "host" : null;
  }

  const token = cookies.get(participantCookieName(eventId));
  const participantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!participantId || !isUuid(participantId)) return null;
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  return participant ? "participant" : null;
}

/** Socket.IO-backed publisher; a Redis adapter can be added to the Server for multi-process fan-out. */
export function createSocketPublisher(io: Server): Publisher {
  return {
    publish(eventId, name, payload, options) {
      io.to(options?.hostOnly ? hostRoom(eventId) : eventRoom(eventId)).emit(name, payload);
    },
  };
}

/**
 * Attaches Socket.IO to the HTTP server. Clients connect with
 * `auth: { eventId, role: "participant" | "host" | "moderator", token? }` and are placed in the event's room
 * (hosts also in the host-only room) only if their cookie proves access.
 */
export function attachSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, { path: "/socket.io" });

  io.use(async (socket, next) => {
    try {
      const role = await authorize(socket);
      if (!role) return next(new Error("unauthorized"));
      const { eventId } = socket.handshake.auth as { eventId: string };
      socket.data.role = role;
      socket.data.eventId = eventId;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { eventId, role } = socket.data as { eventId: string; role: SocketRole };
    socket.join(eventRoom(eventId));
    if (role === "host" || role === "moderator") socket.join(hostRoom(eventId));
  });

  setPublisher(createSocketPublisher(io));
  return io;
}
