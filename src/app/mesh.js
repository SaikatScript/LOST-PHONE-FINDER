import { useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { encodeBase64 } from 'tweetnacl-util';
import { useAuth } from '../context/AuthContext';
import { subscribeToDevices } from '../lib/devices';
import { ensureDeviceKeys, sealLocationPacket } from '../lib/meshCrypto';
import { enqueuePacket, listPackets, queueBackend, removePacket } from '../lib/meshQueue';
import { uploadRelay, harvestRelays } from '../lib/meshRelay';
import { isBleAvailable, helperScanOnce, startBeacon, stopBeacon } from '../lib/meshBle';

export default function Mesh() {
  const { user } = useAuth();
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [queue, setQueue] = useState([]);
  const [backend, setBackend] = useState('…');
  const [ble, setBle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [beaconOn, setBeaconOn] = useState(false);
  const [info, setInfo] = useState('');

  const refresh = async () => {
    setQueue(await listPackets().catch(() => []));
    setBackend(await queueBackend().catch(() => '?'));
    setBle(isBleAvailable());
  };

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    refresh().catch(() => {});
    return subscribeToDevices(
      user.uid,
      (ds) => {
        setDevices(ds);
        if (!deviceId && ds.length) setDeviceId(ds[0].id);
      },
      (e) => setInfo(e.message)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const guard = () => {
    if (!user) {
      router.replace('/login');
      return false;
    }
    if (!deviceId) {
      Alert.alert('No device', 'Add a device first.');
      return false;
    }
    return true;
  };

  // Full cloud-path E2E test: seal current GPS → queue → upload → harvest →
  // decrypt → location appears in device history. No BLE needed.
  const onTestRelay = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const Location = require('expo-location');
      const pos = await Location.getCurrentPositionAsync({});
      const kp = await ensureDeviceKeys(user.uid, deviceId);
      const packet = await sealLocationPacket({
        ownerId: user.uid,
        deviceId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        battery: null,
        ownerPubB64: encodeBase64(kp.publicKey),
      });
      await enqueuePacket(packet);
      await uploadRelay(packet);
      await removePacket(packet.packetId);
      const res = await harvestRelays(user.uid);
      await refresh();
      Alert.alert(
        'Relay test',
        `Sealed → queued → uploaded → harvested. Checked ${res.checked}, decrypted ${res.opened}. See device history.`
      );
    } catch (e) {
      Alert.alert('Relay test failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onHarvest = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const res = await harvestRelays(user.uid);
      await refresh();
      setInfo(`Harvested: checked ${res.checked}, decrypted ${res.opened}.`);
    } catch (e) {
      Alert.alert('Harvest failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onScan = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      let found = 0;
      await helperScanOnce(async (packet) => {
        found += 1;
        await enqueuePacket(packet);
        try {
          await uploadRelay(packet);
        } catch {}
        await refresh();
      }, 25000);
      Alert.alert('Helper scan', `Scan finished, ${found} stolen packet(s) relayed.`);
    } catch (e) {
      Alert.alert('Scan failed', e.message);
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  };

  // Stolen role: seal this phone's current fix and broadcast it over BLE for
  // nearby helpers. Toggle off when done (beacon dies with the app anyway).
  const onToggleBeacon = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      if (beaconOn) {
        await stopBeacon();
        setBeaconOn(false);
        setInfo('Beacon stopped.');
        return;
      }
      const Location = require('expo-location');
      const pos = await Location.getCurrentPositionAsync({});
      const kp = await ensureDeviceKeys(user.uid, deviceId);
      const packet = await sealLocationPacket({
        ownerId: user.uid,
        deviceId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        battery: null,
        ownerPubB64: encodeBase64(kp.publicKey),
      });
      await startBeacon(packet);
      setBeaconOn(true);
      setInfo('Beacon ON — nearby helpers can now find this phone over BLE.');
    } catch (e) {
      Alert.alert('Beacon failed', e.message);
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  };

  if (!user) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Offline mesh (Phase 4a)</Text>
      <Text style={styles.sub}>
        Queue: {backend} • {queue.length} packet(s) • BLE scan: {ble ? 'ready' : 'needs new build'}
      </Text>
      {info ? <Text style={styles.sub}>{info}</Text> : null}

      <Text style={styles.section}>Act as device</Text>
      <FlatList
        horizontal
        data={devices}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.chip, item.id === deviceId ? styles.chipOn : null]}
            onPress={() => setDeviceId(item.id)}
          >
            <Text style={item.id === deviceId ? styles.chipTextOn : null}>{item.deviceName}</Text>
          </Pressable>
        )}
      />

      <Pressable style={styles.button} onPress={onTestRelay} disabled={busy}>
        <Text style={styles.buttonText}>Test relay (seal → queue → upload → harvest)</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={onHarvest} disabled={busy}>
          <Text style={styles.buttonText}>Harvest my relays</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={onScan} disabled={busy}>
          <Text style={styles.buttonText}>Helper BLE scan</Text>
        </Pressable>
      </View>
      <Pressable style={styles.button} onPress={onToggleBeacon} disabled={busy}>
        <Text style={styles.buttonText}>
          {beaconOn ? 'Stop BLE beacon (stolen role)' : 'Start BLE beacon (stolen role)'}
        </Text>
      </Pressable>
      <Text style={styles.hint}>
        Beacon broadcasts this phone's sealed location to nearby helpers over Bluetooth —
        the offline path. No internet needed on this phone while beaconing.
      </Text>

      <Text style={styles.section}>Queue ({queue.length})</Text>
      <FlatList
        data={queue}
        keyExtractor={(p) => p.packetId}
        renderItem={({ item }) => (
          <Text style={styles.item}>
            {item.packetId} • hops {item.hops ?? 0}
          </Text>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  sub: { color: '#555' },
  section: { fontWeight: '700', marginTop: 8 },
  hint: { color: '#666', fontSize: 12 },
  row: { flexDirection: 'row', gap: 8 },
  button: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  chip: { borderWidth: 1, borderColor: '#111', borderRadius: 16, padding: 8, marginRight: 8 },
  chipOn: { backgroundColor: '#111' },
  chipTextOn: { color: '#fff' },
  item: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#eee' },
});
