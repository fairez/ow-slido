/** Thrown when a workspace has no seat left; routes answer 402 with `reason`. */
export class SeatLimitError extends Error {
  readonly reason = "seat_limit";
  constructor(message = "No seat left on this plan") {
    super(message);
  }
}

/**
 * Called before an invitation is created. Throws `SeatLimitError` when the workspace's plan has no seat
 * left. A no-op until the plans story fills it in (a seat is an active membership or a pending invite).
 */
export async function assertSeatAvailable(workspaceId: string): Promise<void> {
  void workspaceId;
}
