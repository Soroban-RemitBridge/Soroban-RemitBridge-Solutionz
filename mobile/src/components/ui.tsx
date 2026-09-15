import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, spacing, typography } from '@/theme';

/**
 * Shared primitives.
 *
 * Plain React Native rather than a component library, deliberately. This app
 * runs on cheap Android hardware in shops where the recipient is standing in
 * front of an agent; the fewer layers between a tap and a native view, the fewer
 * ways the one screen that must always work can fail.
 *
 * Every control here is a single `Pressable` with a minimum touch target size,
 * because the people using it are often holding a phone in one hand while
 * counting cash with the other.
 */

const MIN_TOUCH_TARGET = 48;

export function Screen({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.screenHeader}>
          <Text style={styles.screenTitle}>{title}</Text>
          {subtitle !== undefined && <Text style={styles.screenSubtitle}>{subtitle}</Text>}
        </View>
        {children}
      </ScrollView>
      {footer !== undefined && <View style={styles.footer}>{footer}</View>}
    </SafeAreaView>
  );
}

export function Card({
  title,
  children,
  tone = 'neutral',
}: {
  title?: string;
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}) {
  const toneStyle =
    tone === 'neutral'
      ? null
      : { backgroundColor: TONE_SURFACE[tone], borderColor: TONE_BORDER[tone] };
  return (
    <View style={[styles.card, toneStyle]}>
      {title !== undefined && <Text style={styles.cardTitle}>{title}</Text>}
      {children}
    </View>
  );
}

const TONE_SURFACE = {
  good: colors.goodSurface,
  warn: colors.warnSurface,
  bad: colors.badSurface,
  info: colors.infoSurface,
} as const;

const TONE_BORDER = {
  good: '#a7f3d0',
  warn: '#fde68a',
  bad: '#fecdd3',
  info: '#bae6fd',
} as const;

const TONE_TEXT = {
  good: colors.good,
  warn: colors.warn,
  bad: colors.bad,
  info: colors.info,
  neutral: colors.ink700,
} as const;

/** One status vocabulary for the whole app, so two screens cannot disagree. */
export function StatusPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: keyof typeof TONE_TEXT;
}) {
  return (
    <View style={[styles.pill, { borderColor: TONE_TEXT[tone] }]}>
      <Text style={[styles.pillText, { color: TONE_TEXT[tone] }]}>{label}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        pressed && !inactive && styles.buttonPressed,
        inactive && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.primaryText : colors.ink700} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant !== 'primary' && styles.buttonTextSecondary,
            variant === 'danger' && styles.buttonTextDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...inputProps
}: { label: string; hint?: string | undefined } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.ink300}
        style={styles.input}
        {...inputProps}
      />
      {hint !== undefined && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
}

/** An inline explanation, not an alert: used for things the user should read. */
export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'good' | 'warn' | 'bad' | 'info';
  title: string;
  children?: ReactNode;
}) {
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: TONE_SURFACE[tone], borderColor: TONE_BORDER[tone] },
      ]}
    >
      <Text style={[styles.bannerTitle, { color: TONE_TEXT[tone] }]}>{title}</Text>
      {children !== undefined && <View style={styles.bannerBody}>{children}</View>}
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueLabel}>{label}</Text>
      <Text style={styles.keyValueText}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  screenHeader: { gap: spacing.xs },
  screenTitle: { ...typography.title, color: colors.ink900 },
  screenSubtitle: { ...typography.body, color: colors.ink500 },
  footer: {
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { ...typography.label, color: colors.ink500 },
  pill: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  buttonDanger: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#fda4af',
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: 16, fontWeight: '600', color: colors.primaryText },
  buttonTextSecondary: { color: colors.ink900 },
  buttonTextDanger: { color: colors.bad },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.label, color: colors.ink500 },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    fontSize: 16,
    color: colors.ink900,
    backgroundColor: colors.surface,
  },
  fieldHint: { fontSize: 12, color: colors.ink500 },
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  bannerTitle: { fontSize: 14, fontWeight: '700' },
  bannerBody: { gap: spacing.xs },
  keyValue: { gap: 2 },
  keyValueLabel: { fontSize: 12, color: colors.ink500 },
  keyValueText: { fontSize: 15, color: colors.ink900, fontWeight: '600' },
});

/**
 * Escape hatch for the few components that need to compose a card's own styles
 * (the scanner and the claim-code display). Exported after the stylesheet is
 * declared rather than before it — a `const` is not hoisted.
 */
export const uiStyles = styles;
