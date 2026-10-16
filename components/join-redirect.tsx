"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { InlineError } from "@/components/ui/field";
import { joinEvent } from "@/lib/join-client";

export function JoinRedirect({ code }: { code: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    joinEvent(code).then((result) => {
      if (cancelled) return;
      if (result.ok) router.replace(`/e/${result.eventId}`);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [code, router]);

  if (!error) {
    return (
      <>
        <h1>Joining the event</h1>
        <p role="status" className="entry-lead">
          Checking code {code}. This takes a moment.
        </p>
      </>
    );
  }
  return (
    <>
      <h1>Could not join</h1>
      <InlineError>{error}</InlineError>
      <p className="entry-alt">
        <Link href="/">Enter a code instead</Link>
      </p>
    </>
  );
}
