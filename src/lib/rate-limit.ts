/** Basic in-memory failed-attempt limiter (single process). */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, nowMs: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Milliseconds until another attempt is allowed, or 0 when allowed. */
  retryAfterMs(key: string, nowMs: number): number {
    const list = this.recent(key, nowMs);
    if (list.length < this.max) return 0;
    return Math.max(0, (list[0] as number) + this.windowMs - nowMs);
  }

  fail(key: string, nowMs: number): void {
    const list = this.recent(key, nowMs);
    list.push(nowMs);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
