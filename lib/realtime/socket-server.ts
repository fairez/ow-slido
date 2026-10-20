import type { Server as HttpServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { Server, type Socket } from "socket.io";
import { events, participants } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { participantCookieName, verifyParticipantToken } from "@/lib/participant-token";
import { participantConnected, participantDisconnected, presenceCount } from "./presence";
import { eventRoom, hostRoom, memberRoom, setMemberRevoker, setPublisher, type Publisher } from "./publisher";

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
async function authorize(
  socket: Socket,
): Promise<{ role: SocketRole; participantId?: string; userId?: string; workspaceId?: string } | null> {
  const { eventId, role } = socket.handshake.auth as { eventId?: unknown; role?: unknown };
  if (typeof eventId !== "string" || !isUuid(eventId)) return null;
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const db = getDb();

  if (role === "host" || role === "moderator") {
    const user = await getUserFromToken(cookies.get(SESSION_COOKIE));
    if (!user || user.mustChangePassword) return null;
    const membership = resolveActiveMembership(user.memberships, cookies.get(WORKSPACE_COOKIE));
    if (!membership) return null;
    if (role === "moderator" && !can(membership.role, "moderate")) return null;
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.workspaceId, membership.workspaceId)));
    return event ? { role, userId: user.id, workspaceId: membership.workspaceId } : null;
  }

  const token = cookies.get(participantCookieName(eventId));
  const participantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!participantId || !isUuid(participantId)) return null;
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  return participant ? { role: "participant", participantId: participant.id } : null;
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
 * `auth: { eventId, role: "participant" | "host" | "moderator" }` and are placed in the event's room
 * (hosts also in the host-only room) only if their cookie proves access.
 */
export function attachSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, { path: "/socket.io" });

  io.use(async (socket, next) => {
    try {
      const granted = await authorize(socket);
      if (!granted) return next(new Error("unauthorized"));
      const { eventId } = socket.handshake.auth as { eventId: string };
      socket.data.role = granted.role;
      socket.data.participantId = granted.participantId;
      socket.data.userId = granted.userId;
      socket.data.workspaceId = granted.workspaceId;
      socket.data.eventId = eventId;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { eventId, role, participantId, userId, workspaceId } = socket.data as {
      eventId: string;
      role: SocketRole;
      participantId?: string;
      userId?: string;
      workspaceId?: string;
    };
    socket.join(eventRoom(eventId));
    if (role === "host" || role === "moderator") {
      socket.join(hostRoom(eventId));
      if (userId && workspaceId) socket.join(memberRoom(userId, workspaceId));
      socket.emit("presence", { count: presenceCount(eventId) });
    }
    if (role === "participant" && participantId) {
      void participantConnected(eventId, participantId).catch(() => {});
      socket.on("disconnect", () => participantDisconnected(eventId, participantId));
    }
  });

  setPublisher(createSocketPublisher(io));
  setMemberRevoker((userId, workspaceId) => io.in(memberRoom(userId, workspaceId)).disconnectSockets(true));
  return io;
}
