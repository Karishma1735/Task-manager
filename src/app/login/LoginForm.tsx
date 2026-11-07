"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, describeError } from "@/lib/client-api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const r = await api<{ user: { role: "owner" | "reviewer" } }>("POST", "/api/auth/login", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (!r.ok) {
      setBusy(false);
      setError(r.error.status === 401 ? "That email and password don't match." : describeError(r.error));
      return;
    }
    router.replace(r.data.user.role === "owner" ? "/my-day" : "/report");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card mt-10 space-y-5" aria-describedby={error ? "login-error" : undefined}>
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="field" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="field" />
      </div>
      <div role="alert" id="login-error">
        {error && <p className="alert alert-error">{error}</p>}
      </div>
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
