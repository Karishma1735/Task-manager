import { describe, expect, it } from "vitest";
import {
  claimAccuracy,
  computeReport,
  effectivePoints,
  highLeverageShare,
  isDelivered,
  isValidConfirmedPoints,
  isValidLevel,
  isValidProofUrl,
  latestReviews,
  onGoal,
  promisesKept,
  rhythm,
  toPercent,
  unplannedShare,
  valueDelivered,
  type ScoredOutcome,
  type ScoredReview,
} from "@/lib/scoring";

let nextId = 1;
const out = (o: Partial<ScoredOutcome> = {}): ScoredOutcome => ({
  id: nextId++,
  level: 4,
  planned: true,
  status: "done",
  proofUrl: "https://example.com/p",
  result: "Shipped it",
  goalId: null,
  ...o,
});
const rev = (outcomeId: number, confirmedPoints: number, updatedAt = "2026-11-09T10:00:00Z"): ScoredReview => ({ outcomeId, confirmedPoints, updatedAt });

describe("validation", () => {
  it("accepts only levels 1,2,4,8", () => {
    for (const n of [1, 2, 4, 8]) expect(isValidLevel(n)).toBe(true);
    for (const n of [0, 3, 5, 16, -1, 2.5, "4", null, undefined, NaN]) expect(isValidLevel(n)).toBe(false);
  });
  it("accepts only confirmed points 0,1,2,4,8", () => {
    for (const n of [0, 1, 2, 4, 8]) expect(isValidConfirmedPoints(n)).toBe(true);
    for (const n of [3, 6, 9, -1, "2"]) expect(isValidConfirmedPoints(n)).toBe(false);
  });
  it("accepts only http/https proof URLs", () => {
    expect(isValidProofUrl("https://a.example/x?y=1")).toBe(true);
    expect(isValidProofUrl("http://a.example")).toBe(true);
    for (const bad of ["", "   ", "ftp://a.example", "javascript:alert(1)", "data:text/html,hi", "example.com", "https://", "https://a b.example", null, 5]) {
      expect(isValidProofUrl(bad)).toBe(false);
    }
  });
});

describe("delivered", () => {
  it("done + proof + result is delivered", () => expect(isDelivered(out())).toBe(true));
  it("done without proof or with blank result is not", () => {
    expect(isDelivered(out({ proofUrl: null }))).toBe(false);
    expect(isDelivered(out({ result: "   " }))).toBe(false);
    expect(isDelivered(out({ proofUrl: "javascript:1" }))).toBe(false);
  });
  it("missed, carried and open earn zero", () => {
    for (const status of ["missed", "carried", "open"] as const) {
      expect(effectivePoints(out({ status }), new Map()).points).toBe(0);
    }
  });
});

describe("value delivered / effective points", () => {
  it("no outcomes → all zero", () => expect(valueDelivered([], [])).toEqual({ confirmed: 0, awaiting: 0, total: 0 }));

  it("before review, claimed points are awaiting, never confirmed", () => {
    const v = valueDelivered([out({ level: 8 }), out({ level: 2 })], []);
    expect(v).toEqual({ confirmed: 0, awaiting: 10, total: 10 });
  });

  it("after review uses confirmed points; mixes confirmed and awaiting", () => {
    const a = out({ level: 4 });
    const b = out({ level: 2 });
    expect(valueDelivered([a, b], [rev(a.id, 8)])).toEqual({ confirmed: 8, awaiting: 2, total: 10 });
  });

  it("reviewer score higher than claimed is honoured", () => {
    const a = out({ level: 1 });
    expect(valueDelivered([a], [rev(a.id, 8)]).confirmed).toBe(8);
  });

  it("reviewer score of zero is confirmed zero (not awaiting)", () => {
    const a = out({ level: 8 });
    const e = effectivePoints(a, latestReviews([rev(a.id, 0)]));
    expect(e).toMatchObject({ points: 0, state: "confirmed" });
    expect(valueDelivered([a], [rev(a.id, 0)])).toEqual({ confirmed: 0, awaiting: 0, total: 0 });
  });

  it("latest review wins", () => {
    const a = out({ level: 4 });
    const v = valueDelivered([a], [rev(a.id, 8, "2026-11-09T10:00:00Z"), rev(a.id, 1, "2026-11-09T12:00:00Z"), rev(a.id, 2, "2026-11-09T11:00:00Z")]);
    expect(v.confirmed).toBe(1);
  });

  it("ignores reviews on non-delivered outcomes and corrupt scores", () => {
    const missed = out({ status: "missed" });
    const a = out({ level: 2 });
    const v = valueDelivered([missed, a], [rev(missed.id, 8), rev(a.id, 3)]);
    expect(v).toEqual({ confirmed: 0, awaiting: 2, total: 2 });
  });

  it("does not depend on how many outcomes there are: eight upkeep < one multiplier is a tie, split work gains nothing beyond its points", () => {
    const eight = Array.from({ length: 8 }, () => out({ level: 1 }));
    const one = [out({ level: 8 })];
    expect(valueDelivered(eight, []).total).toBe(valueDelivered(one, []).total);
    // …and a reviewer can zero a trivial slice
    const zeroed = valueDelivered(eight, eight.map((o) => rev(o.id, 0)));
    expect(zeroed.total).toBe(0);
  });
});

