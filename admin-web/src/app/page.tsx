import { Badge, Card, DefinitionList, ErrorState, Mono, StatCard } from '@/components/ui';
import { endpoints } from '@/lib/endpoints';
import { formatNumber, shortId } from '@/lib/format';

/**
 * Overview.
 *
 * Ordered by what an operator needs to know before acting on anything else:
 * which contracts this deployment is actually wired to, then whether anything is
 * waiting on a human, then the configuration that decides what customers
 * experience. Contract addresses come first deliberately — signing off a float
 * move against the wrong deployment is unrecoverable.
 */

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [readiness, kycConfig, alerts, topUps] = await Promise.all([
    endpoints.readiness(),
    endpoints.kycConfig(),
    endpoints.alerts('OPEN'),
    endpoints.topUps('PENDING'),
  ]);

  const openAlerts = alerts.ok ? alerts.data.alerts.length : null;
  const pendingTopUps = topUps.ok ? topUps.data.requests.length : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Overview</h1>
        <p className="mt-1 text-sm text-ink-600">
          The agent network&rsquo;s operational state: what is waiting on a human decision, and which
          contracts this console is pointed at.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open float alerts"
          value={openAlerts === null ? '—' : formatNumber(openAlerts)}
          tone={openAlerts === null ? 'neutral' : openAlerts > 0 ? 'warn' : 'good'}
          hint={openAlerts === null ? 'Alerts endpoint unreachable' : 'Agents below their float threshold'}
        />
        <StatCard
          label="Top-ups awaiting approval"
          value={pendingTopUps === null ? '—' : formatNumber(pendingTopUps)}
          tone={pendingTopUps === null ? 'neutral' : pendingTopUps > 0 ? 'warn' : 'good'}
          hint={pendingTopUps === null ? 'Top-up endpoint unreachable' : 'Nothing is paid out without a decision'}
        />
        <StatCard
          label="KYC provider"
          value={readiness.ok ? readiness.data.kycProvider : '—'}
          hint={kycConfig.ok ? `Webhook signature ${kycConfig.data.webhookSignatureRequired ? 'required' : 'not enforced'}` : undefined}
          tone={kycConfig.ok && !kycConfig.data.webhookSignatureRequired ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Network"
          value={readiness.ok ? readiness.data.networkLabel : '—'}
          hint={readiness.ok ? `max fee ${readiness.data.limits.maxFeeBps} bps` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Contract wiring"
          description="Read from the backend's readiness probe, not from this console's own configuration."
        >
          {readiness.ok ? (
            <DefinitionList
              items={[
                { term: 'Escrow', detail: <Mono>{shortId(readiness.data.contracts.escrow, 10, 8)}</Mono> },
                {
                  term: 'Agent registry',
                  detail: <Mono>{shortId(readiness.data.contracts.agentRegistry, 10, 8)}</Mono>,
                },
                {
                  term: 'Compliance hook',
                  detail: <Mono>{shortId(readiness.data.contracts.complianceHook, 10, 8)}</Mono>,
                },
                {
                  term: 'Liquidity pool',
                  detail: <Mono>{shortId(readiness.data.contracts.liquidityPool, 10, 8)}</Mono>,
                },
              ]}
            />
          ) : (
            <ErrorState title="Contract wiring unavailable" message={readiness.message} />
          )}
        </Card>

        <Card title="Verification configuration" description="What a sender is asked for, and for how long it holds.">
          {kycConfig.ok ? (
            <DefinitionList
              items={[
                { term: 'Provider', detail: kycConfig.data.provider },
                {
                  term: 'Supported tiers',
                  detail: (
                    <span className="flex flex-wrap gap-1">
                      {kycConfig.data.supportedTiers.map((tier) => (
                        <Badge key={tier} tone="info">
                          {tier}
                        </Badge>
                      ))}
                    </span>
                  ),
                },
                {
                  term: 'Enhanced due diligence',
                  detail: kycConfig.data.enhancedDueDiligence ? 'Source of funds collected' : 'Not supported',
                },
                {
                  term: 'Attestation validity',
                  detail: `${formatNumber(kycConfig.data.attestationTtlDays)} days`,
                },
                {
                  term: 'Webhook signature',
                  detail: kycConfig.data.webhookSignatureRequired
                    ? 'Required (fails closed without it)'
                    : 'Not configured — unsigned webhooks will be rejected',
                },
              ]}
            />
          ) : (
            <ErrorState title="KYC configuration unavailable" message={kycConfig.message} />
          )}
        </Card>
      </div>

      <Card
        title="What this console does not do"
        description="Stated here because an operator console that implies more authority than it has is a compliance risk."
      >
        <ul className="space-y-2 text-sm text-ink-700">
          <li>
            It never shows a claim code. The escrow stores only <Mono>sha256(reveal)</Mono>, and the
            reveal belongs to the sender and the agent handling the payout.
          </li>
          <li>
            It holds no keys. Agent authorization, slashing and tier thresholds are admin-gated
            on-chain and executed by the operator key outside this app.
          </li>
          <li>
            It contains no personal data. Only attestation references and amounts are displayed;
            names and documents stay in the backend database under its retention rules.
          </li>
        </ul>
      </Card>
    </div>
  );
}
