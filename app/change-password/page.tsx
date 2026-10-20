import { redirect } from "next/navigation";

/** The forced password change lives at /account/password; this path is kept for links that point here. */
export default function ChangePasswordRedirect() {
  redirect("/account/password");
}
