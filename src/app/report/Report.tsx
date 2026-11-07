"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { EightWeekChart } from "@/components/EightWeekChart";
import { LogoutButton } from "@/components/LogoutButton";
import { ValueCircles } from "@/components/ValueCircles";
import { api, describeError } from "@/lib/client-api";
import type { DayOutcomeView, DayView, MeasureView, ReportView, WeekStatus } from "@/lib/report";
import { dayReportText, STATUS_LABEL, verification, weekReportText } from "@/lib/report-text";
import { LEVEL_NAMES } from "@/lib/scoring";

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const POINTS = [0, 1, 2, 4, 8] as const;

function ValueBar({ confirmed, awaiting, max }: { confirmed: number; awaiting: number; max: number }) {
  const pc = (n: number) => `${max > 0 ? (n / max) * 100 : 0}%`;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface2" role="img" aria-label={`${confirmed} confirmed plus ${awaiting} awaiting review`}>
      <div className="h-full bg-ok" style={{ width: pc(confirmed) }} />
      <div className="stripes h-full" style={{ width: pc(awaiting), backgroundColor: "var(--cherry)" }} />
    </div>
  );
}

const STATUS_STYLE: Record<WeekStatus, string> = {
  nothing: "text-muted",
  awaiting: "border-cherry text-cherry",
  partly: "border-warn text-warn",
  reviewed: "border-ok text-ok",
};

