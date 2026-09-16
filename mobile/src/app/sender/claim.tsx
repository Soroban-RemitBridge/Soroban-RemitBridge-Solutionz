import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Card, KeyValue, Screen } from '@/components/ui';
import { ClaimCodeDisplay } from '@/components/claim-code-display';
import { formatAmount, shortId } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * The screen the sender shows, photographs, or reads out.
 *
 * The commit hash is displayed as prominently as the code itself. That is not
 * decoration: the sender has to be able to tell the recipient's agent *which*
 * transfer this code belongs to, and the hash is the identifier that is on-chain
 * and therefore checkable. Without it, a dispute about "the code you gave me"
 * has nothing to stand on.
 *
 * There is no way back from here (see the layout) because going back and forward
 * again would mint a different code while the customer may already have written
 * the first one down.
 */
export default function SenderClaimScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    claimCode: string;
    claimHash: string;
    corridorId: string;
    amount: string;
    clientRate: string;
    quoteId: string;
    destCurrency: string;
    senderAddress: string;
  }>();

  const { claimCode, claimHash } = params;

  if (typeof claimCode !== 'string' || typeof claimHash !== 'string') {
    return (
      <Screen title="Claim code" subtitle="This screen needs a claim code to display.">
        <Banner tone="warn" title="No claim code was passed to this screen">
          <Text style={styles.body}>
            Start again from the send flow. This is usually what happens after a reload on a device
            that dropped the navigation state.
          </Text>
        </Banner>
        <Button label="Back to sending" onPress={() => router.replace('/sender')} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Share this claim code"
      subtitle="Your recipient shows it to any agent to collect cash. Anyone with this code can collect, so share it like cash."
    >
      <ClaimCodeDisplay code={claimCode} />

      <Banner tone="warn" title="This code is the money">
        <Text style={styles.body}>
          Anyone who has it can collect the transfer. Send it to your recipient only, and never post
          it publicly.
        </Text>
      </Banner>

      <Card title="Transfer details">
        <KeyValue label="Commit hash (on-chain)" value={shortId(claimHash, 16, 12)} />
        <KeyValue label="Corridor" value={params.corridorId ?? '—'} />
        <KeyValue label="Amount" value={formatAmount(params.amount ?? null)} />
        <KeyValue
          label={`Rate offered${params.destCurrency ? ` (${params.destCurrency})` : ''}`}
          // Stroops, like `amount` above: `formatRate` would group the raw
          // fixed-point value and show a rate ten million times too large.
          value={formatAmount(params.clientRate ?? null)}
        />
        <KeyValue label="Quote reference" value={shortId(params.quoteId ?? null, 8, 4)} />
        <KeyValue label="Funding account" value={shortId(params.senderAddress ?? null, 8, 6)} />
      </Card>

      <Card title="What happens next">
        <Text style={styles.body}>
          1. Your wallet signs the deposit into the escrow contract. The escrow holds the funds; the
          network never does.
        </Text>
        <Text style={styles.body}>
          2. Your recipient shows this code to an agent, who verifies it against the commit hash.
        </Text>
        <Text style={styles.body}>
          3. The agent releases the cash and the escrow settles to them. The code is then spent and
          cannot be reused.
        </Text>
        <Text style={styles.body}>
          4. If nobody claims it before the expiry you chose, the escrow returns the funds to you.
          Nobody has to approve that — it is in the contract.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button label="Send another" variant="secondary" onPress={() => router.replace('/sender')} />
        <Button label="Done" onPress={() => router.replace('/')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, color: colors.ink700, lineHeight: 20 },
  actions: { gap: spacing.sm },
});
