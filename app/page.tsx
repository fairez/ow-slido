import { JoinForm } from "@/components/join-form";

export default function Home() {
  return (
    <main style={{ maxWidth: 400, margin: "0 auto", padding: 16 }}>
      <h1>OW Slido</h1>
      <p>Enter the event code to join.</p>
      <JoinForm />
    </main>
  );
}
