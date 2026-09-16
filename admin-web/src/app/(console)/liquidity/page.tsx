import Link from 'next/link';

import { MutationButton, TopUpDecisionForm } from '@/components/actions';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Mono,
  PermissionNote,
  StatCard,
  StatusBadge,
  Table,
} from '@/components/ui';
import { currentOperatorCan } from '@/lib/auth/current';
import { endpoints } from '@/lib/endpoints';
import { formatBps, formatDateTime, formatStroops, formatRelative, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Liquidity.
 *
 * Region-scoped because the pool is: float is drawn against a regional hub, and a
 * network-wide utilisation figure would hide the one region that is actually
 * short of cash. The region selector is therefore always visible, including when
 * only one region exists — a number whose scope is implicit is a number people
 * misread.
 */
export default async function LiquidityPage({
  searchParams,
}: {
  searchParams: Promise<{ regionId?: string }>;
}) {
  const { regionId: requestedRegion } = await searchParams;
  // Read once for the page: rendering a decision form to a role that cannot decide
  // produces a 403 after a confirmation dialog.
  const [mayDecide, mayExecute] = await Promise.all([
    currentOperatorCan('liquidity:decide'),
    currentOperatorCan('liquidity:execute'),
  ]);
  const corridors = await endpoints.corridors();

  const regions = corridors.ok
    ? [...new Map(corridors.data.corridors.map((corridor) => [corridor.region.id, corridor.region])).values()]
    : [];

  const selected = requestedRegion ?? regions[0]?.id;

  const [pool, alerts, topUps] = await Promise.all([
    selected !== undefined
      ? endpoints.poolHealth(selected)
      : Promise.resolve({ ok: false as const, message: 'No region is configured.', status: null }),
    endpoints.alerts('OPEN'),
    endpoints.topUps(),
  ]);

  const pending = topUps.ok ? topUps.data.requests.filter((row) => row.status === 'PENDING') : [];
  const approved = topUps.ok ? topUps.data.requests.filter((row) => row.status === 'APPROVED') : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Liquidity</h1>
        <p className="mt-1 text-sm text-ink-600">
          Regional pool health and the top-up queue. Float is drawn against an agent&rsquo;s bonded
          collateral, and a draw the bond cannot cover is refused by the contract — not by this
          console.
        </p>
      </div>

      <Card title="Region" description="Utilisation below is scoped to the region you select.">
        {!corridors.ok ? (
          <ErrorState title="Could not load regions" message={corridors.message} />
        ) : regions.length === 0 ? (
          <EmptyState
            title="No regions configured"
            hint="Regions and corridors are seeded by the deployment script before agents can register."
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {regions.map((region) => (
              <Link
                key={region.id}
                href={`/liquidity?regionId=${encodeURIComponent(region.id)}`}
                className={`rounded-md border px-3 py-1.5 text-xs ${
                  selected === region.id
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-300 text-ink-700'
                }`}
              >
                {region.displayName} <span className="opacity-70">({region.id})</span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {pool.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total deposited"
            value={formatStroops(pool.data.pool.totalDeposited)}
            hint={`${pool.data.region.currency} float supplied`}
          />
          <StatCard label="Total drawn" value={formatStroops(pool.data.pool.totalDrawn)} tone="neutral" />
          <StatCard
            label="Available"
            value={formatStroops(pool.data.pool.available)}
            tone={BigInt(pool.data.pool.available) <= 0n ? 'bad' : 'good'}
            hint="Undrawn and available to agents"
          />
          <StatCard
            label="Utilisation"
            value={formatBps(pool.data.pool.utilizationBps)}
            tone={
              pool.data.pool.utilizationBps >= 8_000
                ? 'bad'
                : pool.data.pool.utilizationBps >= 6_000
                  ? 'warn'
                  : 'good'
            }
            hint={
              pool.data.pool.stale
                ? 'No snapshot captured yet — figures are unknown, not zero'
                : `Snapshot ${formatRelative(pool.data.pool.capturedAt)}`
            }
          />
        </div>
      ) : (
        <ErrorState title="Pool health unavailable" message={pool.message} />
      )}

      <Card
        title="Top-up requests awaiting a decision"
        description="Approval and execution are separate steps on purpose: a human decides, a machine acts."
      >
        {!topUps.ok ? (
          <ErrorState title="Could not load top-up requests" message={topUps.message} />
        ) : pending.length === 0 ? (
          <EmptyState title="Nothing is waiting for approval" />
        ) : (
          <Table headers={['Agent', 'Region', 'Amount', 'Requested by', 'Reason', 'Raised', 'Decision']}>
            {pending.map((request) => (
              <tr key={request.id} className="align-top">
                <td className="px-5 py-3 font-medium text-ink-800">
                  {request.agent?.tradingName ?? request.agent?.legalName ?? request.agentId}
                </td>
                <td className="px-5 py-3 text-ink-700">{request.regionId}</td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(request.amountRequested)}</Mono>
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">{request.requestedBy}</td>
                <td className="max-w-xs px-5 py-3 text-xs text-ink-600">{request.reason}</td>
                <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(request.createdAt)}</td>
                <td className="px-5 py-3">
                  {mayDecide ? (
                    <TopUpDecisionForm requestId={request.id} />
                  ) : (
                    <PermissionNote permission="liquidity:decide" action="decide a top-up" />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {approved.length > 0 && (
        <Card
          title="Approved, not yet executed"
          description="If any of these stay here, the operator key or the RPC node is the problem — not the approval."
        >
          <Table headers={['Agent', 'Amount', 'Approved by', 'Decided', '']}>
            {approved.map((request) => (
              <tr key={request.id}>
                <td className="px-5 py-3 font-medium text-ink-800">
                  {request.agent?.tradingName ?? request.agent?.legalName ?? request.agentId}
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(request.amountRequested)}</Mono>
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">{request.approvedBy ?? '—'}</td>
                <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(request.decidedAt)}</td>
                <td className="px-5 py-3">
                  {mayExecute ? (
                    <MutationButton
                      label="Execute draw"
                      path={`/agents/liquidity/top-ups/${request.id}/execute`}
                      body={{}}
                      variant="primary"
                    />
                  ) : (
                    <PermissionNote permission="liquidity:execute" action="execute a draw" />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Open float alerts" description="Raised by the monitoring sweep, not by a scheduled cron in this app.">
        {!alerts.ok ? (
          <ErrorState title="Could not load alerts" message={alerts.message} />
        ) : alerts.data.alerts.length === 0 ? (
          <EmptyState title="No open float alerts" />
        ) : (
          <Table headers={['Kind', 'Agent', 'Region', 'Threshold', 'Observed', 'Severity', 'Raised']}>
            {alerts.data.alerts.map((alert) => {
              // Alerts are ranked by how far past the threshold the observation
              // is, because the kind alone does not say how bad it is.
              const severity =
                alert.kind === 'COLLATERAL_TIGHT'
                  ? 'bad'
                  : alert.observedBps < alert.thresholdBps
                    ? 'warn'
                    : 'neutral';
              return (
                <tr key={alert.id}>
                  <td className="px-5 py-3 font-medium text-ink-800">{alert.kind}</td>
                  <td className="px-5 py-3">
                    {alert.agent ? (
                      <Link
                        href={`/agents/${alert.agent.id}`}
                        className="text-ink-800 underline underline-offset-2"
                      >
                        {alert.agent.tradingName ?? alert.agent.legalName}
                      </Link>
                    ) : (
                      <Mono>{shortId(alert.agentId)}</Mono>
                    )}
                  </td>
                  <td className="px-5 py-3 text-ink-700">{alert.regionId}</td>
                  <td className="px-5 py-3">
                    <Mono>{formatBps(alert.thresholdBps)}</Mono>
                  </td>
                  <td className="px-5 py-3">
                    <Mono>{formatBps(alert.observedBps)}</Mono>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={severity}>{severity === 'bad' ? 'collateral' : 'float'}</Badge>
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(alert.createdAt)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Recent requests" description="Full queue, including decided items, for context.">
        {!topUps.ok ? (
          <ErrorState title="Could not load top-up requests" message={topUps.message} />
        ) : topUps.data.requests.length === 0 ? (
          <EmptyState title="No top-up requests have been made" />
        ) : (
          <Table headers={['Agent', 'Amount', 'Status', 'Decided by', 'Tx', 'Raised']}>
            {topUps.data.requests.slice(0, 25).map((request) => (
              <tr key={request.id}>
                <td className="px-5 py-3 text-ink-800">
                  {request.agent?.tradingName ?? request.agent?.legalName ?? request.agentId}
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(request.amountRequested)}</Mono>
                </td>
                <td className="px-5 py-3">
                  <StatusBadge status={request.status} />
                  {request.failureReason && (
                    <p className="mt-1 text-xs text-rose-700">{request.failureReason}</p>
                  )}
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">{request.approvedBy ?? '—'}</td>
                <td className="px-5 py-3">
                  <Mono>{request.txHash ? shortId(request.txHash, 8, 6) : '—'}</Mono>
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(request.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
