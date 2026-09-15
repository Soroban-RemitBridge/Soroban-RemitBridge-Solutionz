import type {
  AgentSummary,
  ComplianceTiers,
  Corridor,
  Preflight,
  Quote,
  TopUpRequest,
  TransferStatusResponse,
} from './types';

/**
 * Backend client.
 *
 * Every call returns a discriminated result instead of throwing. On a phone the
 * network is the least reliable part of the system, and an unhandled rejection
 * in a cash-out flow presents to the customer as a frozen screen at the exact
 * moment they are being handed money.
 *
 * `EXPO_PUBLIC_API_URL` is public by necessity: the device talks to the API
 * directly. Nothing secret may be added with that prefix.
 */

const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const TIMEOUT_MS = 12_000;

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; status: number | null };

async function request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text();

    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
        const detail = parsed.error?.message ?? parsed.error?.code;
        if (typeof detail === 'string') message = detail;
      } catch {
        // Non-JSON error body; the status is the useful part.
      }
      return { ok: false, message, status: response.status };
    }

    return { ok: true, data: (text.length > 0 ? JSON.parse(text) : null) as T };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'TimeoutError'
          ? `The service did not respond within ${TIMEOUT_MS / 1000}s. Check your connection.`
          : error.message
        : 'Unknown network error.';
    return { ok: false, message, status: null };
  }
}

export const api = {
  corridors: () => request<{ corridors: Corridor[] }>('/api/v1/corridors', { method: 'GET' }),

  complianceTiers: (corridorId: string) =>
    request<ComplianceTiers>(`/api/v1/corridors/${encodeURIComponent(corridorId)}/compliance-tiers`, {
      method: 'GET',
    }),

  quote: (corridorId: string, amount: string) =>
    request<Quote>('/api/v1/quotes', {
      method: 'POST',
      body: JSON.stringify({ corridorId, amount }),
    }),

  preflight: (corridorId: string, amount: string) =>
    request<Preflight>('/api/v1/transfers/preflight', {
      method: 'POST',
      body: JSON.stringify({ corridorId, amount }),
    }),

  transferStatus: (transferId: string) =>
    request<TransferStatusResponse>(`/api/v1/transfers/${encodeURIComponent(transferId)}/status`, {
      method: 'GET',
    }),

  agent: (agentId: string) =>
    request<AgentSummary>(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: 'GET' }),

  proposeTopUp: (input: {
    agentId: string;
    regionId: string;
    amount: string;
    reason: string;
    requestedBy: string;
  }) =>
    request<TopUpRequest>('/api/v1/agents/liquidity/top-ups', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const apiBaseUrl = API_BASE;
