"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/client-api";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-quiet"
      onClick={async () => {
        await api("POST", "/api/auth/logout");
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
