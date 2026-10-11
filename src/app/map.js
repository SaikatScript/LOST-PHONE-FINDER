import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { subscribeToDevices } from '../lib/devices';
import DeviceMap from '../components/DeviceMap';

export default function MapOverview() {
  const { user } = useAuth();
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
      description: `Battery ${d.lastBattery ?? '?'}% • ${d.isLost ? 'LOST' : 'OK'}`,
      color: d.isLost ? 'red' : 'green',
    }));

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Fleet map</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {markers.length === 0 ? (
        <Text>No devices with a location yet. Open a device and tap “Send location now”.</Text>
      ) : (
        <DeviceMap markers={markers} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: '700' },
  error: { color: 'red' },
});
