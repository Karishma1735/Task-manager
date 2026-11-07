/**
 * Weekly digest text. PURE: it only re-presents the numbers already computed by lib/scoring.ts
 * (via the report read model). It defines no metric of its own.
 */
import type { DayOutcomeView, ReportView } from "@/lib/report";
import { STATUS_LABEL, verification } from "@/lib/report-text";

export interface DigestSnapshot {
  /** True when the week is still in progress and its last working day is not closed yet. */
  isSnapshot: boolean;
  asOf: string; // ISO instant
  label: string;
}

export interface Digest {
  subject: string;
  snapshot: DigestSnapshot;
  text: string;
  topOutcomes: { title: string; points: number; state: string; evidence: string | null }[];
  unresolved: { date: string; title: string; status: string; reason: string }[];
}

const longDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const pct = (n: number | null) => (n === null ? "not available yet" : `${n}%`);
const pts = (n: number) => `${n} point${n === 1 ? "" : "s"}`;

export function buildDigest(
  r: ReportView,
  ctx: { now: Date; tz: string; today: string },
): Digest {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.tz, hour: "numeric", minute: "2-digit", hour12: true }).format(ctx.now).toUpperCase();
  const todayView = r.days.find((d) => d.date === ctx.today);
  const dow = new Date(`${ctx.today}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  // A snapshot while the week can still change: before Friday, or on Friday until the day is closed.
  const midWeek = r.isCurrentWeek && dow >= 1 && dow <= 4;
  const fridayOpen = r.isCurrentWeek && dow === 5 && !todayView?.closedAt;
  const isSnapshot = midWeek || fridayOpen;
  const snapshot: DigestSnapshot = {
    isSnapshot,
    asOf: ctx.now.toISOString(),
    label: fridayOpen
      ? `SNAPSHOT as of ${clock} ${ctx.tz} — today is still open. Points and measures can change after the day closes and the reviewer scores it.`
      : midWeek
        ? `SNAPSHOT as of ${clock} ${ctx.tz} — the week is still in progress.`
        : `Final for the week as of ${clock} ${ctx.tz}.`,
  };
  const dayOpen = isSnapshot;

  const all: { date: string; o: DayOutcomeView }[] = r.days.flatMap((d) => d.outcomes.map((o) => ({ date: d.date, o })));
  const delivered = all.filter((x) => x.o.delivered);
  const top = [...delivered]
    .sort((a, b) => b.o.points - a.o.points || b.o.level - a.o.level)
    .filter((x) => x.o.points > 0)
    .slice(0, 3);
  const unresolved = all
    .filter((x) => x.o.status !== "done")
    .map((x) => ({
      date: x.date,
      title: x.o.title,
      status: x.o.status === "open" ? "still open" : x.o.status === "carried" ? "carried over" : "missed",
      reason: x.o.reason ?? "",
    }));

  const L: string[] = [];
  L.push(`VALUE LEDGER — Weekly digest · ${r.ownerName}`);
  L.push(`Week of ${longDate(r.weekStart)} to ${longDate(r.weekEnd)}`);
  L.push(snapshot.label);
  L.push("");
  L.push(`VALUE DELIVERED: ${pts(r.value.total)} — ${r.value.confirmed} confirmed plus ${r.value.awaiting} awaiting review`);
  L.push(`Review status: ${STATUS_LABEL[r.status]}`);
  L.push("");
  L.push("MEASURES");
  L.push(`• Promises kept (weighted by points): ${pct(r.measures.promisesKept.percent)}`);
  L.push(`• High-leverage share: ${pct(r.measures.highLeverageShare.percent)}`);
  L.push(`• On goal: ${pct(r.measures.onGoal.percent)}`);
  L.push(`• Claim accuracy: ${pct(r.measures.claimAccuracy.percent)}`);
  L.push(`• Unplanned share: ${pct(r.measures.unplannedShare.percent)}`);
  L.push(`• Rhythm: ${pct(r.measures.rhythm.percent)}`);
  L.push("");
  L.push("MOST VALUABLE DELIVERED");
  if (top.length === 0) L.push("• Nothing delivered with value yet.");
  for (const x of top) {
    L.push(`• ${x.o.title} — ${verification(x.o)}`);
    L.push(`  Evidence: ${x.o.proofUrl ?? "no valid proof link"}`);
  }
  L.push("");
  L.push("EVIDENCE");
  if (delivered.length === 0) L.push("• None yet.");
  for (const x of delivered) L.push(`• ${longDate(x.date)} — ${x.o.title}: ${x.o.proofUrl ?? "no valid proof link"}`);
  L.push("");
  L.push("UNRESOLVED OR MISSED");
  if (unresolved.length === 0) L.push("• None.");
  for (const u of unresolved) L.push(`• ${longDate(u.date)} — ${u.title} (${u.status})${u.reason ? `: ${u.reason}` : ""}`);
  if (r.goals.length) {
    L.push("", "WEEKLY GOALS");
    for (const g of r.goals) L.push(`• ${g.text} — ${pts(g.total)} toward it (${g.confirmed} confirmed + ${g.awaiting} awaiting review)`);
  }

  return {
    subject: `Value Ledger weekly digest — week of ${longDate(r.weekStart)}${dayOpen ? " (snapshot)" : ""}`,
    snapshot,
    text: L.join("\n"),
    topOutcomes: top.map((x) => ({ title: x.o.title, points: x.o.points, state: x.o.state, evidence: x.o.proofUrl })),
    unresolved,
  };
}
