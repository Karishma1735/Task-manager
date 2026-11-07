/** Timezone helpers. Dates are YYYY-MM-DD in the app timezone; timestamps are UTC ISO strings. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset (ms) of `tz` from UTC at the given instant: local = utc + offset. */
function tzOffsetMs(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads `date` `hour`:00:00. */
export function zonedInstant(date: string, hour: number, tz: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date ${date}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0);
  let guess = wall - tzOffsetMs(new Date(wall), tz);
  guess = wall - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

export function addDays(date: string, n: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date ${date}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Monday of the week containing `date`. */
export function weekStartOf(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date ${date}`);
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay(); // 0=Sun
  return addDays(date, -((dow + 6) % 7));
}

export function isMonday(date: string): boolean {
  return isValidDate(date) && weekStartOf(date) === date;
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
