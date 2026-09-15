'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Operator actions.
 *
 * All of these go through the app's own `/api/backend/*` proxy, so the browser
 * never learns the backend address and there is a single place browser-initiated
 * state changes leave the console.
 *
 * Two habits are enforced here rather than left to each call site:
 *
 * - Irreversible actions (`revoke`, `slash`) require a confirmation that names
 *   the subject. An operator approving throughput at speed is exactly who clicks
 *   the wrong row.
 * - Failures are surfaced inline and the panel is *not* optimistically updated.
 *   Showing a top-up as approved before the backend has agreed would be a lie
 *   with a settlement transaction attached.
 */

/**
 * There is no operator authentication yet — see the roadmap in the README. Until
 * there is, every action records this fixed identity so the audit log is honest
 * about the fact that attribution is currently deployment-wide rather than
 * per-person. A placeholder that looks like a real user id would be worse.
 */
const OPERATOR_ID = 'operator-console';

type Outcome = { kind: 'error' | 'ok'; message: string };

async function post(path: string, body: unknown): Promise<Outcome> {
  try {
    const response = await fetch(`/api/backend/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'error' in parsed &&
          typeof (parsed as { error?: { message?: unknown } }).error?.message === 'string'
        ) {
          message = (parsed as { error: { message: string } }).error.message;
        }
      } catch {
        // Non-JSON error body; the status above is the useful part.
      }
      return { kind: 'error', message };
    }
    return { kind: 'ok', message: 'Done.' };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Network error.' };
  }
}

function btn(variant: 'primary' | 'secondary' | 'danger', disabled: boolean): string {
  return clsx(
    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed',
    variant === 'primary' && 'bg-ink-900 text-white hover:bg-ink-800 disabled:bg-ink-300',
    variant === 'secondary' &&
      'border border-ink-300 bg-white text-ink-800 hover:bg-ink-100 disabled:text-ink-400',
    variant === 'danger' &&
      'border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 disabled:text-rose-300',
    disabled && variant !== 'primary' && 'opacity-60',
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <p
      className={clsx(
        'mt-1 text-xs',
        outcome.kind === 'ok' ? 'text-emerald-700' : 'text-rose-700',
      )}
      role="status"
    >
      {outcome.message}
    </p>
  );
}

export function MutationButton({
  label,
  path,
  body,
  variant = 'secondary',
  confirmText,
}: {
  label: string;
  path: string;
  body: unknown;
  variant?: 'primary' | 'secondary' | 'danger';
  confirmText?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run(): Promise<void> {
    if (confirmText !== undefined && !window.confirm(confirmText)) return;
    setPending(true);
    setOutcome(null);
    const result = await post(path, body);
    setPending(false);
    setOutcome(result);
    if (result.kind === 'ok') router.refresh();
  }

  return (
    <div>
      <button type="button" className={btn(variant, pending)} onClick={() => void run()} disabled={pending}>
        {pending ? 'Working…' : label}
      </button>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

/**
 * Approve or reject a top-up.
 *
 * The note is captured before the decision, not after: the audit trail should
 * record why a human approved a float move, and asking afterwards for a reason
 * that has already been acted on produces ex post justifications.
 */
export function TopUpDecisionForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function decide(approved: boolean): Promise<void> {
    setPending(approved ? 'approve' : 'reject');
    setOutcome(null);
    const result = await post(`/agents/liquidity/top-ups/${requestId}/decision`, {
      approved,
      approvedBy: OPERATOR_ID,
      ...(note.length > 0 ? { note } : {}),
    });
    setPending(null);
    setOutcome(result);
    if (result.kind === 'ok') {
      setNote('');
      router.refresh();
    }
  }

  return (
    <div className="min-w-56">
      <label className="block text-xs text-ink-500" htmlFor={`note-${requestId}`}>
        Decision note (recorded in the audit log)
      </label>
      <input
        id={`note-${requestId}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={500}
        placeholder="Why are you deciding this?"
        className="mt-1 w-full rounded-md border border-ink-300 px-2 py-1 text-xs"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={btn('primary', pending !== null)}
          onClick={() => void decide(true)}
          disabled={pending !== null}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          className={btn('danger', pending !== null)}
          onClick={() => void decide(false)}
          disabled={pending !== null}
        >
          {pending === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

/**
 * Propose a float top-up for an agent.
 *
 * Amounts are entered and sent as decimal strings, never numbers. Parsing to a
 * `number` here would lose precision before the request is even built, which is
 * the exact failure the backend's money helpers exist to prevent.
 */
export function TopUpProposeForm({ agentId, regionId }: { agentId: string; regionId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const amountValid = /^\d+(\.\d{1,7})?$/.test(amount);
  const valid = amountValid && reason.trim().length >= 4;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;
    setPending(true);
    setOutcome(null);
    const result = await post('/agents/liquidity/top-ups', {
      agentId,
      regionId,
      amount,
      reason: reason.trim(),
      requestedBy: OPERATOR_ID,
    });
    setPending(false);
    setOutcome(result);
    if (result.kind === 'ok') {
      setAmount('');
      setReason('');
      router.refresh();
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <div>
          <label className="block text-xs text-ink-500" htmlFor="topup-amount">
            Amount
          </label>
          <input
            id="topup-amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value.trim())}
            placeholder="2500.00"
            inputMode="decimal"
            className="mt-1 w-36 rounded-md border border-ink-300 px-2 py-1 font-mono text-xs"
          />
        </div>
        <div className="grow">
          <label className="block text-xs text-ink-500" htmlFor="topup-reason">
            Reason
          </label>
          <input
            id="topup-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Cash demand above forecast"
            className="mt-1 w-full rounded-md border border-ink-300 px-2 py-1 text-xs"
          />
        </div>
      </div>
      <button type="submit" className={btn('secondary', !valid || pending)} disabled={!valid || pending}>
        {pending ? 'Submitting…' : 'Submit request'}
      </button>
      <OutcomeLine outcome={outcome} />
    </form>
  );
}

/** Revoke every attestation for a subject address. */
export function RevokeAttestationForm() {
  const router = useRouter();
  const [subjectAddress, setSubjectAddress] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const valid = /^G[A-Z2-7]{10,}$/.test(subjectAddress) && reason.trim().length >= 2;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;
    if (
      !window.confirm(
        `Revoke every attestation for ${subjectAddress}? This publishes a revocation on-chain and cannot be undone here.`,
      )
    ) {
      return;
    }
    setPending(true);
    setOutcome(null);
    const result = await post('/kyc/revocations', {
      subjectAddress,
      reason: reason.trim(),
    });
    setPending(false);
    setOutcome(result);
    if (result.kind === 'ok') {
      setSubjectAddress('');
      setReason('');
      router.refresh();
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="block text-xs font-medium text-ink-600" htmlFor="revoke-address">
          Subject address
        </label>
        <input
          id="revoke-address"
          value={subjectAddress}
          onChange={(event) => setSubjectAddress(event.target.value.trim())}
          placeholder="G…"
          className="mt-1 w-full rounded-md border border-ink-300 px-2 py-1 font-mono text-xs"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-ink-600" htmlFor="revoke-reason">
          Reason
        </label>
        <input
          id="revoke-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={64}
          placeholder="sanctions_match"
          className="mt-1 w-full rounded-md border border-ink-300 px-2 py-1 text-xs"
        />
      </div>
      <div className="sm:col-span-2">
        <button type="submit" className={btn('danger', !valid || pending)} disabled={!valid || pending}>
          {pending ? 'Revoking…' : 'Revoke attestations'}
        </button>
        <OutcomeLine outcome={outcome} />
      </div>
    </form>
  );
}
