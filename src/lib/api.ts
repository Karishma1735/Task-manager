import { NextResponse } from "next/server";
import { getDb, type Db } from "@/db";
import { readCookie, requireRole, getSessionUser, SESSION_COOKIE, type Actor, type Role } from "@/lib/auth";
import { systemClock } from "@/lib/clock";
import { ApiError, badRequest, forbidden } from "@/lib/errors";
import { kickOutbox } from "@/lib/outbox";
import { assertScheduledAuth } from "@/lib/scheduled-auth";
export { parseBody } from "@/lib/validate";

export interface Ctx {
  req: Request;
  db: Db;
  now: Date;
  actor: Actor;
  params: Record<string, string>;
  json: () => Promise<unknown>;
}

export function ok(data: unknown, status = 200, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ data }, { status, headers });
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } },
      { status: e.status },
    );
  }
  // Log only the kind of failure. Database errors carry the failed SQL *with its parameters*
  // (work titles, proof links…), and the host keeps logs, so never print the error object itself.
  const code = (e as { code?: unknown } | null)?.code;
  console.error("Unhandled API error:", e instanceof Error ? e.name : typeof e, typeof code === "string" ? code : "");
  return NextResponse.json({ error: { code: "internal", message: "Internal server error" } }, { status: 500 });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence: every mutation must come from the same origin.
 * Cookies are also SameSite=Lax; this is the second, strict layer.
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers.get("sec-fetch-site") === "cross-site") throw forbidden("Cross-site request rejected");
  const origin = req.headers.get("origin");
  if (!origin) throw forbidden("Missing Origin header");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("Invalid Origin header");
  }
  const allowed = new Set<string>();
  allowed.add(new URL(req.url).host);
  const host = req.headers.get("host");
  if (host) allowed.add(host);
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd) allowed.add(fwd.split(",")[0]!.trim());
  // Behind a hosting proxy the Host header may be an internal name; the app's own public address is always allowed.
  const base = process.env.APP_BASE_URL?.trim();
  if (base) {
    try {
      allowed.add(new URL(base).host);
    } catch {
      /* ignore a malformed APP_BASE_URL */
    }
  }
  if (!allowed.has(originHost)) throw forbidden("Cross-origin request rejected");
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

type RouteContext = { params?: Promise<Record<string, string>> };

/** Wrap a route handler with origin check, authentication, role authorization and error mapping. */
export function route(roles: Role[] | "public", fn: (c: Ctx) => Promise<NextResponse> | NextResponse) {
  return async (req: Request, rc?: RouteContext): Promise<NextResponse> => {
    try {
      assertSameOrigin(req);
      const db = getDb();
      const now = systemClock();
      let actor: Actor | null = null;
      if (roles !== "public") {
        actor = requireRole(
          getSessionUser(db, readCookie(req.headers.get("cookie"), SESSION_COOKIE), now),
          ...roles,
        );
      }
      const params = (await rc?.params) ?? {};
      const res = await fn({ req, db, now, actor: actor as Actor, params, json: () => readJson(req) });
      // Deliver queued events only *after* the business transaction has committed; never awaited.
      if (res.status < 400 && !SAFE_METHODS.has(req.method)) kickOutbox(db, systemClock);
      return res;
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

export interface TokenCtx {
  req: Request;
  db: Db;
  now: Date;
  json: () => Promise<unknown>;
}

/**
 * Routes called by viaSocket's scheduled flows. Authenticated only by the REMINDER_TOKEN header
 * (no cookie, so there is no ambient credential for a cross-site request to ride on — no Origin check).
 */
export function tokenRoute(fn: (c: TokenCtx) => Promise<NextResponse> | NextResponse) {
  return async (req: Request): Promise<NextResponse> => {
    try {
      const now = systemClock();
      assertScheduledAuth(req, now);
      return await fn({ req, db: getDb(), now, json: () => readJson(req) });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
