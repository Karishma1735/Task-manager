/**
 * Consistent error contract:
 *  400 malformed request (bad JSON, bad path parameter)
 *  401 not authenticated
 *  403 authenticated but not allowed (role, CSRF/origin)
 *  404 entity not found
 *  409 state conflict (already locked/closed, deadline passed, open outcomes)
 *  422 semantically invalid input or rule violation (validation, 4th outcome, past day, missing proof)
 *  429 rate limited
 *  503 feature not configured on this server
 */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;

export class ApiError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = () => new ApiError(401, "unauthorized", "Authentication required");
export const forbidden = (msg = "You are not allowed to do that") => new ApiError(403, "forbidden", msg);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const invalid = (code: string, msg: string, details?: unknown) => new ApiError(422, code, msg, details);
export const badRequest = (msg: string) => new ApiError(400, "bad_request", msg);
