import { z } from 'zod';

/**
 * Server-side backend client.
 *
 * Every read is wrapped in a discriminated result rather than throwing. An
 * operator console that crashes its whole page because the API is briefly
 * unreachable is worse than one that says which panel failed: the person using
 * it is mid-decision about someone's cash-out float.
 *
 * The API address is read from a *server-only* variable. It is not
 * `NEXT_PUBLIC_`, so it is never inlined into a client bundle, and browser
 * mutations go through this app's `/api/backend/*` proxy instead.
 */

const API_BASE = (process.env['REMITBRIDGE_API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 8_000;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; status: number | null };

/**
 * The backend's error envelope, parsed leniently.
 *
 * The shape is `{ error: { code, message, requestId } }`, but a proxy or a
 * platform error page can put anything in front of the API, so this validates
 * rather than casts and falls back to a generic message.
 */
const errorEnvelope = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    requestId: z.string().optional(),
  }),
});

async function request<T>(
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T,
): Promise<ApiResult<T>> {
  const url = `${API_BASE}${path}`;
  try {
    const response = await fetch(url, {
      ...init,
      // Never cached: this is operational data an operator is about to act on.
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();

    if (!response.ok) {
      let message = `Backend returned ${response.status}.`;
      try {
        const parsed = errorEnvelope.safeParse(JSON.parse(text));
        if (parsed.success) {
          const { message: detail, code, requestId } = parsed.data.error;
          message = [detail ?? code ?? message, requestId ? `(request ${requestId})` : '']
            .filter(Boolean)
            .join(' ');
        }
      } catch {
        // Non-JSON error body. The status is the useful part; keep the fallback.
      }
      return { ok: false, message, status: response.status };
    }

    return { ok: true, data: parse(text.length > 0 ? JSON.parse(text) : null) };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === 'TimeoutError'
          ? `Backend did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
          : error.message
        : 'Unknown transport error.';
    return { ok: false, message: reason, status: null };
  }
}

export function apiGet<T>(path: string, parse: (body: unknown) => T): Promise<ApiResult<T>> {
  return request(`/api/v1${path}`, { method: 'GET' }, parse);
}

/** Liveness/readiness live outside `/api/v1`. */
export function apiGetRoot<T>(path: string, parse: (body: unknown) => T): Promise<ApiResult<T>> {
  return request(path, { method: 'GET' }, parse);
}

/** Narrow a result or fall back to a typed empty value, for read-only panels. */
export function orDefault<T>(result: ApiResult<T>, fallback: T): T {
  return result.ok ? result.data : fallback;
}
