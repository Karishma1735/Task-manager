/** Plain-text reports for copy/paste. Pure: no I/O. Nothing here is sent anywhere automatically. */
import type { DayOutcomeView, DayView, MeasureView, ReportView, WeekStatus } from "@/lib/report";

const longDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

const pct = (m: MeasureView) => (m.percent === null ? "not available yet" : `${m.percent}%`);
const pts = (n: number) => `${n} point${n === 1 ? "" : "s"}`;

export const STATUS_LABEL: Record<WeekStatus, string> = {
  nothing: "Nothing delivered yet",
  awaiting: "Awaiting review",
  partly: "Partly reviewed",
  reviewed: "Reviewed",
};

export function verification(o: DayOutcomeView): string {
  if (o.state === "confirmed") {
    return o.points === 0 ? `Scored 0 by reviewer (claimed ${o.level})` : `Confirmed by reviewer: ${pts(o.points)} (claimed ${o.level})`;
  }
  if (o.state === "awaiting") return `Awaiting review (claimed ${o.level})`;
  return "Not delivered: 0 points";
}

function outcomeLines(o: DayOutcomeView): string[] {
  const lines = [`• ${o.title} — ${verification(o)}`];
  if (o.planned) lines.push(`  Expected: ${o.doneMeans}`);
  if (o.status === "done") {
    lines.push(`  Actual: ${o.result ?? ""}`);
    lines.push(`  Evidence: ${o.proofUrl ?? "no valid proof link"}`);
  } else if (o.status === "missed" || o.status === "carried") {
    lines.push(`  ${o.status === "missed" ? "Missed" : "Carried to tomorrow"}: ${o.reason ?? ""}`);
  } else {
    lines.push("  Still open");
  }
  return lines;
}

export function dayReportText(day: DayView, ownerName?: string): string {
  const L: string[] = [];
  L.push(`VALUE LEDGER — Day report${ownerName ? ` · ${ownerName}` : ""}`);
  L.push(longDate(day.date));
  L.push("");
  L.push(`Value delivered: ${pts(day.delivered.total)} (${day.delivered.confirmed} confirmed + ${day.delivered.awaiting} awaiting review)`);
  L.push(
    day.promisedPoints > 0
      ? `Promised: ${pts(day.promisedPoints)} · Delivered of promised: ${pts(day.keptPoints)} (${Math.round((day.keptPoints / day.promisedPoints) * 100)}% kept)`
      : "Promised: nothing committed",
  );
  const planned = day.outcomes.filter((o) => o.planned);
  const unplanned = day.outcomes.filter((o) => !o.planned);
  if (planned.length) {
    L.push("", "PLANNED");
    planned.forEach((o) => L.push(...outcomeLines(o)));
  }
  if (unplanned.length) {
    L.push("", "UNPLANNED (not counted in promises kept)");
    unplanned.forEach((o) => L.push(...outcomeLines(o)));
  }
  if (day.highlight) L.push("", `Most valuable thing delivered: ${day.highlight}`);
  if (day.learning) L.push(`Learned: ${day.learning}`);
  for (const n of day.notes) L.push(`Reviewer note (${n.reviewer}): ${n.note}`);
  if (!day.closedAt) L.push("", "(Day not closed yet)");
  return L.join("\n");
}

export function weekReportText(r: ReportView, ownerName?: string): string {
  const L: string[] = [];
  L.push(`VALUE LEDGER — Week report${ownerName ? ` · ${ownerName}` : ""}`);
  L.push(`Week of ${longDate(r.weekStart)}`);
  L.push("");
  L.push(`Value delivered: ${pts(r.value.total)} — ${r.value.confirmed} confirmed plus ${r.value.awaiting} awaiting review`);
  L.push(`Review status: ${STATUS_LABEL[r.status]}`);
  L.push("");
  L.push("MEASURES");
  L.push(`• Promises kept: ${pct(r.measures.promisesKept)}`);
  L.push(`• High-leverage share: ${pct(r.measures.highLeverageShare)}`);
  L.push(`• On goal: ${pct(r.measures.onGoal)}`);
  L.push(`• Claim accuracy: ${pct(r.measures.claimAccuracy)}`);
  L.push(`• Unplanned share: ${pct(r.measures.unplannedShare)}`);
  L.push(`• Rhythm: ${pct(r.measures.rhythm)}`);
  if (r.goals.length) {
    L.push("", "WEEKLY GOALS");
    for (const g of r.goals) {
      L.push(`• ${g.text} (measured by: ${g.measure}) — ${pts(g.total)} toward it (${g.confirmed} confirmed + ${g.awaiting} awaiting review)`);
    }
  }
  if (r.days.length) {
    L.push("", "DAY BY DAY");
    for (const d of r.days) {
      L.push("", `${longDate(d.date)} — ${pts(d.delivered.total)} (${d.delivered.confirmed} confirmed + ${d.delivered.awaiting} awaiting review)`);
      d.outcomes.forEach((o) => L.push(...outcomeLines(o)));
      if (d.highlight) L.push(`Most valuable: ${d.highlight}`);
      for (const n of d.notes) L.push(`Reviewer note (${n.reviewer}): ${n.note}`);
    }
  }
  return L.join("\n");
}
