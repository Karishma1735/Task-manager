import type { CircleView } from "@/lib/report";

/** Circle diameter grows with the square root of points, so *area* tracks worth: 1→28px … 8→79px. */
export const circleSize = (points: number) => Math.round(28 * Math.sqrt(Math.max(points, 1)));

function describe(c: CircleView): string {
  if (c.state === "awaiting") return `${c.title}: ${c.points} points claimed, awaiting review`;
  if (c.points === 0) return `${c.title}: reviewer scored 0 (claimed ${c.claimed})`;
  return `${c.title}: ${c.points} points, confirmed by reviewer`;
}

export function ValueCircles({ circles }: { circles: CircleView[] }) {
  if (circles.length === 0) {
    return <p className="text-muted">Nothing delivered yet this week. Circles appear when an outcome is closed with proof.</p>;
  }
  return (
    <div>
      <ul className="flex flex-wrap items-end gap-3" aria-label="Delivered outcomes, sized by value">
        {circles.map((c) => {
          // A zero-scored outcome is drawn at its claimed size so the gap between claim and verdict stays visible.
          const size = circleSize(c.state === "confirmed" && c.points === 0 ? c.claimed : c.points);
          const cls = c.state === "awaiting" ? "circle-awaiting" : c.points === 0 ? "circle-zero" : "circle-confirmed";
          return (
            <li key={c.id}>
              <a
                href={`#outcome-${c.id}`}
                className={`circle ${cls}`}
                style={{ width: size, height: size, fontSize: size < 40 ? "0.85rem" : size < 60 ? "1.1rem" : "1.6rem" }}
                aria-label={describe(c)}
                title={describe(c)}
                data-state={c.state === "awaiting" ? "awaiting" : c.points === 0 ? "zero" : "confirmed"}
                data-testid="value-circle"
              >
                {c.points}
              </a>
            </li>
          );
        })}
      </ul>
      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Legend">
        <li className="flex items-center gap-2"><span className="circle circle-confirmed h-5 w-5" aria-hidden /> Confirmed by reviewer</li>
        <li className="flex items-center gap-2"><span className="circle circle-awaiting h-5 w-5" aria-hidden /> Awaiting review</li>
        <li className="flex items-center gap-2"><span className="circle circle-zero h-5 w-5" aria-hidden /> Reviewer scored 0</li>
        <li className="text-muted">Size = points</li>
      </ul>
    </div>
  );
}
