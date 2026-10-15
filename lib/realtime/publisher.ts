export type PublishOptions = {
  /** Deliver only to the host's sockets (presenter, moderation queue). */
  hostOnly?: boolean;
};

export interface Publisher {
  publish(eventId: string, name: string, payload: unknown, options?: PublishOptions): void;
}

export const eventRoom = (eventId: string) => `event:${eventId}`;
export const hostRoom = (eventId: string) => `event:${eventId}:host`;

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
