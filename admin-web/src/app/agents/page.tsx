import Link from 'next/link';

import { Card, EmptyState, ErrorState, Mono, StatusBadge, Table } from '@/components/ui';
import { endpoints } from '@/lib/endpoints';
import { formatStroops, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

const STATUSES = ['PENDING', 'AUTHORIZED', 'SUSPENDED', 'REVOKED'] as const;

export default async function AgentsPage({
  searchParams,
}: {
  // `searchParams` is a promise: the framework only has it once the request is
  // being handled, and awaiting it is what keeps this page dynamic.
  searchParams: Promise<{ status?: string; regionId?: string }>;
}) {
  const { status, regionId } = await searchParams;

  const result = await endpoints.agents({
    ...(status !== undefined ? { status } : {}),
    ...(regionId !== undefined ? { regionId } : {}),
    limit: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">Agents</h1>
        <p className="mt-1 text-sm text-ink-600">
          Local cash-out points. Each posts a bond; the bond is what a payer is trusting when they
          hand over value before a claim is redeemed.
        </p>
      </div>

      <Card
        title="Filter"
        description="Filters map to the indexed read model, so results lag the chain by at most one ledger."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/agents"
            className={`rounded-md border px-3 py-1.5 text-xs ${
              status === undefined ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-300 text-ink-700'
            }`}
          >
            All
          </Link>
          {STATUSES.map((candidate) => (
            <Link
              key={candidate}
              href={`/agents?status=${candidate}`}
              className={`rounded-md border px-3 py-1.5 text-xs ${
                status === candidate ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-300 text-ink-700'
              }`}
            >
              {candidate}
            </Link>
          ))}
        </div>
      </Card>

      <Card
        title="Registered agents"
        // Not `0 shown` when the read failed: an unknown count must not read as a
        // real one, which is the same rule the panels below follow.
        description={result.ok ? `${result.data.agents.length} shown` : 'Count unavailable'}
      >
        {!result.ok ? (
          <ErrorState title="Could not load agents" message={result.message} />
        ) : result.data.agents.length === 0 ? (
          <EmptyState
            title="No agents match this filter"
            hint="An empty list here is a real answer: the registry has nothing to show for it."
          />
        ) : (
          <Table
            headers={['Agent', 'Region', 'Status', 'Bond', 'Slashes', 'Registered', '']}
          >
            {result.data.agents.map((agent) => (
              <tr key={agent.id} className="hover:bg-ink-50">
                <td className="px-5 py-3">
                  <div className="font-medium text-ink-900">
                    {agent.tradingName ?? agent.legalName}
                  </div>
                  <div className="mt-0.5">
                    <Mono>{shortId(agent.stellarAddress, 8, 6)}</Mono>
                  </div>
                </td>
                <td className="px-5 py-3 text-ink-700">{agent.regionId}</td>
                <td className="px-5 py-3">
                  <StatusBadge status={agent.status} />
                </td>
                <td className="px-5 py-3">
                  <Mono>{formatStroops(agent.bondAmount)}</Mono>
                </td>
                <td className="px-5 py-3">
                  {agent.slashCount > 0 ? (
                    <span className="font-medium text-rose-700">{agent.slashCount}</span>
                  ) : (
                    <span className="text-ink-400">0</span>
                  )}
                </td>
                <td className="px-5 py-3 text-xs text-ink-600">
                  {agent.registeredAt.slice(0, 10)}
                </td>
                <td className="px-5 py-3 text-right">
                  <Link
                    href={`/agents/${agent.id}`}
                    className="text-xs font-medium text-ink-700 underline underline-offset-2 hover:text-ink-900"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
