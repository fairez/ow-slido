import Link from "next/link";
import { JoinForm } from "@/components/join-form";

export default function Home() {
  return (
    <main id="main" className="entry-page">
      <h1>Join an event</h1>
      <p className="entry-lead">Type the code your host is showing. It has six digits.</p>
      <JoinForm />
      <p className="entry-alt">
        Running an event yourself? <Link href="/signup">Create a host account</Link> or <Link href="/login">log in</Link>.
      </p>
    </main>
  );
}
