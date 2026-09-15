import { NextResponse, type NextRequest } from 'next/server';

/**
 * Server-side proxy to the backend.
 *
 * Browser mutations go through here rather than straight to the API, for three
 * reasons worth stating:
 *
 * 1. The backend address stays server-only, so it is not inlined into a client
 *    bundle — a bundle is public even when the console is not.
 * 2. No CORS, so the backend can keep a restrictive origin policy instead of
 *    opening up to whichever host the console happens to be deployed on.
 * 3. There is exactly one place browser-originated state changes leave the app,
 *    which is what makes them auditable later.
 *
 * The path is joined onto the configured base rather than taken from the
 * request, so this cannot be turned into an open proxy.
 */

const API_BASE = (process.env['REMITBRIDGE_API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');

async function forward(
  request: NextRequest,
  segments: string[],
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  const target = `${API_BASE}/api/v1/${segments.join('/')}${request.nextUrl.search}`;

  try {
    const body = method === 'POST' ? await request.text() : undefined;
    const response = await fetch(target, {
      method,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: 'UPSTREAM_UNREACHABLE',
          message: error instanceof Error ? error.message : 'Backend unreachable.',
        },
      },
      { status: 502 },
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path, 'GET');
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path, 'POST');
}
