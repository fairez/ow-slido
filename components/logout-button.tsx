"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

export function LogoutButton() {
  const router = useRouter();
  const t = useT();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <Button variant="quiet" onClick={logout}>
      {t("logout.button")}
    </Button>
  );
}
