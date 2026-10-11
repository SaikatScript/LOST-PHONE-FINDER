import { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { Link, router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { subscribeToDevices } from '../lib/devices';

export default function Devices() {
  const { user, logOut } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    const unsub = subscribeToDevices(
      user.uid,
      setDevices,
      (e) => setError(e.message)
    );
    return unsub;
  }, [user]);

  const onLogout = async () => {
    try {
      await logOut();
      router.replace('/login');
    } catch (e) {
      Alert.alert('Logout failed', e.message);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Devices</Text>
      <Text style={styles.sub}>{user?.email ?? ''}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={devices}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text>No devices yet. Add this phone below.</Text>}
        renderItem={({ item }) => (
          <Link
            href={{ pathname: '/device/[id]', params: { id: item.id } }}
            style={styles.card}
          >
            <Text style={styles.cardTitle}>{item.deviceName}</Text>
            <Text>{item.deviceModel}</Text>
            <Text>
              {item.isLost ? 'LOST' : 'OK'} • {item.simSwapped ? 'SIM swapped' : 'SIM OK'}
            </Text>
          </Link>
        )}
      />
      <Link href="/map" style={styles.buttonSecondary}>
        <Text style={styles.buttonSecondaryText}>Fleet map</Text>
      </Link>
      <Link href="/mesh" style={styles.buttonSecondary}>
        <Text style={styles.buttonSecondaryText}>Offline mesh</Text>
      </Link>
      <Link href="/add-device" style={styles.button}>
        <Text style={styles.buttonText}>Add this device</Text>
      </Link>
      <Pressable onPress={onLogout}>
        <Text style={styles.link}>Log out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  sub: { color: '#666' },
  error: { color: 'red' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, marginVertical: 6 },
  cardTitle: { fontWeight: '700', fontSize: 16 },
  button: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonSecondaryText: { color: '#111', fontWeight: '600' },
  link: { color: '#0B5FFF', textAlign: 'center', marginTop: 12 },
});
