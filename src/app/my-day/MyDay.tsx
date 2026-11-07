"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { LevelPicker } from "@/components/LevelPicker";
import { LogoutButton } from "@/components/LogoutButton";
import { api, describeError } from "@/lib/client-api";
import type { MyDayView } from "@/lib/ledger";
import { isValidProofUrl, LEVEL_NAMES } from "@/lib/scoring";

type Outcome = MyDayView["planned"][number];
type Goal = MyDayView["goals"][number];

const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => ReturnType<typeof api<T>>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setError(describeError(r.error));
      return null;
    }
    return r.data;
  };
  return { error, busy, run, setError };
}

function ErrorLine({ message }: { message: string | null }) {
  return (
    <div role="alert" aria-live="assertive">
      {message && <p className="alert alert-error mt-3">{message}</p>}
    </div>
  );
}

export function MyDay({ initial, userName }: { initial: MyDayView; userName: string }) {
  const [view, setView] = useState<MyDayView>(initial);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (date?: string) => {
    setLoading(true);
    const r = await api<MyDayView>("GET", `/api/my-day${date ? `?date=${date}` : ""}`);
    setLoading(false);
    if (r.ok) setView(r.data);
  }, []);
  const refresh = useCallback(() => load(view.date), [load, view.date]);

  const { day, planned, unplanned } = view;
  const isToday = view.date === view.today;
  const committed = Boolean(day.lockedAt);
  const closed = Boolean(day.closedAt);
  const pastDeadline = !committed && !view.canCommit;

  return (
    <main id="main" className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Value Ledger · {userName}</p>
          <h1 className="mt-2 text-4xl sm:text-5xl">My day</h1>
          <p className="mt-1 text-muted" data-testid="date-label">{longDate(view.date)}</p>
        </div>
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link className="btn btn-quiet" href="/report">Report</Link>
          <LogoutButton />
        </nav>
      </header>

      <div role="tablist" aria-label="Day" className="mt-8 inline-flex rounded-full border border-line bg-surface p-1">
        {[
          { d: view.today, label: "Today" },
          { d: view.tomorrow, label: "Tomorrow" },
        ].map((t) => (
          <button
            key={t.d}
            role="tab"
            aria-selected={view.date === t.d}
            onClick={() => load(t.d)}
            className={`rounded-full px-5 py-2 font-bold ${view.date === t.d ? "bg-cherry text-[var(--cherry-ink)]" : "text-muted hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="alert alert-note mt-6">
          {notice}{" "}
          <button className="btn-quiet underline" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      <div className={`mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] ${loading ? "opacity-70" : ""}`} aria-busy={loading}>
        <div className="space-y-8">
          {view.overdue.length > 0 && (
            <section aria-labelledby="overdue-h" className="card border-cherry">
              <h2 id="overdue-h" className="text-2xl">Still open from earlier</h2>
              <p className="hint mt-1">These were promised and are not closed yet. Close each one honestly.</p>
              <ul className="mt-5 space-y-4">
                {view.overdue.map((o) => (
                  <OutcomeCard key={o.id} o={o} view={view} onChange={refresh} onNotice={setNotice} showDate />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="plan-h">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="plan-h" className="text-3xl">{isToday ? "Today’s promises" : "Tomorrow’s plan"}</h2>
              <p className="hint">
                {committed
                  ? `Committed ${new Date(day.lockedAt!).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: view.tz })} · locked`
                  : `Commit by ${String(view.commitByHour).padStart(2, "0")}:00 (${view.tz})`}
              </p>
            </div>

            {pastDeadline && isToday && (
              <p className="alert alert-note mt-4" role="status">
                The {String(view.commitByHour).padStart(2, "0")}:00 commit deadline has passed, so today’s plan can’t be committed.
                Your unplanned work still counts when it has proof — and you can plan tomorrow.
              </p>
            )}

            {planned.length === 0 && !committed && (
              <p className="card mt-4 text-muted">
                Nothing promised yet. Add up to three outcomes you will be able to prove by the end of the day.
              </p>
            )}

            <ul className="mt-4 space-y-4">
              {planned.map((o) => (
                <OutcomeCard key={o.id} o={o} view={view} onChange={refresh} onNotice={setNotice} />
              ))}
            </ul>

            {!committed && !closed && !(pastDeadline && isToday) && (
              <>
                {planned.length < 3 ? (
                  <DraftForm key={`add-${planned.length}`} view={view} onSaved={refresh} />
                ) : (
                  <p className="hint mt-4">That is the most a day can hold. Value over volume.</p>
                )}
                {planned.length > 0 && <CommitBar view={view} onCommitted={refresh} />}
              </>
            )}
          </section>

          <section aria-labelledby="unplanned-h">
            <h2 id="unplanned-h" className="text-3xl">Unplanned work</h2>
            <p className="hint mt-1">Urgent work that wasn’t in the plan. It counts only because it has proof, and it never counts toward promises kept.</p>
            {unplanned.length > 0 && (
              <ul className="mt-4 space-y-3">
                {unplanned.map((o) => (
                  <li key={o.id} className="rounded-xl border border-dashed border-muted bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="pill">Unplanned</span>
                      <span className="pill">{o.level} · {LEVEL_NAMES[o.level as 1 | 2 | 4 | 8]}</span>
                      <span className="pill">{view.confirmedPoints[o.id] !== undefined ? `Confirmed ${view.confirmedPoints[o.id]}` : "Awaiting review"}</span>
                    </div>
                    <p className="display mt-2 text-xl">{o.title}</p>
                    <p className="mt-1">{o.result}</p>
                    <ProofLink url={o.proofUrl} />
                  </li>
                ))}
              </ul>
            )}
            {isToday && !closed && <UnplannedForm view={view} onSaved={refresh} />}
          </section>

          {isToday && (
            <CloseDayForm view={view} onClosed={refresh} />
          )}
        </div>

        <aside className="space-y-8" aria-label="Goals and summary">
          <GoalsPanel view={view} onSaved={refresh} />
          <SummaryPanel view={view} />
        </aside>
      </div>
    </main>
  );
}

function ProofLink({ url }: { url: string | null }) {
  if (!url || !isValidProofUrl(url)) return null;
  return (
    <p className="mt-1 break-all text-sm">
      Proof:{" "}
      <a className="text-cherry underline underline-offset-2" href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>
    </p>
  );
}

function LevelBadge({ level }: { level: number }) {
  return (
    <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border-2 border-cherry bg-cherry-soft" aria-label={`Level ${level}, ${LEVEL_NAMES[level as 1 | 2 | 4 | 8]}`}>
      <span className="display text-2xl leading-none">{level}</span>
      <span className="text-[0.58rem] font-bold uppercase tracking-normal">{LEVEL_NAMES[level as 1 | 2 | 4 | 8]}</span>
    </div>
  );
}

function OutcomeCard({
  o,
  view,
  onChange,
  onNotice,
  showDate,
}: {
  o: Outcome;
  view: MyDayView;
  onChange: () => void;
  onNotice: (m: string | null) => void;
  showDate?: boolean;
}) {
  const goal = view.goals.find((g) => g.id === o.goalId);
  const committed = Boolean(view.day.lockedAt) || o.date !== view.date;
  const [editing, setEditing] = useState(false);
  const del = useAction();

  if (editing) {
    return (
      <li>
        <DraftForm view={view} initial={o} onSaved={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />
      </li>
    );
  }

  const stateLabel =
    o.status === "done"
      ? view.confirmedPoints[o.id] !== undefined
        ? `Confirmed ${view.confirmedPoints[o.id]} points`
        : `Awaiting review · ${o.level} claimed`
      : o.status === "open"
        ? committed ? "Open" : "Draft"
        : o.status === "missed" ? "Missed · scores 0" : "Carried · scores 0";

  return (
    <li className="card" data-testid="outcome" data-status={o.status}>
      <div className="flex gap-4">
        <LevelBadge level={o.level} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${o.status === "done" ? "border-ok text-ok" : ""}`}>{stateLabel}</span>
            {showDate && <span className="pill">{o.date}</span>}
            {goal && <span className="pill">Goal: {goal.text}</span>}
            {o.carriedFrom && <span className="pill">Carried over</span>}
          </div>
          <h3 className="mt-2 text-2xl">{o.title}</h3>
          <p className="mt-1 text-muted"><span className="font-bold text-ink">Done means:</span> {o.doneMeans}</p>
        </div>
      </div>

      {o.status === "done" && (
        <div className="mt-4 border-t border-line pt-4">
          <p>{o.result}</p>
          <ProofLink url={o.proofUrl} />
        </div>
      )}
      {(o.status === "missed" || o.status === "carried") && o.reason && (
        <p className="mt-4 border-t border-line pt-4"><span className="font-bold">Reason:</span> {o.reason}</p>
      )}

      {!committed && o.status === "open" && (
        <div className="mt-4 flex gap-2 border-t border-line pt-4">
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button
            className="btn"
            disabled={del.busy}
            onClick={async () => {
              if (await del.run(() => api("DELETE", `/api/outcomes/${o.id}`))) onChange();
            }}
          >
            Remove
          </button>
          <ErrorLine message={del.error} />
        </div>
      )}

      {committed && o.status === "open" && o.date <= view.today && (
        <CloseForm o={o} onClosed={(note) => { onNotice(note); onChange(); }} />
      )}
      {committed && o.status === "open" && o.date > view.today && (
        <p className="hint mt-4 border-t border-line pt-4">Locked. You can close this on its day.</p>
      )}
    </li>
  );
}

