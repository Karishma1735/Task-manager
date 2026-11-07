export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

/** Browser helper. Same-origin fetch: the browser attaches Origin, the server checks it. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: json?.data as T };
    const e = json?.error ?? {};
    return {
      ok: false,
      error: { status: res.status, code: e.code ?? "error", message: e.message ?? "Something went wrong", issues: e.details?.issues },
    };
  } catch {
    return { ok: false, error: { status: 0, code: "network", message: "Network error. Check your connection and try again." } };
  }
}

export function describeError(e: ApiFailure): string {
  if (e.issues?.length) return e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(" · ");
  return e.message;
}
