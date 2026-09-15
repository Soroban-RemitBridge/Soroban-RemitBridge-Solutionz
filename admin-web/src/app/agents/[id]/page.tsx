import Link from 'next/link';

import { MutationButton, TopUpProposeForm } from '@/components/actions';
import { Badge, Card, DefinitionList, ErrorState, Mono, StatCard, StatusBadge, Table } from '@/components/ui';
import { endpoints } from '@/lib/endpoints';
import { formatBps, formatDateTime, formatStroops, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await endpoints.agent(id);

  if (!agent.ok) {
    return (
      <div className="space-y-4">
        <Link href="/agents" className="text-xs text-ink-600 underline underline-offset-2">
          ← All agents
        </Link>
        <ErrorState title="Could not load this agent" message={agent.message} />
      </div>
    );
  }

  const detail = agent.data;
  const bond = BigInt(detail.bondAmount);
  const required = BigInt(detail.requiredBond);
  // Headroom, not ratio: an operator decides whether the *next* draw succeeds,
  // and that is the difference between the bond and what the bond is securing.
  const headroom = bond - required;

  const alerts = await endpoints.alerts('OPEN');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/agents" className="text-xs text-ink-600 underline underline-offset-2">
            ← All agents
          </Link>
          <h1 className="mt-2 text-lg font-semibold tracking-tight text-ink-900">
            {detail.tradingName ?? detail.legalName}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-ink-600">
            <StatusBadge status={detail.status} />
            <span>{detail.region?.displayName ?? detail.regionId}</span>
            {detail.slashCount > 0 && (
              <Badge tone="bad">
                {detail.slashCount} slash{detail.slashCount === 1 ? '' : 'es'}
              </Badge>
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Bond posted" value={formatStroops(detail.bondAmount)} hint="Held by the registry contract" />
        <StatCard
          label="Float drawn"
          value={formatStroops(detail.totalDrawn)}
          hint="Drawn from the regional pool"
        />
        <StatCard
          label="Required for current draw"
          value={formatStroops(detail.requiredBond)}
          hint={`At ${formatBps(detail.collateralRatioBps)} collateralisation`}
        />
        <StatCard
          label="Bond headroom"
          value={formatStroops(headroom.toString())}
          tone={headroom <= 0n ? 'bad' : headroom < bond / 4n ? 'warn' : 'good'}
          hint={headroom <= 0n ? 'The next draw will be refused on-chain' : 'Available before the next draw fails'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identity on the ledger" description="Addresses, not names: the ledger holds no personal data.">
          <DefinitionList
            items={[
              { term: 'Agent id', detail: <Mono>{detail.id}</Mono> },
              { term: 'Registry address', detail: <Mono>{shortId(detail.stellarAddress, 10, 8)}</Mono> },
              { term: 'Settlement address', detail: <Mono>{shortId(detail.settlementAddress, 10, 8)}</Mono> },
              { term: 'Legal name (off-chain)', detail: detail.legalName },
              { term: 'Registered', detail: formatDateTime(detail.registeredAt) },
              { term: 'Authorized', detail: formatDateTime(detail.authorizedAt) },
              ...(detail.suspendedAt ? [{ term: 'Suspended', detail: formatDateTime(detail.suspendedAt) }] : []),
              ...(detail.revokedAt ? [{ term: 'Revoked', detail: formatDateTime(detail.revokedAt) }] : []),
            ]}
          />
        </Card>

        <Card
          title="Operational actions"
          description="These call the backend; the on-chain calls they trigger are made with the operator key held by the backend."
        >
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-ink-600">Re-evaluate float alerts for this region</p>
              <p className="mb-2 mt-0.5 text-xs text-ink-500">
                The same sweep the scheduled job runs. Safe to run by hand when an alert looks stale.
              </p>
              <MutationButton
                label="Run liquidity sweep"
                path="/agents/liquidity/sweep"
                body={{ regionId: detail.regionId }}
                variant="secondary"
              />
            </div>

            <div className="border-t border-ink-100 pt-4">
              <p className="text-xs font-medium text-ink-600">Request a float top-up</p>
              <p className="mb-2 mt-0.5 text-xs text-ink-500">
                Creates a request only. A separate approval is required before anything is drawn —
                a machine must not be able to move float on its own.
              </p>
              <TopUpProposeForm agentId={detail.id} regionId={detail.regionId} />
            </div>
          </div>
        </Card>
      </div>

      <Card title="Open float alerts" description="Only this agent's unresolved alerts are shown.">
        {!alerts.ok ? (
          <ErrorState title="Could not load alerts" message={alerts.message} />
        ) : (
          (() => {
            const mine = alerts.data.alerts.filter((alert) => alert.agentId === detail.id);
            if (mine.length === 0) {
              return (
                <p className="text-sm text-ink-600">
                  No open alerts for this agent. That is a real answer — the alerts endpoint
                  responded.
                </p>
              );
            }
            return (
              <Table headers={['Kind', 'Threshold', 'Observed', 'Status', 'Raised']}>
                {mine.map((alert) => (
                  <tr key={alert.id}>
                    <td className="px-5 py-3 font-medium text-ink-800">{alert.kind}</td>
                    <td className="px-5 py-3">
                      <Mono>{formatBps(alert.thresholdBps)}</Mono>
                    </td>
                    <td className="px-5 py-3">
                      <Mono>{formatBps(alert.observedBps)}</Mono>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={alert.status} />
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(alert.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            );
          })()
        )}
      </Card>

      <Card title="Exposure by region" description="Float currently drawn, per region this agent operates in.">
        {detail.exposure && detail.exposure.length > 0 ? (
          <Table headers={['Region', 'Drawn']}>
            {detail.exposure.map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3 text-ink-700">{row.regionId}</td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(row.drawnAmount)}</Mono>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-sm text-ink-600">This agent has drawn no float.</p>
        )}
      </Card>
    </div>
  );
}
