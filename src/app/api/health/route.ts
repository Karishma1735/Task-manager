import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

/** Liveness + database check for the host. Public by design; it reveals nothing beyond up/down. */
export function GET() {
  try {
    getDb().get(sql`select 1`);
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
