"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

  if (!error) return <p role="status">Joining…</p>;
  return (
    <>
      <p role="alert" style={{ color: "#b00020" }}>
        {error}
      </p>
      <Link href="/" style={{ display: "inline-block", minHeight: 44, lineHeight: "44px" }}>
        Enter a code instead
      </Link>
    </>
  );
}
