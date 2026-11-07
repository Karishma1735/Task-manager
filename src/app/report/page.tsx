import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { systemClock } from "@/lib/clock";
import { ApiError } from "@/lib/errors";
import { getReport } from "@/lib/report";
import { requireUserPage } from "@/lib/session";
import { Report } from "./Report";

export const dynamic = "force-dynamic";

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUserPage();
  const { week } = await searchParams;
  let report;
  try {
    report = getReport(getDb(), week, systemClock());
  } catch (e) {
    if (e instanceof ApiError && week) redirect("/report");
    throw e;
  }
  return <Report initial={JSON.parse(JSON.stringify(report))} role={user.role} userName={user.name} />;
}
