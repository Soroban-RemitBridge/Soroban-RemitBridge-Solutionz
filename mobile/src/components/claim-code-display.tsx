import * as Clipboard from 'expo-clipboard';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { formatClaimCode } from '@/lib/claim';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The claim code, as the sender writes it down and the recipient presents it.
 *
 * Both roles render this same component on purpose. The code the sender records
 * and the code the agent scans are the same string, and giving the two screens
 * different formatting is how a customer reads out a code that the agent's
 * scanner rejects — a failure that looks like fraud to everyone involved.
 *
 * The QR payload is the *canonical* code, not the hyphenated display form. A
 * scanner that received the hyphens would produce a reveal whose hash does not
 * match the transfer, so the separators exist only for human eyes.
 */
export function ClaimCodeDisplay({
  code,
  compact = false,
  onCopy,
}: {
  code: string;
  compact?: boolean;
  onCopy?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    onCopy?.();
    setTimeout(() => setCopied(false), 2_000);
  }, [code, onCopy]);

  return (
    <View style={compact ? styles.compactWrapper : styles.wrapper}>
      <View style={styles.qrFrame}>
        <QRCode
          value={code}
          size={compact ? 148 : 220}
          backgroundColor={colors.surface}
          color={colors.ink900}
        />
      </View>

      <Pressable accessibilityRole="button" onPress={() => void copy()} style={styles.codeBlock}>
        <Text style={styles.codeLabel}>Claim code</Text>
        <Text style={compact ? styles.codeCompact : styles.code}>{formatClaimCode(code)}</Text>
        <Text style={styles.copyHint}>{copied ? 'Copied' : 'Tap to copy'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', gap: spacing.md },
  compactWrapper: { alignItems: 'center', gap: spacing.sm },
  qrFrame: {
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  codeBlock: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignSelf: 'stretch',
  },
  codeLabel: { ...typography.label, color: colors.ink500 },
  code: {
    ...typography.code,
    color: colors.ink900,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  codeCompact: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.ink900,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  copyHint: { fontSize: 12, color: colors.ink500 },
});
