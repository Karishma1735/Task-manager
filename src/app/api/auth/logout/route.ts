import { ok, route } from "@/lib/api";
import { clearedSessionCookie, logout, readCookie, SESSION_COOKIE } from "@/lib/auth";

export const POST = route("public", ({ req, db, now }) => {
  logout(db, readCookie(req.headers.get("cookie"), SESSION_COOKIE), now);
  return ok({ loggedOut: true }, 200, { "Set-Cookie": clearedSessionCookie() });
});