describe("promises kept", () => {
  it("no committed outcomes → null, not NaN/100%", () => {
    expect(promisesKept([])).toEqual({ value: null, numerator: 0, denominator: 0 });
    expect(toPercent(promisesKept([]))).toBeNull();
  });
  it("weights by claimed points: skipping a big outcome hurts more", () => {
    const m = promisesKept([out({ level: 1 }), out({ level: 8, status: "missed" })]);
    expect(m.value).toBeCloseTo(1 / 9);
    const n = promisesKept([out({ level: 8 }), out({ level: 1, status: "missed" })]);
    expect(n.value).toBeCloseTo(8 / 9);
  });
  it("carried and open count as not kept", () => {
    const m = promisesKept([out({ level: 4 }), out({ level: 4, status: "carried" }), out({ level: 4, status: "open" })]);
    expect(m.value).toBeCloseTo(1 / 3);
  });
  it("uses claimed points even after review (reviewer cannot change promise reliability)", () => {
    const a = out({ level: 4 });
    expect(promisesKept([a]).value).toBe(1);
  });
  it("unplanned outcomes never inflate it", () => {
    const m = promisesKept([out({ level: 2, status: "missed" }), out({ level: 8, planned: false })]);
    expect(m.value).toBe(0);
    expect(m.denominator).toBe(2);
  });
  it("zero delivered value over positive commitments is 0%, not null", () => {
    expect(promisesKept([out({ level: 4, status: "missed" })]).value).toBe(0);
  });
});

describe("high-leverage share, on goal, unplanned share", () => {
  it("are null when nothing is delivered", () => {
    const o = [out({ status: "missed" })];
    expect(highLeverageShare(o, []).value).toBeNull();
    expect(onGoal(o, []).value).toBeNull();
    expect(unplannedShare(o, []).value).toBeNull();
  });
  it("are null when everything delivered was scored zero by the reviewer", () => {
    const a = out({ level: 8 });
    expect(highLeverageShare([a], [rev(a.id, 0)]).value).toBeNull();
  });
  it("high-leverage uses effective points (4 or 8)", () => {
    const a = out({ level: 8 });
    const b = out({ level: 2 });
    const c = out({ level: 4 });
    expect(highLeverageShare([a, b, c], []).value).toBeCloseTo(12 / 14);
    expect(highLeverageShare([a, b, c], [rev(a.id, 1)]).value).toBeCloseTo(4 / 7);
  });
  it("on goal counts effective points of goal-linked outcomes", () => {
    const a = out({ level: 4, goalId: 1 });
    const b = out({ level: 4 });
    expect(onGoal([a, b], []).value).toBe(0.5);
  });
  it("unplanned share counts effective points of unplanned outcomes", () => {
    const a = out({ level: 2 });
    const b = out({ level: 2, planned: false });
    expect(unplannedShare([a, b], []).value).toBe(0.5);
  });
});

describe("claim accuracy", () => {
  it("null when nothing reviewed", () => {
    expect(claimAccuracy([out()], []).value).toBeNull();
  });
  it("is confirmed ÷ claimed over reviewed outcomes only", () => {
    const a = out({ level: 8 });
    const b = out({ level: 4 });
    const c = out({ level: 2 }); // unreviewed: excluded
    expect(claimAccuracy([a, b, c], [rev(a.id, 4), rev(b.id, 4)]).value).toBeCloseTo(8 / 12);
  });
  it("exceeds 100% when the reviewer raises a score", () => {
    const a = out({ level: 2 });
    expect(claimAccuracy([a], [rev(a.id, 8)]).value).toBe(4);
  });
  it("is 0% when the reviewer zeroes everything reviewed", () => {
    const a = out({ level: 4 });
    expect(claimAccuracy([a], [rev(a.id, 0)]).value).toBe(0);
  });
});

describe("rhythm", () => {
  it("null with no committed days", () => {
    expect(rhythm([]).value).toBeNull();
    expect(rhythm([{ committed: false, committedOnTime: false, closedSameDay: false }]).value).toBeNull();
  });
  it("averages on-time commits and same-day closes over committed days", () => {
    const m = rhythm([
      { committed: true, committedOnTime: true, closedSameDay: true },
      { committed: true, committedOnTime: true, closedSameDay: false },
      { committed: true, committedOnTime: false, closedSameDay: false },
      { committed: false, committedOnTime: false, closedSameDay: false },
    ]);
    expect(m.value).toBeCloseTo(3 / 6);
  });
});

describe("computeReport", () => {
  it("handles a completely empty week without NaN", () => {
    const r = computeReport({ outcomes: [], reviews: [], days: [] });
    for (const m of [r.promisesKept, r.highLeverageShare, r.onGoal, r.claimAccuracy, r.unplannedShare, r.rhythm]) {
      expect(m.value).toBeNull();
    }
    expect(r.value.total).toBe(0);
  });
  it("composes the six measures", () => {
    const a = out({ level: 8, goalId: 1 });
    const b = out({ level: 2, status: "missed" });
    const u = out({ level: 4, planned: false });
    const r = computeReport({
      outcomes: [a, b, u],
      reviews: [rev(a.id, 4)],
      days: [{ committed: true, committedOnTime: true, closedSameDay: true }],
    });
    expect(r.value).toEqual({ confirmed: 4, awaiting: 4, total: 8 });
    expect(r.promisesKept.value).toBeCloseTo(8 / 10);
    expect(r.highLeverageShare.value).toBe(1);
    expect(r.onGoal.value).toBe(0.5);
    expect(r.claimAccuracy.value).toBe(0.5);
    expect(r.unplannedShare.value).toBe(0.5);
    expect(r.rhythm.value).toBe(1);
  });
});
