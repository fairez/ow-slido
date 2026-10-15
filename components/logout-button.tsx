"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={logout} style={{ padding: 10, font: "inherit" }}>
      Log out
    </button>
  );
}
