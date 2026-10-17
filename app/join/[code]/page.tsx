import { JoinRedirect } from "@/components/join-redirect";

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ cookies?: string }>;
}) {
  const { code } = await params;
  const { cookies } = await searchParams;
  return (
    <main id="main" className="entry-page">
      <JoinRedirect code={code} cookiesBlocked={cookies === "blocked"} />
    </main>
  );
}
