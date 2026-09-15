import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, uiStyles } from '@/components/ui';
import { normaliseClaimCode } from '@/lib/claim';
import { colors, radius, spacing } from '@/theme';

/**
 * Agent-side scanner.
 *
 * Three details matter more than they look:
 *
 * - **The first scan wins.** Barcode callbacks fire many times a second, and
 *   handling each one would launch a lookup per frame. The ref latches on the
 *   first read and subsequent frames are ignored until the caller resets.
 * - **A scanned value is normalised, not trusted.** A QR could contain anything;
 *   it is treated as user input and passed through the same normalisation as
 *   typed characters, so a bad payload fails the same way a typo does.
 * - **Permission denial is a first-class path.** The agent gets a typed entry
 *   form instead of a dead end, because a shop with a broken camera still has to
 *   hand over cash.
 */
export function ScanClaimCode({
  onScanned,
  enabled = true,
}: {
  onScanned: (code: string) => void;
  enabled?: boolean;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanError, setScanError] = useState<string | null>(null);
  const handled = useRef(false);

  // A new code to scan should re-arm the latch.
  useEffect(() => {
    handled.current = false;
    setScanError(null);
  }, [enabled]);

  const handleScan = useCallback(
    (payload: string) => {
      if (handled.current) return;
      handled.current = true;
      const candidate = normaliseClaimCode(payload);
      if (candidate.length === 0) {
        handled.current = false;
        setScanError('That code contained no readable characters. Try again or type it in.');
        return;
      }
      onScanned(candidate);
    },
    [onScanned],
  );

  if (!permission) {
    return (
      <View style={uiStyles.card}>
        <Text style={styles.message}>Checking camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={uiStyles.card}>
        <Text style={styles.message}>
          {permission.canAskAgain
            ? 'The camera is used only to read a customer’s claim code. Nothing is recorded or uploaded.'
            : 'Camera access is off for this app. You can still type the claim code instead.'}
        </Text>
        {permission.canAskAgain && (
          <Button label="Allow camera" onPress={() => void requestPermission()} variant="secondary" />
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={enabled ? ({ data }) => handleScan(data) : undefined}
      />
      <Text style={styles.hint}>
        Point at the customer&rsquo;s claim code. If the camera is struggling, type the code below —
        both paths go through the same check.
      </Text>
      {scanError !== null && <Text style={styles.error}>{scanError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.sm },
  camera: {
    height: 260,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.ink900,
  },
  hint: { fontSize: 13, color: colors.ink500 },
  message: { fontSize: 14, color: colors.ink700 },
  error: { fontSize: 13, color: colors.bad, fontWeight: '600' },
});
