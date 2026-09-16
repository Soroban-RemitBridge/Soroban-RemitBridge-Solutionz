/**
 * Where to send someone after they sign in.
 *
 * Only a relative path is accepted. Taking the destination from a query parameter
 * and redirecting to it verbatim is the classic way a login screen becomes a
 * phishing vector: `?next=https://evil.example/login` would send an operator to a
 * convincing copy of this page, straight after they authenticated here.
 *
 * `//host` is rejected too — protocol-relative URLs are absolute URLs wearing a
 * relative disguise.
 *
 * Shared between `middleware.ts` and the login page so the two cannot disagree
 * about which destinations are acceptable.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (value === null || value === undefined || value.length === 0) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}
