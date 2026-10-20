import { BrandStyle, brandAttrs } from "@/components/brand-style";
import { JoinRedirect } from "@/components/join-redirect";
import { eventAccentByJoinCode } from "@/lib/branding";

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ cookies?: string }>;
}) {
  const { code } = await params;
  const { cookies } = await searchParams;
  const accent = await eventAccentByJoinCode(code);
  return (
    <main id="main" className="entry-page" {...brandAttrs(accent)}>
      <BrandStyle accent={accent} />
      <JoinRedirect code={code} cookiesBlocked={cookies === "blocked"} />
    </main>
  );
}
