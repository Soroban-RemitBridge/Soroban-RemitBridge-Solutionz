import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Card, Field, KeyValue, Screen, StatusPill } from '@/components/ui';
import { api } from '@/api/client';
import type { Corridor, Preflight, Quote } from '@/api/types';
import { generateClaimCode } from '@/lib/claim';
import { formatAmount, formatRate, shortId } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import { LocalKeypairWallet } from '@/wallet/local-wallet';

/**
 * Sender flow: corridor → amount → signed quote → compliance tier → claim code.
 *
 * The order is the point. The tier requirement is resolved *before* the claim
 * code exists, so a sender learns "this needs a passport" while they are still
 * deciding, rather than after they have funded an escrow that compliance will
 * not let them claim.
 *
 * The quote is signed and single-use. The signature is what lets the sender
 * later prove the rate they were shown, so the screen keeps the whole quote
 * rather than the numbers it happens to display.
 */

const wallet = new LocalKeypairWallet();

export default function SenderScreen() {
  const router = useRouter();

  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [corridorId, setCorridorId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [senderAddress, setSenderAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Read-only and safe to retry, so a failed load is reported inline rather
    // than blocking the screen.
    void (async () => {
      const result = await api.corridors();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setCorridors(result.data.corridors.filter((corridor) => corridor.active));
      setCorridorId((current) => current ?? result.data.corridors[0]?.id ?? null);
    })();
  }, []);

  const selected = useMemo(
    () => corridors.find((corridor) => corridor.id === corridorId) ?? null,
    [corridors, corridorId],
  );

  const amountIsValid = /^\d+(\.\d{1,7})?$/.test(amount) && Number(amount) > 0;

  const loadQuote = useCallback(async () => {
    if (corridorId === null || !amountIsValid) return;
    setBusy(true);
    setError(null);
    setQuote(null);
    setPreflight(null);

    const [quoteResult, preflightResult] = await Promise.all([
      api.quote(corridorId, amount),
      api.preflight(corridorId, amount),
    ]);

    setBusy(false);
    if (!quoteResult.ok) {
      setError(quoteResult.message);
      return;
    }
    if (!preflightResult.ok) {
      setError(preflightResult.message);
      return;
    }
    setQuote(quoteResult.data);
    setPreflight(preflightResult.data);
  }, [amount, amountIsValid, corridorId]);

  const startTransfer = useCallback(async () => {
    if (quote === null || preflight === null) return;
    setBusy(true);
    setError(null);
    try {
      // A key is created on the device only when the sender actually needs one,
      // so the customer is never handed an unexplained account.
      const address = await wallet.ensureKeypair();
      setSenderAddress(address);

      const claim = await generateClaimCode();
      setBusy(false);

      router.push({
        pathname: '/sender/claim',
        params: {
          claimCode: claim.code,
          claimHash: claim.hash,
          corridorId: quote.corridorId,
          amount: quote.amount,
          clientRate: quote.clientRate,
          quoteId: quote.quoteId,
          destCurrency: selected?.destCurrency ?? '',
          senderAddress: address,
        },
      });
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : 'Could not create a claim code.');
    }
  }, [preflight, quote, router, selected]);

  return (
    <Screen
      title="Send money"
      subtitle="Pick a corridor and an amount. You will get a signed rate and a claim code to share."
    >
      {error !== null && (
        <Banner tone="bad" title="Something went wrong">
          <Text style={styles.bannerText}>{error}</Text>
        </Banner>
      )}

      <Card title="Destination">
        {corridors.length === 0 ? (
          <Text style={styles.body}>
            No active corridors were returned. The network may not be deployed yet.
          </Text>
        ) : (
          <View style={styles.corridorList}>
            {corridors.map((corridor) => {
              const active = corridor.id === corridorId;
              return (
                <Pressable
                  key={corridor.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setCorridorId(corridor.id);
                    setQuote(null);
                    setPreflight(null);
                  }}
                  style={[styles.corridorChip, active && styles.corridorChipActive]}
                >
                  <Text style={[styles.corridorChipText, active && styles.corridorChipTextActive]}>
                    {corridor.sourceCurrency} → {corridor.destCurrency}
                  </Text>
                  <Text style={[styles.corridorChipSub, active && styles.corridorChipTextActive]}>
                    {corridor.region.displayName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </Card>

      <Card title="Amount to send">
        <Field
          label={`Amount in ${selected?.sourceCurrency ?? 'source currency'}`}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="250.00"
          hint="Up to 7 decimal places. Entered as text so no precision is lost."
        />
        <Button
          label="Get a rate"
          onPress={() => void loadQuote()}
          disabled={corridorId === null || !amountIsValid}
          loading={busy}
        />
      </Card>

      {quote !== null && preflight !== null && (
        <>
          <Card title="Signed quote">
            <KeyValue
              label="You send"
              // `amount` and `clientRate` are stroops — a fixed point with seven
              // decimals, the same unit the contract carries. Grouping them with
              // `formatRate` reads them as a decimal string and multiplies the
              // figure a sender is asked to trust by ten million.
              value={`${formatAmount(quote.amount)} ${selected?.sourceCurrency ?? ''}`.trim()}
            />
            <KeyValue
              label={`Recipient receives (${selected?.destCurrency ?? 'local'})`}
              value={formatRate(quote.totalDisplay)}
            />
            <KeyValue label="Rate applied" value={`1 → ${formatAmount(quote.clientRate)}`} />
            <KeyValue
              label="Fees"
              value={`${formatRate(quote.feeDisplay)} ${selected?.destCurrency ?? ''}`.trim()}
            />
            <KeyValue label="Spread" value={`${(quote.spreadBps / 100).toFixed(2)}%`} />
            <View style={styles.quoteFooter}>
              <Text style={styles.hashLabel}>
                Signature {shortId(quote.signature, 10, 6)} · key {shortId(quote.signingKey, 6, 4)}
              </Text>
              <Text style={styles.hashLabel}>
                Valid until {new Date(quote.validUntil).toISOString().slice(11, 19)} UTC
              </Text>
            </View>
          </Card>

          <Card title="What this transfer requires" tone={preflight.requiredTier === 'ENHANCED' ? 'warn' : 'neutral'}>
            <View style={styles.tierRow}>
              <StatusPill
                label={preflight.requiredTier}
                tone={preflight.requiredTier === 'NONE' ? 'good' : 'warn'}
              />
              <Text style={styles.body}>
                {preflight.requiredTier === 'NONE'
                  ? 'No identity check is needed for this amount.'
                  : preflight.requiredTier === 'STANDARD'
                    ? 'A government-ID verification is required before this can be claimed.'
                    : 'Enhanced due diligence applies: source of funds must be provided.'}
              </Text>
            </View>
            {!preflight.withinDailyLimit && (
              <Banner tone="bad" title="Above the corridor's daily limit">
                <Text style={styles.bannerText}>
                  This amount exceeds the configured daily limit. Reduce it to continue.
                </Text>
              </Banner>
            )}
            <Text style={styles.hashLabel}>
              Tier bands are enforced by the compliance hook contract, not by this app.
            </Text>
          </Card>

          {preflight.requiredTier !== 'NONE' && (
            <Banner tone="info" title="Verification comes first">
              <Text style={styles.bannerText}>
                For this amount the sender must complete verification before the claim code is
                useful. The app does not collect documents; it routes to the KYC flow and publishes
                only the resulting attestation hash on-chain.
              </Text>
            </Banner>
          )}

          <Button
            label="Create claim code"
            onPress={() => void startTransfer()}
            disabled={!preflight.withinDailyLimit || preflight.requiredTier !== 'NONE'}
            loading={busy}
          />
        </>
      )}

      {senderAddress !== null && (
        <Card title="Your sending account">
          <Text style={styles.hashLabel}>{senderAddress}</Text>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, color: colors.ink700, lineHeight: 20 },
  bannerText: { fontSize: 13, color: colors.ink700, lineHeight: 19 },
  corridorList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  corridorChip: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 44,
    justifyContent: 'center',
  },
  corridorChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  corridorChipText: { ...typography.subtitle, color: colors.ink900 },
  corridorChipTextActive: { color: colors.primaryText },
  corridorChipSub: { fontSize: 12, color: colors.ink500 },
  quoteFooter: { marginTop: spacing.xs, gap: 2 },
  hashLabel: { fontSize: 12, color: colors.ink500, fontFamily: 'monospace' },
  tierRow: { gap: spacing.xs },
});
