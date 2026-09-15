import '@/polyfills';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/theme';

/**
 * Root layout.
 *
 * `@/polyfills` is imported first and must stay first: it installs `Buffer` and
 * a cryptographically secure `getRandomValues` before anything that mints a
 * claim code loads. Import order is the only thing enforcing this, so the import
 * is a comment-worthy dependency rather than a decoration.
 *
 * `headerBackVisible: false` on the claim-code screen is deliberate. Going back
 * from it would regenerate the code on the next attempt while the customer may
 * already have written the old one down — the transfer would then be unclaimable
 * and it would look like the app lost their money.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { color: colors.ink900 },
          headerTintColor: colors.ink900,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'RemitBridge' }} />
        <Stack.Screen name="sender/index" options={{ title: 'Send money' }} />
        <Stack.Screen
          name="sender/claim"
          options={{ title: 'Claim code', headerBackVisible: false }}
        />
        <Stack.Screen name="recipient/index" options={{ title: 'Collect cash' }} />
        <Stack.Screen name="agent/index" options={{ title: 'Pay out' }} />
        <Stack.Screen name="agent/float" options={{ title: 'Float and bond' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
