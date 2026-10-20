import { getT } from "@/lib/i18n/server";

/** What an audience member sees when the event's workspace is suspended. Says nothing about why. */
export async function EventUnavailable() {
  const t = await getT();
  return (
    <div className="stack">
      <h1>{t("suspended.eventTitle")}</h1>
      <p className="row-meta">{t("suspended.eventBody")}</p>
    </div>
  );
}
