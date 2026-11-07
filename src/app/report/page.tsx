import { LogoutButton } from "@/components/LogoutButton";
import { requireUserPage } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Placeholder: the Report screen and reviewer scoring arrive in Phase 2. */
export default async function ReportPage() {
  const user = await requireUserPage();
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16">
      <p className="eyebrow">Report · {user.role}</p>
      <h1 className="mt-3 text-4xl">The weekly report is coming in Phase 2.</h1>
      <p className="mt-4 text-muted">
        Signed in as {user.name}. Reviewers will confirm points here. Until then, nothing on this screen can be changed.
      </p>
      <div className="mt-8 flex gap-4">
        {user.role === "owner" && <a className="btn" href="/my-day">Back to My Day</a>}
        <LogoutButton />
      </div>
    </main>
  );
}