export function Report({ initial, role, userName }: { initial: ReportView; role: "owner" | "reviewer"; userName: string }) {
  const [report, setReport] = useState(initial);
  const isReviewer = role === "reviewer";

  const refresh = useCallback(async () => {
    const r = await api<ReportView>("GET", `/api/report?week=${report.weekStart}`);
    if (r.ok) setReport(r.data);
  }, [report.weekStart]);

  const m = report.measures;
  const week = `${fmt(report.weekStart, { day: "numeric", month: "long" })} – ${fmt(report.weekEnd, { day: "numeric", month: "long", year: "numeric" })}`;

  return (
    <main id="main" className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Report · {report.ownerName}</p>
          <h1 className="mt-1 text-3xl sm:text-5xl" data-testid="week-title">{report.isCurrentWeek ? "This week" : "Week"}</h1>
          <p className="text-muted">{week}</p>
        </div>
        <nav aria-label="Navigation" className="flex flex-wrap items-center gap-1">
          <Link className="btn btn-quiet" href={`/report?week=${report.prevWeek}`} aria-label="Previous week">← Previous</Link>
          {report.nextWeek ? (
            <Link className="btn btn-quiet" href={`/report?week=${report.nextWeek}`} aria-label="Next week">Next →</Link>
          ) : (
            <span className="px-2 text-muted" aria-hidden>Latest</span>
          )}
          {role === "owner" && <Link className="btn btn-quiet" href="/my-day">My day</Link>}
          <LogoutButton />
        </nav>
      </header>

      {/* Ten-second block: value, review status, promises kept */}
      <section aria-labelledby="headline-h" className="card mt-5 sm:mt-8" data-testid="headline">
        <h2 id="headline-h" className="sr-only">Headline</h2>
        <div className="grid gap-5 sm:grid-cols-[1.4fr_1fr] sm:items-end">
          <div>
            <p className="eyebrow">Value delivered</p>
            <p className="display text-6xl sm:text-7xl" data-testid="value-total">{report.value.total}</p>
            <p className="mt-1" data-testid="value-split">
              <span className="font-bold text-ok">{report.value.confirmed} confirmed</span> plus{" "}
              <span className="font-bold text-cherry">{report.value.awaiting} awaiting review</span>
            </p>
            <div className="mt-3"><ValueBar confirmed={report.value.confirmed} awaiting={report.value.awaiting} max={report.value.total} /></div>
          </div>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-1">
            <div>
              <dt className="eyebrow">Promises kept</dt>
              <dd className="display text-4xl" data-testid="promises-kept">{m.promisesKept.percent === null ? "—" : `${m.promisesKept.percent}%`}</dd>
            </div>
            <div>
              <dt className="eyebrow">Review</dt>
              <dd>
                <span className={`pill ${STATUS_STYLE[report.status]}`} data-testid="review-status">{STATUS_LABEL[report.status]}</span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="circles-h" className="mt-8">
        <h2 id="circles-h" className="text-2xl">What was delivered</h2>
        <p className="hint mb-4">One circle per delivered outcome. Bigger circle, more value.</p>
        <ValueCircles circles={report.circles} />
      </section>

      <section aria-labelledby="measures-h" className="mt-10">
        <h2 id="measures-h" className="text-2xl">Six measures</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
          <Measure label="Promises kept" m={m.promisesKept} id="promises" />
          <Measure label="High-leverage share" m={m.highLeverageShare} id="leverage" />
          <Measure label="On goal" m={m.onGoal} id="ongoal" />
          <Measure label="Claim accuracy" m={m.claimAccuracy} id="accuracy" note="Needs reviewed outcomes" />
          <Measure label="Unplanned share" m={m.unplannedShare} id="unplanned" />
          <Measure label="Rhythm" m={m.rhythm} id="rhythm" />
        </div>
      </section>

      <section aria-labelledby="eight-h" className="mt-10">
        <h2 id="eight-h" className="text-2xl">Eight weeks, by level</h2>
        <p className="hint mb-3">The mix of work, not just the total.</p>
        <div className="card"><EightWeekChart bars={report.eightWeeks} selectedWeek={report.weekStart} /></div>
      </section>

      <section aria-labelledby="dist-h" className="mt-10">
        <h2 id="dist-h" className="text-2xl">This week by level</h2>
        <Distribution bar={report.eightWeeks[report.eightWeeks.length - 1]!} />
      </section>

      <section aria-labelledby="goals-h" className="mt-10">
        <h2 id="goals-h" className="text-2xl">Weekly goals</h2>
        {report.goals.length === 0 ? (
          <p className="mt-3 text-muted">No goals were set for this week.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {report.goals.map((g) => (
              <li key={g.id} className="card">
                <p className="display text-xl">{g.text}</p>
                <p className="text-sm text-muted">Measured by: {g.measure}</p>
                <div className="mt-3"><ValueBar confirmed={g.confirmed} awaiting={g.awaiting} max={Math.max(report.value.total, 1)} /></div>
                <p className="mt-2 text-sm">
                  {g.total} points toward this goal ({g.confirmed} confirmed + {g.awaiting} awaiting review)
                  {g.sharePercent !== null && ` · ${g.sharePercent}% of the week’s value`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="days-h" className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="days-h" className="text-2xl">Day by day</h2>
            <p className="hint">Newest first: promised against delivered, with the evidence.</p>
          </div>
          <CopyButton label="Copy this week’s report" getText={() => weekReportText(report, report.ownerName)} />
        </div>
        {report.days.length === 0 ? (
          <p className="card mt-4 text-muted">No days recorded this week.</p>
        ) : (
          <div className="mt-4 space-y-6">
            {report.days.map((d) => (
              <DayCard key={d.date} day={d} isReviewer={isReviewer} userName={userName} ownerName={report.ownerName} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Measure({ label, m, id, note }: { label: string; m: MeasureView; id: string; note?: string }) {
  return (
    <div className="card !p-4" data-testid={`measure-${id}`}>
      <p className="eyebrow">{label}</p>
      <p className="display mt-1 text-4xl" data-testid={`measure-${id}-value`}>
        {m.percent === null ? <span title="Unavailable: nothing to divide by yet">—</span> : `${m.percent}%`}
      </p>
      {m.percent === null && <p className="text-sm text-muted">{note ?? "Not enough data yet"}</p>}
      <p className="mt-2 text-xs text-muted">{m.formula}</p>
    </div>
  );
}

function Distribution({ bar }: { bar: ReportView["eightWeeks"][number] }) {
  const max = Math.max(bar.total, 1);
  return (
    <div className="card mt-4 space-y-3">
      {([8, 4, 2, 1] as const).map((l) => {
        const b = bar.byLevel[l];
        return (
          <div key={l} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm">
            <span className="font-bold">{l} · {LEVEL_NAMES[l]}</span>
            <ValueBar confirmed={b.confirmed} awaiting={b.awaiting} max={max} />
            <span className="tabular-nums text-muted">{b.confirmed + b.awaiting}</span>
          </div>
        );
      })}
      <p className="hint">Solid green = confirmed, striped = awaiting review. Grouped by the points the work is worth after review.</p>
    </div>
  );
}

function DayCard({ day, isReviewer, userName, ownerName, onChanged }: { day: DayView; isReviewer: boolean; userName: string; ownerName: string; onChanged: () => void }) {
  const scale = Math.max(day.promisedPoints, day.delivered.total, 1);
  const mine = day.notes.find((n) => n.reviewer === userName);
  return (
    <article className="card" id={`day-${day.date}`} aria-labelledby={`day-h-${day.date}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`day-h-${day.date}`} className="text-2xl">{fmt(day.date, { weekday: "long", day: "numeric", month: "long" })}</h3>
        {!day.closedAt && <span className="pill border-warn text-warn">Day not closed</span>}
      </div>

      <div className="mt-4 space-y-2 text-sm" aria-label="Promised against delivered">
        <div className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3">
          <span className="text-muted">Promised</span>
          <div className="h-3 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full border border-ink" style={{ width: `${(day.promisedPoints / scale) * 100}%` }} /></div>
          <span className="tabular-nums">{day.promisedPoints}</span>
        </div>
        <div className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3">
          <span className="text-muted">Delivered</span>
          <ValueBar confirmed={day.delivered.confirmed} awaiting={day.delivered.awaiting} max={scale} />
          <span className="tabular-nums">{day.delivered.total}</span>
        </div>
      </div>

      {day.highlight && <p className="mt-4"><span className="font-bold">Most valuable:</span> {day.highlight}</p>}
      {day.learning && <p className="mt-1"><span className="font-bold">Learned:</span> {day.learning}</p>}

      <ul className="mt-5 space-y-4">
        {day.outcomes.map((o) => (
          <OutcomeRow key={o.id} o={o} isReviewer={isReviewer && Boolean(day.closedAt)} onChanged={onChanged} />
        ))}
      </ul>

      <div className="mt-5 border-t border-line pt-4">
        <p className="eyebrow">Reviewer notes</p>
        {day.notes.length === 0 && !isReviewer && <p className="mt-1 text-muted">No note for this day.</p>}
        {day.notes.map((n, i) => (
          <p key={i} className="mt-1"><span className="font-bold">{n.reviewer}:</span> {n.note}</p>
        ))}
        {isReviewer && <NoteForm date={day.date} initial={mine?.note ?? ""} onChanged={onChanged} />}
      </div>

      <div className="mt-4">
        <CopyButton label="Copy this day’s report" getText={() => dayReportText(day, ownerName)} />
      </div>
    </article>
  );
}

function OutcomeRow({ o, isReviewer, onChanged }: { o: DayOutcomeView; isReviewer: boolean; onChanged: () => void }) {
  return (
    <li id={`outcome-${o.id}`} className="rounded-xl border border-line bg-bg p-4" data-testid="day-outcome" data-state={o.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill">{o.planned ? "Planned" : "Unplanned"}</span>
        <span className="pill">Claimed {o.level} · {LEVEL_NAMES[o.level as 1 | 2 | 4 | 8]}</span>
        <span className={`pill ${o.state === "confirmed" ? "border-ok text-ok" : o.state === "awaiting" ? "border-cherry text-cherry" : ""}`} data-testid="verification">
          {verification(o)}
        </span>
      </div>
      <h4 className="display mt-2 text-xl">{o.title}</h4>
      {o.planned && <p className="mt-1 text-muted"><span className="font-bold text-ink">Expected:</span> {o.doneMeans}</p>}
      {o.status === "done" ? (
        <>
          <p className="mt-1"><span className="font-bold">Actual:</span> {o.result}</p>
          {o.proofUrl ? (
            <p className="mt-1 break-all text-sm">
              <span className="font-bold">Evidence:</span>{" "}
              <a className="text-cherry underline underline-offset-2" href={o.proofUrl} target="_blank" rel="noopener noreferrer nofollow">{o.proofUrl}</a>
            </p>
          ) : (
            <p className="mt-1 text-sm text-cherry">No valid proof link, so this scores zero.</p>
          )}
        </>
      ) : (
        <p className="mt-1">
          <span className="font-bold">{o.status === "missed" ? "Missed" : o.status === "carried" ? "Carried to tomorrow" : "Still open"}:</span> {o.reason}
        </p>
      )}
      {isReviewer && o.delivered && <ReviewForm o={o} onChanged={onChanged} />}
    </li>
  );
}

function ReviewForm({ o, onChanged }: { o: DayOutcomeView; onChanged: () => void }) {
  const initial = o.confirmedPoints ?? o.level; // default is the owner's claim
  const [points, setPoints] = useState<number>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const reviewed = o.confirmedPoints !== null;
  const unchanged = reviewed && points === o.confirmedPoints;

  return (
    <form
      className="mt-4 border-t border-line pt-4"
      aria-label={`Score “${o.title}”`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null); setSaved(false);
        const r = await api("PUT", `/api/reviews/${o.id}`, { confirmedPoints: points });
        setBusy(false);
        if (!r.ok) return setError(describeError(r.error));
        setSaved(true);
        onChanged();
      }}
    >
      <fieldset>
        <legend className="label">Confirmed points <span className="font-normal text-muted">(claim: {o.level})</span></legend>
        <div className="flex flex-wrap gap-2">
          {POINTS.map((p) => (
            <label key={p} className={`cursor-pointer rounded-full border px-4 py-2 font-bold has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-cherry ${points === p ? "border-cherry bg-cherry-soft" : "border-line bg-surface"}`}>
              <input type="radio" className="sr-only" name={`pts-${o.id}`} value={p} checked={points === p} onChange={() => { setPoints(p); setSaved(false); }} />
              {p}
            </label>
          ))}
        </div>
      </fieldset>
      <div role="alert">{error && <p className="alert alert-error mt-3">{error}</p>}</div>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy || unchanged}>
          {reviewed ? "Update score" : points === o.level ? `Confirm ${points} as claimed` : `Confirm ${points} points`}
        </button>
        <span role="status" className="text-sm text-ok">{saved ? "Saved" : ""}</span>
      </div>
    </form>
  );
}

function NoteForm({ date, initial, onChanged }: { date: string; initial: string; onChanged: () => void }) {
  const [note, setNote] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="mt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null); setSaved(false);
        const r = await api("PUT", `/api/day-notes/${date}`, { note });
        setBusy(false);
        if (!r.ok) return setError(describeError(r.error));
        setSaved(true);
        onChanged();
      }}
    >
      <label className="label" htmlFor={`note-${date}`}>Your note on this day</label>
      <textarea id={`note-${date}`} rows={2} className="field" maxLength={1000} value={note} onChange={(e) => { setNote(e.target.value); setSaved(false); }} required />
      <div role="alert">{error && <p className="alert alert-error mt-3">{error}</p>}</div>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn" disabled={busy || note.trim() === initial.trim()}>Save note</button>
        <span role="status" className="text-sm text-ok">{saved ? "Saved" : ""}</span>
      </div>
    </form>
  );
}
