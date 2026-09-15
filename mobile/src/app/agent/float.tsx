import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { AgentSummary } from '@/api/types';
import { Banner, Button, Card, Field, KeyValue, Screen, StatusPill } from '@/components/ui';
import { formatAmount } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Agent float and bonded collateral.
 *
 * The two numbers that matter to an agent are shown together, because in
 * practice they are one decision: *can I take on this payout?* An agent with
 * plenty of cash but a fully committed bond will have their next draw refused by
 * the pool contract, and an agent with a large bond but no cash cannot hand
 * anything over today. Showing them apart invites the wrong conclusion.
 *
 * Headroom is computed from the contract's own collateral ratio, fetched from the
 * backend, so the figure the agent plans against is the figure the chain will
 * enforce.
 */
export default function AgentFloatScreen() {
  const [agentId, setAgentId] = useState('');
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const amountIsValid = /^\d+(\.\d{1,7})?$/.test(amount) && Number(amount) > 0;

  const loadAgent = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSubmitted(null);
    const result = await api.agent(agentId.trim());
    setBusy(false);
    if (!result.ok) {
      setAgent(null);
      setError(result.message);
      return;
    }
    setAgent(result.data);
  }, [agentId]);

  const requestTopUp = useCallback(async () => {
    if (agent === null || !amountIsValid) return;
    setBusy(true);
    setError(null);
    const result = await api.proposeTopUp({
      agentId: agent.id,
      regionId: agent.regionId,
      amount,
      reason: reason.trim(),
      requestedBy: `agent-app:${agent.id.slice(0, 8)}`,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSubmitted(result.data.id);
    setAmount('');
    setReason('');
  }, [agent, amount, amountIsValid, reason]);

  const headroom =
    agent?.bondAmount !== undefined && agent.requiredBond !== undefined
      ? (BigInt(agent.bondAmount) - BigInt(agent.requiredBond)).toString()
      : null;

  return (
    <Screen
      title="Float and bond"
      subtitle="Your cash availability and the collateral securing it, plus a request for a top-up."
    >
      {error !== null && (
        <Banner tone="bad" title="Could not complete that step">
          <Text style={styles.body}>{error}</Text>
        </Banner>
      )}

      {submitted !== null && (
        <Banner tone="good" title="Top-up request submitted">
          <Text style={styles.body}>
            Reference {submitted.slice(0, 8)}. This is a request only — an operator approves it, and
            the draw is executed separately. Nothing moves until both steps happen.
          </Text>
        </Banner>
      )}

      <Card title="Find your agent record">
        <Field
          label="Agent record id"
          value={agentId}
          onChangeText={setAgentId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="uuid from your onboarding"
          hint="Your operator gave you this when your bond was registered."
        />
        <Button
          label="Load my record"
          onPress={() => void loadAgent()}
          loading={busy}
          disabled={agentId.trim().length === 0}
        />
      </Card>

      {agent !== null && (
        <>
          <Card title="Status">
            <View style={styles.row}>
              <StatusPill
                label={agent.status}
                tone={agent.status === 'AUTHORIZED' ? 'good' : 'warn'}
              />
              <Text style={styles.body}>{agent.tradingName ?? agent.legalName}</Text>
            </View>
            {agent.status !== 'AUTHORIZED' && (
              <Banner tone="bad" title="Not authorized to pay out">
                <Text style={styles.body}>
                  The registry does not currently authorize this agent, so a claim would be refused
                  on-chain. Ask your operator to re-authorize before serving customers.
                </Text>
              </Banner>
            )}
          </Card>

          <Card title="Your numbers">
            <KeyValue label="Bond posted" value={formatAmount(agent.bondAmount)} />
            {agent.totalDrawn !== undefined && (
              <KeyValue label="Float drawn from the pool" value={formatAmount(agent.totalDrawn)} />
            )}
            {agent.requiredBond !== undefined && (
              <KeyValue
                label={`Collateral required${agent.collateralRatioBps !== undefined ? ` (at ${(agent.collateralRatioBps / 100).toFixed(0)}%)` : ''}`}
                value={formatAmount(agent.requiredBond)}
              />
            )}
            {headroom !== null && (
              <KeyValue label="Bond headroom" value={formatAmount(headroom)} />
            )}
            {agent.region !== undefined && (
              <KeyValue label="Region" value={agent.region.displayName} />
            )}
          </Card>

          {headroom !== null && BigInt(headroom) <= 0n && (
            <Banner tone="warn" title="Your bond is fully committed">
              <Text style={styles.body}>
                The pool will refuse your next draw until exposure falls or you add to the bond. A
                refused draw is a contract decision, not an operator preference.
              </Text>
            </Banner>
          )}

          <Card title="Request a float top-up">
            <Field
              label={`Amount${agent.region?.currency !== undefined ? ` (${agent.region.currency})` : ''}`}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="2500.00"
            />
            <Field
              label="Reason"
              value={reason}
              onChangeText={setReason}
              placeholder="Cash demand above forecast"
              maxLength={500}
            />
            <Button
              label="Submit request"
              onPress={() => void requestTopUp()}
              loading={busy}
              disabled={!amountIsValid || reason.trim().length < 4}
            />
            <Text style={styles.note}>
              A person approves this before any money moves. The app cannot draw float on its own.
            </Text>
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, color: colors.ink700, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  note: { fontSize: 12, color: colors.ink500, lineHeight: 17 },
});
