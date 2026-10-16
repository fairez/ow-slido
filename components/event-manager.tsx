"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LiveParticipantCount } from "@/components/live-participant-count";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField } from "@/components/ui/field";

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
    <div className="stack">
      <Card aria-labelledby="new-event-title">
        <h2 id="new-event-title">New event</h2>
        <form onSubmit={createEvent} className="form-stack">
          <TextField label="Event name" name="name" required maxLength={80} />
          <div className="form-pair">
            <TextField label="Start" name="startsAt" type="datetime-local" required />
            <TextField label="End" name="endsAt" type="datetime-local" required />
          </div>
          {error && <InlineError>{error}</InlineError>}
          <div>
            <Button type="submit" variant="primary" busy={pending}>
              {pending ? "Saving" : "Create event"}
            </Button>
          </div>
        </form>
      </Card>

      {created && (
        <div role="status" className="notice">
          <p className="notice-title">
            <strong>{created.name}</strong> created.
          </p>
          <p>
            Join code <strong className="join-code">{created.joinCode}</strong>
          </p>
          <p>
            Join link <code>{joinUrl(created.joinCode)}</code>
          </p>
        </div>
      )}

      <section aria-labelledby="events-title">
        <h2 id="events-title">All events</h2>
        {events.length === 0 ? (
          <EmptyState title="No events yet">Create your first event above. You get a join code to share with your audience.</EmptyState>
        ) : (
          <ul className="row-list">
            {events.map((e) => (
              <li key={e.id} className="event-row">
                <div className="event-main">
                  {renaming === e.id ? (
                    <form onSubmit={(ev) => rename(e, ev)} className="inline-form">
                      <TextField label="New name" name="name" defaultValue={e.name} required maxLength={80} />
                      <Button type="submit" variant="primary">Save</Button>
                      <Button onClick={() => setRenaming(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <h3 className="event-name">{e.name}</h3>
                  )}
                  <p className="row-meta">
                    {new Date(e.startsAt).toLocaleString()} to {new Date(e.endsAt).toLocaleString()}
                  </p>
                  <div className="row-meta">
                    Join code <Badge>{e.joinCode}</Badge>
                  </div>
                  <div className="row-meta">
                    <LiveParticipantCount eventId={e.id} />
                  </div>
                </div>
                <div className="row-actions">
                  <Link href={`/dashboard/events/${e.id}`} className="ui-button" data-variant="primary">
                    Manage
                  </Link>
                  <Button variant="quiet" onClick={() => setRenaming(e.id)}>Rename</Button>
                  <Button variant="quiet" onClick={() => duplicate(e)}>Duplicate</Button>
                  <Button variant="quiet" onClick={() => setDeleting(e)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={deleting !== null} title="Delete this event?" onClose={() => setDeleting(null)}>
        <p>
          “{deleting?.name}” and everything in it (interactions, questions, responses) will be removed. This cannot be undone.
        </p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => deleting && confirmDelete(deleting)}>Delete event</Button>
        </div>
      </Dialog>
    </div>
  );
}
