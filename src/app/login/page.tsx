import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const u = await currentUser();
  if (u) redirect(u.role === "owner" ? "/my-day" : "/report");
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="eyebrow">Value Ledger</p>
      <h1 className="mt-3 text-5xl">Promise first.<br />Prove it.</h1>
      <p className="mt-4 text-muted">Sign in to commit to the outcomes that matter today.</p>
      <LoginForm />
    </main>
  );
}
