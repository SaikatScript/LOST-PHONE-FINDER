import { Stack } from 'expo-router';
import { AuthProvider } from '../context/AuthContext';

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: true }}>
        <Stack.Screen name="index" options={{ title: 'Lost Phone Finder' }} />
        <Stack.Screen name="login" options={{ title: 'Log in' }} />
        <Stack.Screen name="register" options={{ title: 'Create account' }} />
        <Stack.Screen name="devices" options={{ title: 'My Devices' }} />
        <Stack.Screen name="map" options={{ title: 'Fleet map' }} />
        <Stack.Screen name="mesh" options={{ title: 'Offline mesh' }} />
        <Stack.Screen name="add-device" options={{ title: 'Add this device' }} />
        <Stack.Screen name="device/[id]" options={{ title: 'Device' }} />
      </Stack>
    </AuthProvider>
  );
}