function DraftForm({
  view,
  initial,
  onSaved,
  onCancel,
}: {
  view: MyDayView;
  initial?: Outcome;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [doneMeans, setDoneMeans] = useState(initial?.doneMeans ?? "");
  const [level, setLevel] = useState<number | null>(initial?.level ?? null);
  const [goalId, setGoalId] = useState<number | null>(initial?.goalId ?? null);
  const a = useAction();
  const idp = initial ? `edit-${initial.id}` : "new";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { title, doneMeans, level, goalId };
    const r = await a.run(() =>
      initial ? api("PATCH", `/api/outcomes/${initial.id}`, body) : api("POST", `/api/days/${view.date}/outcomes`, body),
    );
    if (r) {
      if (!initial) { setTitle(""); setDoneMeans(""); setLevel(null); setGoalId(null); }
      onSaved();
    }
  }

  return (
    <form onSubmit={submit} className="card mt-4 space-y-5" aria-label={initial ? "Edit outcome" : "Add outcome"}>
      <h3 className="text-xl">{initial ? "Edit outcome" : "Add an outcome"}</h3>
      <div>
        <label className="label" htmlFor={`${idp}-title`}>Title</label>
        <input id={`${idp}-title`} className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required />
      </div>
      <div>
        <label className="label" htmlFor={`${idp}-done`}>Done means…</label>
        <textarea id={`${idp}-done`} className="field" rows={2} value={doneMeans} onChange={(e) => setDoneMeans(e.target.value)} maxLength={500} required aria-describedby={`${idp}-done-h`} />
        <p id={`${idp}-done-h`} className="hint mt-1">A line anyone could check. “Published with 10 actions”, not “work on plug”.</p>
      </div>
      <LevelPicker name={`${idp}-level`} value={level} onChange={setLevel} />
      <div>
        <label className="label" htmlFor={`${idp}-goal`}>Weekly goal <span className="font-normal text-muted">(optional)</span></label>
        <select id={`${idp}-goal`} className="field" value={goalId ?? ""} onChange={(e) => setGoalId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No weekly goal</option>
          {view.goals.map((g: Goal) => (
            <option key={g.id} value={g.id}>{g.text}</option>
          ))}
        </select>
      </div>
      <ErrorLine message={a.error} />
      <div className="flex gap-3">
        <button className="btn btn-primary" disabled={a.busy || level === null}>{initial ? "Save changes" : "Add outcome"}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function CommitBar({ view, onCommitted }: { view: MyDayView; onCommitted: () => void }) {
  const a = useAction();
  return (
    <div className="card mt-6 flex flex-wrap items-center justify-between gap-4 border-cherry">
      <p className="max-w-md">
        Committing stamps the server time and <strong>locks</strong> titles, definitions and levels. They can only be closed, never edited.
      </p>
      <div>
        <button
          className="btn btn-primary"
          disabled={a.busy || !view.canCommit}
          onClick={async () => {
            if (await a.run(() => api("POST", `/api/days/${view.date}/commit`))) onCommitted();
          }}
        >
          {a.busy ? "Committing…" : "Commit plan"}
        </button>
      </div>
      <div className="w-full"><ErrorLine message={a.error} /></div>
    </div>
  );
}

type Mode = "done" | "missed" | "carried";

function CloseForm({ o, onClosed }: { o: Outcome; onClosed: (note: string | null) => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [proofUrl, setProofUrl] = useState("");
  const [result, setResult] = useState("");
  const [reason, setReason] = useState("");
  const a = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!mode) return;
    const body = mode === "done" ? { status: "done", proofUrl, result } : { status: mode, reason };
    const r = await a.run(() => api<{ carryNote: string | null }>("POST", `/api/outcomes/${o.id}/close`, body));
    if (r) onClosed(r.carryNote ?? null);
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div role="group" aria-label={`Close “${o.title}”`} className="flex flex-wrap gap-2">
        {([["done", "Done"], ["missed", "Missed"], ["carried", "Carry to tomorrow"]] as const).map(([m, label]) => (
          <button key={m} type="button" className={`btn ${mode === m ? "btn-primary" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode && (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {mode === "done" ? (
            <>
              <div>
                <label className="label" htmlFor={`proof-${o.id}`}>Proof link</label>
                <input id={`proof-${o.id}`} type="url" inputMode="url" placeholder="https://" className="field" value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} required />
              </div>
              <div>
                <label className="label" htmlFor={`result-${o.id}`}>What changed?</label>
                <textarea id={`result-${o.id}`} rows={2} className="field" value={result} onChange={(e) => setResult(e.target.value)} maxLength={1000} required />
                <p className="hint mt-1">One or two sentences. Without proof and a note, it scores zero.</p>
              </div>
            </>
          ) : (
            <div>
              <label className="label" htmlFor={`reason-${o.id}`}>{mode === "missed" ? "Why was it missed?" : "Why carry it to tomorrow?"}</label>
              <textarea id={`reason-${o.id}`} rows={2} className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
              <p className="hint mt-1">Either way it scores zero today.</p>
            </div>
          )}
          <ErrorLine message={a.error} />
          <button className="btn btn-primary" disabled={a.busy}>
            {mode === "done" ? "Close as done" : mode === "missed" ? "Close as missed" : "Carry to tomorrow"}
          </button>
        </form>
      )}
    </div>
  );
}

function UnplannedForm({ view, onSaved }: { view: MyDayView; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [result, setResult] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const a = useAction();

  if (!open) {
    return <button className="btn mt-4" onClick={() => setOpen(true)}>Log unplanned work</button>;
  }
  return (
    <form
      className="card mt-4 space-y-5"
      aria-label="Log unplanned work"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await a.run(() => api("POST", `/api/days/${view.date}/unplanned`, { title, level, result, proofUrl }))) {
          setTitle(""); setLevel(null); setResult(""); setProofUrl(""); setOpen(false);
          onSaved();
        }
      }}
    >
      <div>
        <label className="label" htmlFor="un-title">Title</label>
        <input id="un-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required />
      </div>
      <LevelPicker name="un-level" value={level} onChange={setLevel} />
      <div>
        <label className="label" htmlFor="un-result">Actual result</label>
        <textarea id="un-result" rows={2} className="field" value={result} onChange={(e) => setResult(e.target.value)} maxLength={1000} required />
      </div>
      <div>
        <label className="label" htmlFor="un-proof">Proof link</label>
        <input id="un-proof" type="url" inputMode="url" placeholder="https://" className="field" value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} required />
      </div>
      <ErrorLine message={a.error} />
      <div className="flex gap-3">
        <button className="btn btn-primary" disabled={a.busy || level === null}>Log unplanned work</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function CloseDayForm({ view, onClosed }: { view: MyDayView; onClosed: () => void }) {
  const [highlight, setHighlight] = useState("");
  const [learning, setLearning] = useState("");
  const a = useAction();
  const { day, summary } = view;

  if (day.closedAt) {
    return (
      <section aria-labelledby="closed-h" className="card">
        <h2 id="closed-h" className="text-3xl">Day closed</h2>
        <p className="hint">Closed {new Date(day.closedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: view.tz })}</p>
        <p className="mt-4"><span className="font-bold">Most valuable thing delivered:</span> {day.highlight}</p>
        {day.learning && <p className="mt-2"><span className="font-bold">Learned:</span> {day.learning}</p>}
      </section>
    );
  }

  const draftPending = !day.lockedAt && view.planned.length > 0;
  const ready = summary.allResolved && !draftPending;

  return (
    <section aria-labelledby="close-h">
      <h2 id="close-h" className="text-3xl">Close the day</h2>
      <form
        className="card mt-4 space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await a.run(() => api("POST", `/api/days/${view.date}/close`, { highlight, learning: learning || null }))) onClosed();
        }}
      >
        {!ready && (
          <p className="hint" id="close-hint">
            {draftPending ? "Commit (or remove) your draft plan first." : "This unlocks once every committed outcome is closed as done, missed or carried."}
          </p>
        )}
        <fieldset disabled={!ready} className="space-y-5 disabled:opacity-60">
          <div>
            <label className="label" htmlFor="highlight">Most valuable thing delivered today</label>
            <textarea id="highlight" rows={2} className="field" value={highlight} onChange={(e) => setHighlight(e.target.value)} maxLength={500} required />
          </div>
          <div>
            <label className="label" htmlFor="learning">One thing learned <span className="font-normal text-muted">(optional)</span></label>
            <textarea id="learning" rows={2} className="field" value={learning} onChange={(e) => setLearning(e.target.value)} maxLength={500} />
          </div>
        </fieldset>
        <ErrorLine message={a.error} />
        <button className="btn btn-primary" disabled={!ready || a.busy}>Close the day</button>
      </form>
    </section>
  );
}

function GoalsPanel({ view, onSaved }: { view: MyDayView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<{ id?: number; text: string; measure: string }[]>([]);
  const a = useAction();

  const start = () => {
    setRows(view.goals.length ? view.goals.map((g) => ({ id: g.id, text: g.text, measure: g.measure })) : [{ text: "", measure: "" }]);
    setEditing(true);
  };

  return (
    <section aria-labelledby="goals-h" className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="goals-h" className="text-2xl">Weekly goals</h2>
        {!editing && <button className="btn btn-quiet" onClick={start}>{view.goals.length ? "Edit" : "Set goals"}</button>}
      </div>
      <p className="hint">Week of {view.weekStart}</p>
      {!editing ? (
        view.goals.length === 0 ? (
          <p className="mt-3 text-muted">No goals set for this week.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {view.goals.map((g) => (
              <li key={g.id}>
                <p className="display text-lg">{g.text}</p>
                <p className="text-sm text-muted">Measured by: {g.measure}</p>
              </li>
            ))}
          </ul>
        )
      ) : (
        <form
          className="mt-4 space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const cleaned = rows.filter((r) => r.text.trim() || r.measure.trim());
            if (await a.run(() => api("PUT", `/api/goals/${view.weekStart}`, { goals: cleaned }))) {
              setEditing(false);
              onSaved();
            }
          }}
        >
          {rows.map((r, i) => (
            <div key={i} className="space-y-2">
              <label className="label" htmlFor={`g-text-${i}`}>Goal {i + 1}</label>
              <input id={`g-text-${i}`} className="field" value={r.text} maxLength={200} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <label className="label" htmlFor={`g-measure-${i}`}>Measured by</label>
              <input id={`g-measure-${i}`} className="field" value={r.measure} maxLength={300} placeholder="Published with 10 actions, used in 5 flows" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, measure: e.target.value } : x)))} />
            </div>
          ))}
          {rows.length < 3 && (
            <button type="button" className="btn" onClick={() => setRows([...rows, { text: "", measure: "" }])}>Add a goal</button>
          )}
          <ErrorLine message={a.error} />
          <div className="flex gap-3">
            <button className="btn btn-primary" disabled={a.busy}>Save goals</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function SummaryPanel({ view }: { view: MyDayView }) {
  const { summary, day } = view;
  const committed = Boolean(day.lockedAt);
  const dv = summary.deliveredPoints;
  return (
    <section aria-labelledby="summary-h" className="card">
      <h2 id="summary-h" className="text-2xl">Daily summary</h2>
      <dl className="mt-4 space-y-4">
        <div>
          <dt className="eyebrow">Value delivered</dt>
          <dd className="display text-5xl" data-testid="value-delivered">{dv.total}</dd>
          <dd className="hint" data-testid="value-breakdown">{dv.confirmed} confirmed plus {dv.awaiting} awaiting review</dd>
        </div>
        <div>
          <dt className="eyebrow">Promised</dt>
          <dd className="text-xl">{committed ? `${summary.promisedPoints} points` : "Not committed yet"}</dd>
        </div>
        <div>
          <dt className="eyebrow">Promises kept</dt>
          <dd className="text-xl" data-testid="promises-kept">{summary.promisesKept === null ? "Not available yet" : `${summary.promisesKept}%`}</dd>
          <dd className="hint">Delivered promised points ÷ promised points</dd>
        </div>
        {summary.unplannedPoints > 0 && (
          <div>
            <dt className="eyebrow">Unplanned (not in promises kept)</dt>
            <dd className="text-xl">{summary.unplannedPoints} points</dd>
          </div>
        )}
      </dl>
      {view.reviewerNotes.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="eyebrow">Reviewer note</p>
          {view.reviewerNotes.map((n, i) => (<p key={i} className="mt-1">{n.note}</p>))}
        </div>
      )}
    </section>
  );
}
