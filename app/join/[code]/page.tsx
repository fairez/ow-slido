import { JoinRedirect } from "@/components/join-redirect";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main style={{ maxWidth: 400, margin: "0 auto", padding: 16 }}>
      <JoinRedirect code={code} />
    </main>
  );
}
