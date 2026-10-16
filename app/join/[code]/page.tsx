import { JoinRedirect } from "@/components/join-redirect";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main id="main" className="entry-page">
      <JoinRedirect code={code} />
    </main>
  );
}
