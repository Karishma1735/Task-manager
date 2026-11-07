import type { WeekBar } from "@/lib/report";
import { LEVEL_NAMES } from "@/lib/scoring";

const LEVELS = [1, 2, 4, 8] as const;
const W = 640;
const H = 240;
const PAD = { top: 22, right: 8, bottom: 34, left: 34 };

const shortWeek = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

/** Stacked bars per week, split by level. Solid = confirmed, striped = awaiting review. */
export function EightWeekChart({ bars, selectedWeek }: { bars: WeekBar[]; selectedWeek: string }) {
  const max = Math.max(8, ...bars.map((b) => b.total));
  const innerH = H - PAD.top - PAD.bottom;
  const innerW = W - PAD.left - PAD.right;
  const slot = innerW / bars.length;
  const bw = Math.min(46, slot * 0.62);
  const y = (v: number) => (v / max) * innerH;
  const ticks = [0, Math.round(max / 2), max];

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-title chart-desc" className="w-full">
        <title id="chart-title">Value delivered per week, last eight weeks, by level</title>
        <desc id="chart-desc">
          {bars.map((b) => `Week of ${shortWeek(b.weekStart)}: ${b.confirmed} confirmed plus ${b.awaiting} awaiting review.`).join(" ")}
        </desc>
        <defs>
          {LEVELS.map((l) => (
            <pattern key={l} id={`await-${l}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--surface)" />
              <rect width="3" height="6" fill={`var(--lvl-${l})`} />
            </pattern>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH - y(t)} y2={PAD.top + innerH - y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.left - 6} y={PAD.top + innerH - y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{t}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = PAD.left + slot * i + (slot - bw) / 2;
          let acc = 0;
          const selected = b.weekStart === selectedWeek;
          return (
            <g key={b.weekStart} data-testid="week-bar" data-week={b.weekStart} data-total={b.total}>
              {LEVELS.flatMap((l) =>
                (["confirmed", "awaiting"] as const).map((kind) => {
                  const v = b.byLevel[l][kind];
                  if (!v) return null;
                  const top = PAD.top + innerH - y(acc + v);
                  acc += v;
                  return (
                    <rect
                      key={`${l}-${kind}`}
                      x={x}
                      y={top}
                      width={bw}
                      height={y(v)}
                      fill={kind === "confirmed" ? `var(--lvl-${l})` : `url(#await-${l})`}
                      stroke={`var(--lvl-${l})`}
                      strokeWidth="1"
                    />
                  );
                }),
              )}
              {b.total > 0 && (
                <text x={x + bw / 2} y={PAD.top + innerH - y(b.total) - 5} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--ink)">{b.total}</text>
              )}
              <text x={x + bw / 2} y={H - 12} textAnchor="middle" fontSize="11" fill={selected ? "var(--cherry)" : "var(--muted)"} fontWeight={selected ? 700 : 400}>
                {shortWeek(b.weekStart)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Chart legend">
          {LEVELS.map((l) => (
            <li key={l} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: `var(--lvl-${l})` }} aria-hidden />
              {l} {LEVEL_NAMES[l]}
            </li>
          ))}
          <li className="flex items-center gap-2 text-muted">
            <span className="stripes inline-block h-3 w-3 rounded-sm border border-muted" style={{ backgroundColor: "var(--muted)" }} aria-hidden />
            Striped = awaiting review
          </li>
        </ul>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold">View as table</summary>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full text-left text-sm">
              <caption className="sr-only">Value per week by level; confirmed plus awaiting review</caption>
              <thead>
                <tr className="text-muted">
                  <th scope="col" className="py-1 pr-3">Week of</th>
                  {LEVELS.map((l) => (<th key={l} scope="col" className="py-1 pr-3">{LEVEL_NAMES[l]}</th>))}
                  <th scope="col" className="py-1">Total</th>
                </tr>
              </thead>
              <tbody>
                {bars.map((b) => (
                  <tr key={b.weekStart} className="border-t border-line">
                    <th scope="row" className="py-1 pr-3 font-normal">{shortWeek(b.weekStart)}</th>
                    {LEVELS.map((l) => (
                      <td key={l} className="py-1 pr-3">{b.byLevel[l].confirmed + b.byLevel[l].awaiting === 0 ? "–" : `${b.byLevel[l].confirmed} + ${b.byLevel[l].awaiting}`}</td>
                    ))}
                    <td className="py-1">{b.confirmed} + {b.awaiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint mt-1">Each cell: confirmed + awaiting review.</p>
          </div>
        </details>
      </figcaption>
    </figure>
  );
}
