import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { setMeshUser } from '../lib/meshAuto';
import { harvestRelays } from '../lib/meshRelay';

// Phase 5B: the mesh agent follows the signed-in account. It starts the
// automatic chain (flush → upload → harvest → helper scan → offline beacon)
// as soon as the app is open and stops when nobody is signed in. It renders
// nothing — status lives on the Offline mesh screen.
function MeshAgent() {
  const { user } = useAuth();
  useEffect(() => {
    setMeshUser(user?.uid ?? null);
    return () => setMeshUser(null);
  }, [user?.uid]);
  return null;
}

// Web tracker = the owner's always-online device. While the lost phone stays
// offline, a helper's relay would otherwise sit encrypted and invisible until
// that phone reconnects (which may never happen). The tracker holds the same
// owner-only key backup, so it decrypts relays into locations every minute.
function WebRelayHarvest() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (Platform.OS !== 'web' || !uid) return;
    let stopped = false;
    const pull = async () => {
      if (stopped) return;
      try {
        await harvestRelays(uid);
      } catch {
        // offline / rules: retry next minute
      }
    };
    pull();
    const timer = setInterval(pull, 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [uid]);
  return null;
}

function ThemedStack() {
  const { palette, mode } = useTheme();
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: true,
          headerStyle: { backgroundColor: palette.bg },
          headerTintColor: palette.text,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
        <Stack.Screen name="devices" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="map" options={{ title: 'Fleet map' }} />
        <Stack.Screen name="mesh" options={{ title: 'Offline mesh' }} />
        <Stack.Screen name="add-device" options={{ title: 'Add this device' }} />
        <Stack.Screen name="device/[id]" options={{ title: 'Device' }} />
        <Stack.Screen name="privacy" options={{ title: 'Privacy Policy' }} />
        <Stack.Screen name="terms" options={{ title: 'Terms of Service' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <MeshAgent />
          <WebRelayHarvest />
          <ThemedStack />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
