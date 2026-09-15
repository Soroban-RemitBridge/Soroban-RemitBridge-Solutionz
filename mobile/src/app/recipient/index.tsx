import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { TransferStatusResponse } from '@/api/types';
import { ClaimCodeDisplay } from '@/components/claim-code-display';
import { Banner, Button, Card, Field, KeyValue, Screen, StatusPill } from '@/components/ui';
import { isWellFormedClaimCode, normaliseClaimCode } from '@/lib/claim';
import { formatAmount, shortId } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Recipient flow.
 *
 * This screen is the product thesis made concrete: the recipient has no wallet,
 * no account and no key. They paste or scan the code the sender sent them and
 * hold the phone up at the counter. Everything else — the escrow, the bond, the
 * compliance check — is invisible to them, which is the entire point of routing
 * the last mile through an agent network.
 *
 * The screen therefore optimises for exactly one thing: presenting the code
 * legibly. That is why the QR is large, the code is monospaced and letter-spaced,
 * and the status panel is below the fold rather than above it.
 */
export default function RecipientScreen() {
  const [rawCode, setRawCode] = useState('');
  const [transferId, setTransferId] = useState('');
  const [transfer, setTransfer] = useState<TransferStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const code = normaliseClaimCode(rawCode);
  const codeIsValid = isWellFormedClaimCode(code);

  const checkStatus = useCallback(async () => {
    if (!/^\d+$/.test(transferId)) {
      setStatusError('A transfer id is a number, as shown in your receipt.');
      setTransfer(null);
      return;
    }
    setBusy(true);
    setStatusError(null);
    const result = await api.transferStatus(transferId);
    setBusy(false);
    if (!result.ok) {
      setTransfer(null);
      setStatusError(result.message);
      return;
    }
    setTransfer(result.data);
  }, [transferId]);

  // Load the status automatically once the transfer id looks complete, so the
  // recipient does not have to press anything while standing at a counter.
  useEffect(() => {
    if (/^\d+$/.test(transferId)) void checkStatus();
  }, [transferId, checkStatus]);

  const paste = useCallback(async () => {
    const clipboard = await Clipboard.getStringAsync();
    setRawCode(clipboard);
  }, []);

  return (
    <Screen
      title="Collect cash"
      subtitle="Show this at any RemitBridge agent. You do not need a wallet or an account."
    >
      <Card title="Your claim code">
        <Field
          label="Claim code"
          value={rawCode}
          onChangeText={setRawCode}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="XXXX-XXXX-XXXX-…"
          hint="Paste what the sender sent you. Hyphens and lower case are fine."
        />
        <Button label="Paste from clipboard" variant="secondary" onPress={() => void paste()} />
        {rawCode.length > 0 && !codeIsValid && (
          <Text style={styles.error}>
            That does not look like a full claim code yet — they are 32 characters, and the letters I,
            L and O are never used.
          </Text>
        )}
      </Card>

      {codeIsValid && (
        <>
          <ClaimCodeDisplay code={code} />
          <Banner tone="info" title="Nothing to install, nothing to sign">
            <Text style={styles.body}>
              The agent scans or types this code and checks it against the transfer on the ledger.
              You never hold a key and never pay a fee.
            </Text>
          </Banner>
        </>
      )}

      <Card title="Check the status (optional)">
        <Field
          label="Transfer id"
          value={transferId}
          onChangeText={setTransferId}
          keyboardType="number-pad"
          placeholder="1042"
          hint="Your sender can give you this. It is on the receipt."
        />
        {statusError !== null && <Text style={styles.error}>{statusError}</Text>}
        {transfer !== null && (
          <View style={styles.status}>
            <StatusPill
              label={transfer.status}
              tone={
                transfer.status === 'CLAIMED'
                  ? 'good'
                  : transfer.status === 'PENDING'
                    ? 'warn'
                    : 'neutral'
              }
            />
            <KeyValue label="Amount" value={formatAmount(transfer.amount)} />
            <KeyValue label="Corridor" value={transfer.corridorId} />
            <KeyValue label="Claim hash" value={shortId(transfer.claimHash, 12, 10)} />
            {transfer.expired && (
              <Text style={styles.body}>
                This transfer passed its expiry and has not been claimed. The sender can be refunded —
                nobody has to approve it.
              </Text>
            )}
          </View>
        )}
        <Button
          label="Check status"
          variant="secondary"
          onPress={() => void checkStatus()}
          loading={busy}
          disabled={transferId.length === 0}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, color: colors.ink700, lineHeight: 20 },
  error: { fontSize: 13, color: colors.bad, fontWeight: '600' },
  status: { gap: spacing.xs, marginTop: spacing.xs },
});
