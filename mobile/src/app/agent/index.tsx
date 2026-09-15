import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { TransferStatusResponse } from '@/api/types';
import { Banner, Button, Card, Field, KeyValue, Screen, StatusPill } from '@/components/ui';
import { ScanClaimCode } from '@/components/scan-claim-code';
import { type ClaimVerification, normaliseClaimCode, verifyClaimCode } from '@/lib/claim';
import { formatAmount, shortId } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Agent flow.
 *
 * The agent's job is a single question — *is this code the one this transfer
 * commits to?* — and the app is built around answering it before any cash moves.
 *
 * The comparison happens on the device, against the `claim_hash` the indexer
 * read from the chain. It is the same `sha256(reveal) == claim_hash` check the
 * escrow performs, so a mistyped or wrong code fails here, in front of the
 * customer, instead of as a rejected transaction with a fee attached to it.
 *
 * This is a usability check and it says so. It is not a security boundary:
 * anyone holding the code can compute the same hash. What protects the agent is
 * the contract — an unauthorized agent's claim is refused, and the transfer is
 * marked claimed exactly once.
 */
export default function AgentScreen() {
  const [transferId, setTransferId] = useState('');
  const [code, setCode] = useState('');
  const [transfer, setTransfer] = useState<TransferStatusResponse | null>(null);
  const [verification, setVerification] = useState<ClaimVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);

  const loadTransfer = useCallback(async () => {
    if (!/^\d+$/.test(transferId)) {
      setError('Enter the numeric transfer id from the customer’s receipt.');
      return;
    }
    setBusy(true);
    setError(null);
    setVerification(null);
    const result = await api.transferStatus(transferId);
    setBusy(false);
    if (!result.ok) {
      setTransfer(null);
      setError(result.message);
      return;
    }
    setTransfer(result.data);
  }, [transferId]);

  const check = useCallback(async () => {
    if (transfer === null) return;
    setBusy(true);
    setVerification(await verifyClaimCode(normaliseClaimCode(code), transfer.claimHash));
    setBusy(false);
  }, [code, transfer]);

  const reset = useCallback(() => {
    setCode('');
    setTransfer(null);
    setVerification(null);
    setError(null);
    setScanning(true);
  }, []);

  return (
    <Screen
      title="Pay out a claim"
      subtitle="Verify the customer's claim code against the transfer before releasing any cash."
    >
      {error !== null && (
        <Banner tone="bad" title="Could not complete that step">
          <Text style={styles.body}>{error}</Text>
        </Banner>
      )}

      <Card title="1. Transfer">
        <Field
          label="Transfer id"
          value={transferId}
          onChangeText={setTransferId}
          keyboardType="number-pad"
          placeholder="1042"
          hint="From the customer's receipt or the transfer status page."
        />
        <Button
          label="Look up transfer"
          onPress={() => void loadTransfer()}
          loading={busy}
          disabled={transferId.length === 0}
        />
      </Card>

      {transfer !== null && (
        <>
          <Card title="Transfer on the ledger" tone={transfer.status === 'PENDING' ? 'info' : 'neutral'}>
            <View style={styles.row}>
              <StatusPill
                label={transfer.status}
                tone={transfer.status === 'PENDING' ? 'warn' : transfer.status === 'CLAIMED' ? 'good' : 'neutral'}
              />
              {transfer.expired && <StatusPill label="EXPIRED" tone="bad" />}
            </View>
            <KeyValue label="Amount" value={formatAmount(transfer.amount)} />
            <KeyValue label="Commit hash" value={shortId(transfer.claimHash, 14, 12)} />
            <KeyValue label="Corridor" value={transfer.corridorId} />
            <KeyValue label="Expires" value={new Date(transfer.expiry).toISOString()} />
          </Card>

          {transfer.status === 'CLAIMED' && (
            <Banner tone="bad" title="This transfer is already claimed">
              <Text style={styles.body}>
                Do not pay out. A claimed transfer cannot be claimed twice, so the customer&apos;s
                code either belongs to a different transfer or has already been spent. Claimed by{' '}
                {shortId(transfer.claimedBy, 8, 6)}.
              </Text>
            </Banner>
          )}

          {transfer.expired && transfer.status === 'PENDING' && (
            <Banner tone="bad" title="This transfer has expired">
              <Text style={styles.body}>
                The sender can already be refunded, so the funds are no longer committed to this
                claim. Do not pay out in cash.
              </Text>
            </Banner>
          )}

          {transfer.status === 'PENDING' && !transfer.expired && (
            <>
              <Card title="2. Customer's code">
                <ScanClaimCode
                  enabled={verification === null}
                  onScanned={(scanned) => {
                    setScanning(false);
                    setCode(scanned);
                  }}
                />
                {scanning && (
                  <Button label="Type the code instead" variant="secondary" onPress={() => setScanning(false)} />
                )}
                <Field
                  label="Claim code"
                  value={code}
                  onChangeText={setCode}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="XXXX-XXXX-XXXX-…"
                  hint="32 characters. I, L and O are never used in a code."
                />
                <Button
                  label="Verify code"
                  onPress={() => void check()}
                  loading={busy}
                  disabled={code.length === 0}
                />
              </Card>

              {verification !== null && (
                <Card
                  title="3. Result"
                  tone={verification.status === 'matches' ? 'good' : 'bad'}
                >
                  {verification.status === 'matches' ? (
                    <>
                      <Banner tone="good" title="Code matches this transfer">
                        <Text style={styles.body}>
                          The code hashes to the commit hash on the ledger. The escrow will accept it
                          from an authorized agent.
                        </Text>
                      </Banner>
                      <KeyValue
                        label="Payout to hand over"
                        value={formatAmount(transfer.payout === '0' ? transfer.amount : transfer.payout)}
                      />
                      <Text style={styles.note}>
                        Release the cash and then submit the claim. The transfer is marked claimed
                        exactly once, so a duplicate submission after this point is rejected rather
                        than paid twice.
                      </Text>
                    </>
                  ) : verification.status === 'malformed' ? (
                    <Banner tone="bad" title="That code is not complete">
                      <Text style={styles.body}>
                        {verification.reason}. Check for a dropped character before trying again.
                      </Text>
                    </Banner>
                  ) : (
                    <Banner tone="bad" title="Code does not match this transfer">
                      <Text style={styles.body}>
                        The code hashes to {shortId(verification.actual, 12, 10)}, but this transfer
                        commits to {shortId(verification.expected, 12, 10)}. Do not pay out. The code
                        probably belongs to a different transfer.
                      </Text>
                    </Banner>
                  )}
                  <Button label="Start the next customer" variant="secondary" onPress={reset} />
                </Card>
              )}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, color: colors.ink700, lineHeight: 20 },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  note: { fontSize: 12, color: colors.ink500, lineHeight: 17 },
});
