import { Badge, Card, EmptyState, ErrorState, Mono, StatCard, Table } from '@/components/ui';
import { endpoints } from '@/lib/endpoints';
import { formatBps, formatStroops } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Corridors and tier bands.
 *
 * The tier bands are read back from the corpus the sender app uses, so the
 * numbers an operator sees here are the numbers a customer was shown. They are
 * still not the authority — the compliance hook is — and a mismatch is reconciled
 * by the deployment's `syncCorridorConfig`, not by editing this table.
 *
 * This page is read-only on purpose. Changing a threshold is an admin-gated,
 * key-signing operation, and putting a button next to it in a console with no
 * operator authentication would be the single highest-blast-radius mistake
 * available here.
 */
export default async function CorridorsPage() {
  const corridors = await endpoints.corridors();

  if (!corridors.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Corridors</h1>
        <ErrorState title="Could not load corridors" message={corridors.message} />
      </div>
    );
  }

  const tiers = await Promise.all(
    corridors.data.corridors.map(async (corridor) => ({
      corridorId: corridor.id,
      result: await endpoints.complianceTiers(corridor.id),
    })),
  );

  const totalDailyCapacity = corridors.data.corridors.reduce(
    (sum, corridor) => sum + BigInt(corridor.dailyLimit),
    0n,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Corridors</h1>
        <p className="mt-1 text-sm text-ink-600">
          Per-corridor configuration: the KYC tier bands, the daily limit, and the spread applied
          over the oracle mid-price.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active corridors" value={String(corridors.data.corridors.length)} />
        <StatCard
          label="Combined daily limit"
          value={formatStroops(totalDailyCapacity.toString())}
          hint="Across every corridor, in source units"
        />
        <StatCard
          label="Regions covered"
          value={String(
            new Set(corridors.data.corridors.map((corridor) => corridor.regionId)).size,
          )}
        />
      </div>

      <Card
        title="Corridor configuration"
        description="Read-only. Tier thresholds are set on-chain with the operator key by the deployment tooling."
      >
        {corridors.data.corridors.length === 0 ? (
          <EmptyState
            title="No corridors configured"
            hint="Run the deployment script: it seeds regions and corridors before any agent can register."
          />
        ) : (
          <>
            {/* Enhanced due diligence runs up to the daily limit, so the last
                band and the daily limit are the same number. It is labelled as
                both rather than shown twice. */}
            <Table headers={['Corridor', 'Region', 'Tier 1 (none)', 'Tier 2 (standard)', 'Tier 3 / daily limit', 'Spread', 'Active']}>
            {corridors.data.corridors.map((corridor) => (
              <tr key={corridor.id}>
                <td className="px-5 py-3">
                  <div className="font-medium text-ink-900">{corridor.id}</div>
                  <div className="text-xs text-ink-500">
                    {corridor.sourceCurrency} → {corridor.destCurrency}
                  </div>
                </td>
                <td className="px-5 py-3 text-ink-700">{corridor.region.displayName}</td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(corridor.tier1Max)}</Mono>
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(corridor.tier2Max)}</Mono>
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(corridor.dailyLimit)}</Mono>
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatBps(corridor.spreadBps)}</Mono>
                </td>
                <td className="px-5 py-3">
                  {corridor.active ? <Badge tone="good">active</Badge> : <Badge tone="neutral">inactive</Badge>}
                </td>
              </tr>
              ))}
            </Table>
          </>
        )}
      </Card>

      <Card
        title="What a sender is asked for"
        description="Straight from the endpoint the sender app calls, so this page cannot describe a different policy than the one enforced."
      >
        <div className="space-y-6">
          {tiers.map(({ corridorId, result }) =>
            result.ok ? (
              <div key={corridorId}>
                <h3 className="text-sm font-semibold text-ink-900">{corridorId}</h3>
                <p className="mb-2 text-xs text-ink-500">
                  Daily limit {formatStroops(result.data.dailyLimit)} · spread{' '}
                  {formatBps(result.data.spreadBps)}
                </p>
                <ul className="space-y-2">
                  {result.data.tiers.map((tier) => (
                    <li
                      key={tier.tier}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-ink-100 px-3 py-2"
                    >
                      <Badge tone={tier.tier === 'ENHANCED' ? 'info' : 'neutral'}>{tier.tier}</Badge>
                      <span className="text-sm text-ink-700">up to {formatStroops(tier.upTo)}</span>
                      <span className="text-xs text-ink-500">{tier.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ErrorState
                key={corridorId}
                title={`Tiers unavailable for ${corridorId}`}
                message={result.message}
              />
            ),
          )}
        </div>
      </Card>
    </div>
  );
}
