import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Screen } from '@/components/ui';
import { colors, spacing } from '@/theme';

/**
 * Role selection.
 *
 * One app, three roles, because the network only works if all three are in the
 * same place: a sender who can create a claim code, a recipient who can show it
 * without owning a wallet, and an agent who can pay out and manage float. In the
 * field the same phone is often used for more than one of them — a shop owner
 * sends money home in the morning and pays out a customer's claim in the
 * afternoon.
 *
 * The roles are listed with what they *require* of the person, not just what
 * they do. "No wallet needed" is the single most important sentence in this app
 * for the recipient, and it should be readable before anything is tapped.
 */
export default function HomeScreen() {
  const router = useRouter();

  return (
    <Screen
      title="RemitBridge"
      subtitle="Cash out a transfer at a local agent — no wallet, no bank account, no seed phrase."
    >
      <Card title="I am sending money">
        <Text style={styles.body}>
          Create a transfer and a claim code. Share the code with your recipient however you
          normally talk to them.
        </Text>
        <Text style={styles.requirement}>Requires a Stellar account to fund the transfer.</Text>
        <Button label="Start a transfer" onPress={() => router.push('/sender')} />
      </Card>

      <Card title="I am collecting money">
        <Text style={styles.body}>
          Show the claim code you were given to any RemitBridge agent. They hand you cash. Nothing
          to install, nothing to sign.
        </Text>
        <Text style={styles.requirement}>No wallet or account needed.</Text>
        <Button
          label="Show my claim code"
          variant="secondary"
          onPress={() => router.push('/recipient')}
        />
      </Card>

      <Card title="I am an agent">
        <Text style={styles.body}>
          Verify a customer&rsquo;s claim code, release the payout, and keep an eye on your float and
          bonded collateral.
        </Text>
        <Text style={styles.requirement}>Requires an authorized agent account and a posted bond.</Text>
        <Button
          label="Pay out a claim"
          variant="secondary"
          onPress={() => router.push('/agent')}
        />
        <View style={styles.spacer} />
        <Button
          label="Float and bond"
          variant="secondary"
          onPress={() => router.push('/agent/float')}
        />
      </Card>

      <Text style={styles.footnote}>
        Names and documents never reach the ledger. Only a hash of the claim code and the transfer
        amount are written on-chain.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15, color: colors.ink700, lineHeight: 21 },
  requirement: { fontSize: 13, color: colors.ink500, fontStyle: 'italic' },
  spacer: { height: spacing.sm },
  footnote: {
    fontSize: 12,
    color: colors.ink500,
    paddingHorizontal: spacing.xs,
    lineHeight: 17,
  },
});
