import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { subscribeToDevices } from '../lib/devices';
import DeviceMap from '../components/DeviceMap';
import { Screen, EmptyState } from '../components/ui';
import { space } from '../theme';

export default function MapOverview() {
  const { user } = useAuth();
  const { palette } = useTheme();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    return subscribeToDevices(user.uid, setDevices, (e) => setError(e.message));
  }, [user]);

  const markers = devices
    .filter((d) => d.lastLocation?.latitude != null)
    .map((d) => ({
      id: d.id,
      lat: d.lastLocation.latitude,
      lng: d.lastLocation.longitude,
      title: d.deviceName,
      description:
        `Battery ${d.lastBattery ?? '?'}% • ${d.isLost ? 'LOST' : 'OK'}` +
        (d.lastLocationSource === 'mesh' ? ' • via mesh relay' : ''),
      color: d.isLost ? 'red' : 'green',
      // Accuracy + fix clock ride along in the device rollup so the map can show
      // "accurate to ~25 m" and "12 min ago" in the marker popup.
      acc: d.lastAccuracy ?? null,
      at: d.lastLocationAt ?? null,
    }));

  return (
    <Screen pad={false} edges={['bottom']} style={{ gap: space.sm }}>
      <View style={{ padding: space.lg, paddingBottom: 0, gap: 4 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: palette.text }}>Fleet map</Text>
        <Text style={{ color: palette.textDim, fontSize: 12 }}>
          Satellite by default — layers button (top-right) for Streets/Terrain, ◎ to re-centre.
        </Text>
      </View>
      {error ? (
        <Text style={{ color: palette.danger, paddingHorizontal: space.lg }}>{error}</Text>
      ) : null}
      {markers.length === 0 ? (
        <EmptyState
          icon="🗺️"
          title="No locations yet"
          hint="Open a device and tap “Send location now” to place it on the map."
        />
      ) : (
        <View style={{ flex: 1 }}>
          <DeviceMap markers={markers} />
        </View>
      )}
    </Screen>
  );
}
