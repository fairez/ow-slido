"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export type EventSummary = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  joinCode: string;
};

const byStart = (a: EventSummary, b: EventSummary) =>
  new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();

function joinUrl(code: string) {
  return `${window.location.origin}/join/${code}`;
}

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? "Something went wrong. Please try again.";
}

const inputStyle = { padding: 8, font: "inherit" } as const;
const buttonStyle = { padding: 10, font: "inherit" } as const;

export function EventManager({ initialEvents }: { initialEvents: EventSummary[] }) {
  const [events, setEvents] = useState([...initialEvents].sort(byStart));
  const [created, setCreated] = useState<EventSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EventSummary | null>(null);

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          startsAt: new Date(String(data.get("startsAt"))).toISOString(),
          endsAt: new Date(String(data.get("endsAt"))).toISOString(),
        }),
      });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => [...list, saved].sort(byStart));
      setCreated(saved);
      form.reset();
    } catch (err) {
      setError(err instanceof RangeError ? "Enter valid start and end dates." : "Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function rename(target: EventSummary, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => list.map((e) => (e.id === saved.id ? saved : e)));
      setRenaming(null);
    } catch {
      setError("Network error. Please try again.");
    }
  }

  async function duplicate(target: EventSummary) {
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}/duplicate`, { method: "POST" });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => [...list, saved].sort(byStart));
      setCreated(saved);
    } catch {
      setError("Network error. Please try again.");
    }
  }

  async function confirmDelete(target: EventSummary) {
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}`, { method: "DELETE" });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      setEvents((list) => list.filter((e) => e.id !== target.id));
      setCreated((c) => (c?.id === target.id ? null : c));
      setDeleting(null);
    } catch {
      setError("Network error. Please try again.");
    }
  }

  return (
    <section>
      <h2>New event</h2>
      <form onSubmit={createEvent} style={{ display: "grid", gap: 12, maxWidth: 400 }}>
        <label style={{ display: "grid", gap: 4 }}>
          Event name
          <input name="name" required maxLength={80} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Start
          <input name="startsAt" type="datetime-local" required style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          End
          <input name="endsAt" type="datetime-local" required style={inputStyle} />
        </label>
        <button type="submit" disabled={pending} style={buttonStyle}>
          {pending ? "Saving…" : "Create event"}
        </button>
      </form>

      {error && (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      )}

      {created && (
        <div role="status" style={{ border: "1px solid #888", padding: 12, margin: "16px 0" }}>
          <strong>{created.name}</strong> created.
          <div>
            Join code: <strong>{created.joinCode}</strong>
          </div>
          <div>
            Join URL: <code style={{ overflowWrap: "anywhere" }}>{joinUrl(created.joinCode)}</code>
          </div>
        </div>
      )}

      <h2>Your events</h2>
      {events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
          {events.map((e) => (
            <li key={e.id} style={{ border: "1px solid #ccc", padding: 12 }}>
              {renaming === e.id ? (
                <form onSubmit={(ev) => rename(e, ev)} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input name="name" defaultValue={e.name} required maxLength={80} aria-label="New name" style={inputStyle} />
                  <button type="submit" style={buttonStyle}>Save</button>
                  <button type="button" onClick={() => setRenaming(null)} style={buttonStyle}>Cancel</button>
                </form>
              ) : (
                <strong>{e.name}</strong>
              )}
              <div>
                {new Date(e.startsAt).toLocaleString()} – {new Date(e.endsAt).toLocaleString()}
              </div>
              <div>
                Join code: <strong>{e.joinCode}</strong>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Link href={`/dashboard/events/${e.id}`} style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", border: "1px solid #888" }}>
                  Manage
                </Link>
                <button type="button" onClick={() => setRenaming(e.id)} style={buttonStyle}>
                  Rename
                </button>
                <button type="button" onClick={() => duplicate(e)} style={buttonStyle}>
                  Duplicate
                </button>
                <button type="button" onClick={() => setDeleting(e)} style={buttonStyle}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="delete-title" style={{ border: "2px solid #b00020", padding: 16, background: "#fff", color: "#000" }}>
          <p id="delete-title">
            Delete “{deleting.name}”? This removes the event and everything in it.
          </p>
          <button type="button" onClick={() => confirmDelete(deleting)} style={buttonStyle}>
            Delete event
          </button>{" "}
          <button type="button" onClick={() => setDeleting(null)} style={buttonStyle}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
