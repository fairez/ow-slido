export type PublishOptions = {
  /** Deliver only to the host's sockets (presenter, moderation queue). */
  hostOnly?: boolean;
  /** Deliver only to this participant's sockets (a personal result), not to the room. */
  participantId?: string;
};

export interface Publisher {
  publish(eventId: string, name: string, payload: unknown, options?: PublishOptions): void;
}

export const eventRoom = (eventId: string) => `event:${eventId}`;
export const hostRoom = (eventId: string) => `event:${eventId}:host`;
export const participantRoom = (eventId: string, participantId: string) => `event:${eventId}:participant:${participantId}`;

// Route handlers and server.ts may load separate module instances, so the active publisher lives on globalThis.
const globalForPublisher = globalThis as unknown as { realtimePublisher?: Publisher };

/** Drops messages; used until a socket server is attached (e.g. in unit tests). */
const noopPublisher: Publisher = { publish() {} };

export function setPublisher(publisher: Publisher | null) {
  globalForPublisher.realtimePublisher = publisher ?? undefined;
}

export function getPublisher(): Publisher {
  return globalForPublisher.realtimePublisher ?? noopPublisher;
}

export function publish(eventId: string, name: string, payload: unknown, options?: PublishOptions) {
  getPublisher().publish(eventId, name, payload, options);
}

export const memberRoom = (userId: string, workspaceId: string) => `member:${workspaceId}:${userId}`;

type MemberRevoker = (userId: string, workspaceId: string) => void;
const globalForRevoker = globalThis as unknown as { memberRevoker?: MemberRevoker };

export function setMemberRevoker(revoker: MemberRevoker | null) {
  globalForRevoker.memberRevoker = revoker ?? undefined;
}

/** Drops a member's host and moderator sockets for a workspace; they must pass the access check again to reconnect. */
export function revokeMemberSockets(userId: string, workspaceId: string) {
  globalForRevoker.memberRevoker?.(userId, workspaceId);
}
