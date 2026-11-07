/**
 * The server clock is the only clock that counts.
 * `VL_TEST_NOW` pins the clock for automated tests; it is ignored in production
 * unless VL_ALLOW_TEST_CLOCK=1 (used only by the e2e run against a production build).
 */
export type Clock = () => Date;

export const systemClock: Clock = () => {
  const pinned = process.env.VL_TEST_NOW;
  if (pinned && (process.env.NODE_ENV !== "production" || process.env.VL_ALLOW_TEST_CLOCK === "1")) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
};
