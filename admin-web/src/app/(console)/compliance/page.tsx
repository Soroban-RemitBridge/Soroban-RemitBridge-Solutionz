import Link from 'next/link';

import { RevokeAttestationForm } from '@/components/actions';
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
import { formatDateTime, formatStroops, formatRelative, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

const STATUSES = ['ACTIVE', 'PENDING', 'EXPIRED', 'REVOKED'] as const;

/**
 * Compliance monitoring.
 *
 * Two things this page is careful about.
 *
 * It shows attestation *references*, never the payload behind them. The hash is
 * what is on-chain and what an auditor can reconcile against; the name, document
 * and screening result that produced it are not fetched into an operator's
 * browser at all.
 *
 * It distinguishes "nothing is flagged" from "we could not check", because those
 * two states mean opposite things to the person reading this screen.
 */
export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: requestedStatus } = await searchParams;
  const status = requestedStatus ?? 'ACTIVE';

  // Read once for the page: an operator whose role cannot revoke should not be
  // offered the form that would be refused.
  const mayRevoke = await currentOperatorCan('kyc:revoke');

  const [attestations, transfers, corridors] = await Promise.all([
    endpoints.attestations({ status, limit: 100 }),
    endpoints.transfers({ limit: 100 }),
    endpoints.corridors(),
  ]);

  const expiredCount = attestations.ok
    ? attestations.data.attestations.filter((row) => new Date(row.expiresAt).getTime() < Date.now()).length
    : null;

  // Transfers past expiry but not yet refunded. This is the state a sender is
  // most likely to phone about, and the one where nobody is at fault.
  const awaitingRefund = transfers.ok
    ? transfers.data.transfers.filter(
        (row) => row.status === 'PENDING' && new Date(row.expiry).getTime() < Date.now(),
      )
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Compliance</h1>
        <p className="mt-1 text-sm text-ink-600">
          Attestation references published to the compliance hook, the per-corridor tier bands, and
          the transfers that are past expiry without a refund.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Attestations in view"
          value={attestations.ok ? String(attestations.data.attestations.length) : '—'}
          hint={`Status: ${status}`}
        />
        <StatCard
          label="Past expiry in view"
          value={expiredCount === null ? '—' : String(expiredCount)}
          tone={expiredCount !== null && expiredCount > 0 ? 'warn' : 'good'}
          hint="Requires re-verification before the next transfer"
        />
        <StatCard
          label="Awaiting refund"
          value={transfers.ok ? String(awaitingRefund.length) : '—'}
          tone={awaitingRefund.length > 0 ? 'warn' : 'good'}
          hint="Expired and unclaimed; anyone may trigger the refund"
        />
        <StatCard
          label="Indexer head"
          value={transfers.ok && transfers.data.indexer.lastLedger !== null ? String(transfers.data.indexer.lastLedger) : '—'}
          hint={transfers.ok ? `Updated ${formatRelative(transfers.data.indexer.updatedAt)}` : 'Read model unreachable'}
        />
      </div>

      <Card
        title="Revoke attestations for a subject"
        description="Publishes a revocation to the compliance hook and marks every attestation for that subject revoked, here and on-chain."
      >
        {mayRevoke ? (
          <RevokeAttestationForm />
        ) : (
          <PermissionNote permission="kyc:revoke" action="publish a revocation" />
        )}
      </Card>

      <Card
        title="Attestation feed"
        description="Hashes and references only. The verification payload stays in the backend database under its retention policy."
      >
        <div className="mb-4 flex flex-wrap gap-2">
          {STATUSES.map((candidate) => (
            <Link
              key={candidate}
              href={`/compliance?status=${candidate}`}
              className={`rounded-md border px-3 py-1.5 text-xs ${
                status === candidate
                  ? 'border-ink-900 bg-ink-900 text-white'
                  : 'border-ink-300 text-ink-700'
              }`}
            >
              {candidate}
            </Link>
          ))}
        </div>

        {!attestations.ok ? (
          <ErrorState title="Could not load attestations" message={attestations.message} />
        ) : attestations.data.attestations.length === 0 ? (
          <EmptyState
            title={`No ${status.toLowerCase()} attestations`}
            hint="The backend answered, so this is a real empty result."
          />
        ) : (
          <Table headers={['Subject', 'Tier', 'Status', 'Provider', 'Region', 'Issued', 'Expires']}>
            {attestations.data.attestations.map((row) => {
              const expired = new Date(row.expiresAt).getTime() < Date.now();
              return (
                <tr key={row.id}>
                  <td className="px-5 py-3">
                    <Mono>{shortId(row.userId, 8, 6)}</Mono>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={row.tier === 'ENHANCED' ? 'info' : 'neutral'}>{row.tier}</Badge>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={row.status} />
                    {expired && row.status === 'ACTIVE' && (
                      <p className="mt-1 text-xs text-amber-700">
                        Past expiry — the sweep will mark this EXPIRED
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-600">{row.providerId}</td>
                  <td className="px-5 py-3 text-ink-700">{row.regionId}</td>
                  <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(row.issuedAt)}</td>
                  <td className="px-5 py-3 text-xs text-ink-600">{formatDateTime(row.expiresAt)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card
        title="Transfers past expiry, not yet refunded"
        description="Not an error state: the refund is permissionless, so a gap between expiry and refund is expected. A long gap means nobody is watching."
      >
        {!transfers.ok ? (
          <ErrorState title="Could not load transfers" message={transfers.message} />
        ) : awaitingRefund.length === 0 ? (
          <EmptyState title="Nothing is waiting on a refund" />
        ) : (
          <Table headers={['Transfer', 'Corridor', 'Amount', 'Expired', 'Claim hash']}>
            {awaitingRefund.map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3">
                  <Mono>#{row.id}</Mono>
                </td>
                <td className="px-5 py-3 text-ink-700">{row.corridorId}</td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(row.amount)}</Mono>
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">{formatRelative(row.expiry)}</td>
                <td className="px-5 py-3">
                  <Mono>{shortId(row.claimHash, 10, 8)}</Mono>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Tier bands by corridor"
        description="The same numbers the compliance hook enforces. The contract is authoritative; this table is for explaining a requirement to a sender."
      >
        {!corridors.ok ? (
          <ErrorState title="Could not load corridors" message={corridors.message} />
        ) : (
          <Table headers={['Corridor', 'Up to (no check)', 'Up to (standard)', 'Daily limit', 'Spread']}>
            {corridors.data.corridors.map((corridor) => (
              <tr key={corridor.id}>
                <td className="px-5 py-3 font-medium text-ink-800">
                  {corridor.id}
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    {corridor.sourceCurrency}→{corridor.destCurrency}
                  </span>
                </td>
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
                  <Mono>{(corridor.spreadBps / 100).toFixed(2)}%</Mono>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
