import { useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { subscribeToDevice, updateDevice } from '../../lib/devices';
import { subscribeToLocations } from '../../lib/locations';
import {
  startTracking,
  stopTracking,
  pushCurrentLocationNow,
  isTracking,
} from '../../lib/tracking';
import DeviceMap from '../../components/DeviceMap';

export default function DeviceDetail() {
  const { id } = useLocalSearchParams();
  const { user } = useAuth();
  const [device, setDevice] = useState(null);
  const [history, setHistory] = useState([]);
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Clock for "this fix is N minutes old". Kept in state (updated by an effect)
  // so the render body never calls Date.now() directly.
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    const un1 = subscribeToDevice(user.uid, id, setDevice, (e) => setError(e.message));
    const un2 = subscribeToLocations(user.uid, id, 50, setHistory, (e) =>
      setError(e.message)
    );
    isTracking().then(setTracking).catch(() => {});
    return () => {
      un1();
      un2();
    };
  }, [user, id]);

  const guard = () => {
    if (!user) {
      router.replace('/login');
      return false;
    }
    return true;
  };

  const onSendNow = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      await pushCurrentLocationNow(user.uid, id);
    } catch (e) {
      Alert.alert('Location failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const { mode } = await startTracking(user.uid, id);
      setTracking(true);
      if (mode === 'foreground') {
        Alert.alert(
          'Foreground tracking only',
          'Background updates are unavailable in Expo Go on Android. Use a dev build for true background tracking.'
        );
      }
      // Android 13+ hides the persistent tracking notification (and any theft
      // alert) without POST_NOTIFICATIONS. Ask right here — this is the moment
      // the permission becomes relevant — but never let a refusal break tracking.
      try {
        const { ensureNotificationPermission } = require('../../lib/alerts');
        await ensureNotificationPermission();
      } catch {}
    } catch (e) {
      Alert.alert('Tracking failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      await stopTracking();
      setTracking(false);
    } catch (e) {
      Alert.alert('Stop failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onCheckSim = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const { ensureSimPermission, checkSimChange } = require('../../lib/sim');
      const { ensureNotificationPermission, sendLocalAlert } = require('../../lib/alerts');
      await ensureSimPermission();
      try {
        await ensureNotificationPermission();
      } catch {
        // alerts optional — swap flag still recorded
      }
      const res = await checkSimChange(user.uid, id, sendLocalAlert);
      Alert.alert(
        'SIM check',
        res.swapped
          ? 'SIM changed! Device marked LOST.'
          : res.firstSnapshot
            ? 'First baseline saved for this SIM.'
            : 'SIM unchanged.'
      );
    } catch (e) {
      Alert.alert('SIM check failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onSmsOwner = async () => {
    if (!guard()) return;
    if (!latest) return Alert.alert('No location', 'Send a location fix first.');
    setBusy(true);
    try {
      const { sendLocationSms } = require('../../lib/alerts');
      await sendLocationSms(device.ownerPhone, latest.lat, latest.lng, latest.battery);
    } catch (e) {
      Alert.alert('SMS failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onToggleLost = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      await updateDevice(user.uid, id, { isLost: !device.isLost });
    } catch (e) {
      Alert.alert('Update failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  const latest = history[0];
  const markers = history.slice(0, 20).map((h, i) => ({
    id: h.id,
    lat: h.lat,
    lng: h.lng,
    title: i === 0 ? 'Latest' : `Fix ${history.length - i}`,
    description: `Battery ${h.battery ?? '?'}% • ${h.source ?? ''}`,
    color: i === 0 ? 'red' : 'blue',
    acc: h.accuracy ?? null,
    at: h.timestamp?.toDate ? h.timestamp.toDate().getTime() : null,
  }));
  const fmtTs = (ts) => {
    try {
      return ts?.toDate ? ts.toDate().toLocaleString() : '';
    } catch {
      return '';
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{device.deviceName}</Text>
      <Text style={styles.sub}>
        {device.deviceModel} • Battery {device.lastBattery ?? '?'}% •{' '}
        {device.isLost ? 'LOST' : 'OK'}
      </Text>
      <Text style={styles.sub}>
        {latest
          ? `Latest fix: ${latest.lat.toFixed(5)}, ${latest.lng.toFixed(5)}` +
            `${latest.accuracy ? ` (±${Math.round(latest.accuracy)} m)` : ''}` +
            ` (${fmtTs(latest.timestamp)})`
          : 'No fixes yet — send the first location.'}
      </Text>
      {(() => {
        if (!latest || !now) return null;
        const ageMin = Math.round((now - new Date(latest.timestamp).getTime()) / 60000);
        if (!Number.isFinite(ageMin) || ageMin < 3) return null;
        return (
          <Text style={styles.warn}>
            This fix is {ageMin < 90 ? `${ageMin} min` : `${Math.round(ageMin / 60)} h`} old — tap
            “Send location now” for a fresh GPS reading.
          </Text>
        );
      })()}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={onSendNow} disabled={busy}>
          <Text style={styles.buttonText}>Send location now</Text>
        </Pressable>
        {tracking ? (
          <Pressable style={[styles.button, styles.stop]} onPress={onStop} disabled={busy}>
            <Text style={styles.buttonText}>Stop tracking</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.button} onPress={onStart} disabled={busy}>
            <Text style={styles.buttonText}>Track every 10 min</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.hint}>
        {tracking
          ? 'Tracking ON for this phone.'
          : 'Enable tracking on the phone you want to locate (uses this phone’s GPS).'}
      </Text>

      <Text style={styles.section}>SIM & theft protection</Text>
      <Text style={styles.sub}>
        SIM: {device.simCarrier ?? 'unknown carrier'}
        {device.simMccMnc ? ` • ${device.simMccMnc}` : ''} •{' '}
        {device.simSwapped ? 'SWAPPED — marked LOST' : 'no swap detected'}
      </Text>
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={onCheckSim} disabled={busy}>
          <Text style={styles.buttonText}>Check SIM now</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={onSmsOwner} disabled={busy}>
          <Text style={styles.buttonText}>SMS owner location</Text>
        </Pressable>
      </View>
      <Pressable
        style={[styles.button, device.isLost ? styles.stop : null]}
        onPress={onToggleLost}
        disabled={busy}
      >
        <Text style={styles.buttonText}>
          {device.isLost ? 'Clear LOST flag' : 'Mark LOST (emergency mode)'}
        </Text>
      </Pressable>

      <DeviceMap markers={markers} />

      <Text style={styles.section}>History ({history.length})</Text>
      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Text style={styles.item}>
            {item.lat.toFixed(5)}, {item.lng.toFixed(5)} • ±
            {item.accuracy == null ? '?' : `${Math.round(item.accuracy)}m`} •{' '}
            {item.battery ?? '?'}% • {fmtTs(item.timestamp)}
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
  error: { color: 'red' },
  warn: { color: '#b45309', fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 },
  button: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  stop: { backgroundColor: '#8B0000' },
  buttonText: { color: '#fff', fontWeight: '600' },
  hint: { color: '#666', fontSize: 12 },
  section: { fontWeight: '700', marginTop: 8 },
  item: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#eee' },
});
