import { z } from "zod";
import { clientIp, ok, parseBody, route } from "@/lib/api";
import { login, sessionCookie } from "@/lib/auth";

const schema = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).strict();

export const POST = route("public", async ({ req, db, now, json }) => {
  const body = parseBody(schema, await json());
  const r = await login(db, { ...body, ip: clientIp(req) }, now);
  return ok({ user: r.user }, 200, { "Set-Cookie": sessionCookie(r.token, r.expiresAt) });
});
