import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Shared presentation primitives.
 *
 * Kept deliberately plain and dependency-free: the value here is that every
 * status colour and every "we could not load this" message comes from one place.
 * A panel that invents its own amber for `SUSPENDED` is how a suspended agent
 * ends up looking like a warning rather than a stop.
 */

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  // `| undefined` throughout: `exactOptionalPropertyTypes` is on, so an optional
  // prop that a caller forwards from a possibly-undefined value needs the wider
  // type to stay assignable.
  title?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={clsx('rounded-lg border border-ink-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: Exclude<Tone, 'info'> | undefined;
}) {
  const toneClasses: Record<Exclude<Tone, 'info'>, string> = {
    neutral: 'text-ink-900',
    good: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-rose-700',
  };
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-xl font-semibold tabular-nums', toneClasses[tone])}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 border-ink-200',
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-rose-50 text-rose-700 border-rose-200',
  info: 'bg-sky-50 text-sky-700 border-sky-200',
};

/**
 * One status vocabulary for the whole console.
 *
 * `SUSPENDED` and `REVOKED` are both terminal-ish and both bad; `PENDING` and
 * `APPROVED` want different treatment from an operator than from an agent. The
 * mapping lives here so two panels cannot disagree about what "amber" means.
 */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: Tone | undefined;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'AUTHORIZED':
    case 'ACTIVE':
    case 'CLAIMED':
    case 'EXECUTED':
    case 'RESOLVED':
      return 'good';
    case 'PENDING':
    case 'OPEN':
    case 'ACKNOWLEDGED':
    case 'APPROVED':
      return 'warn';
    case 'SUSPENDED':
    case 'REVOKED':
    case 'FAILED':
    case 'REJECTED':
      return 'bad';
    case 'REFUNDED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'neutral';
    default:
      return 'info';
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="min-w-full divide-y divide-ink-100 text-sm">
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="whitespace-nowrap px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">{children}</tbody>
      </table>
    </div>
  );
}

/** A parseable cell value; amounts and ids are monospaced to aid comparison. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs tabular-nums text-ink-800">{children}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <div className="rounded-md border border-dashed border-ink-200 px-5 py-8 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * Shown when the backend is unreachable.
 *
 * Distinguished from an empty state on purpose: "no alerts" and "we could not ask
 * whether there are alerts" must never look the same on a compliance screen. The
 * backend's own message is included, since it usually names the missing piece.
 */
/**
 * Shown where a control would be, when the operator's role cannot use it.
 *
 * Explaining the absence is better than an empty cell: an operator who cannot find
 * the Approve button needs to know whether the request is awaiting someone else,
 * or whether their own account lacks the permission.
 */
export function PermissionNote({ permission, action }: { permission: string; action: string }) {
  return (
    <p className="text-xs text-ink-500">
      Your role cannot {action} ({permission}). Ask an administrator.
    </p>
  );
}

export function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 px-5 py-4">
      <p className="text-sm font-semibold text-rose-800">{title}</p>
      <p className="mt-1 text-xs text-rose-700">{message}</p>
      <p className="mt-2 text-xs text-rose-600">
        This panel is showing nothing rather than a default value: an unknown figure must not read as
        a real one.
      </p>
    </div>
  );
}

export function DefinitionList({ items }: { items: { term: string; detail: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.term}>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{item.term}</dt>
          <dd className="mt-0.5 text-sm text-ink-800">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
