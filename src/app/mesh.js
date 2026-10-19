import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { encodeBase64 } from 'tweetnacl-util';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { subscribeToDevices } from '../lib/devices';
import { ensureDeviceKeys, sealLocationPacket } from '../lib/meshCrypto';
import { enqueuePacket, listPackets, queueBackend, removePacket } from '../lib/meshQueue';
import { uploadRelay, harvestRelays, flushQueueAsGateway } from '../lib/meshRelay';
import { isBleAvailable, helperScanOnce, scanNearbyDevices, startBeacon, stopBeacon, addBeaconListener } from '../lib/meshBle';

// Android's AdvertiseCallback error codes → human text (Phase 4b beacon).
const ADV_ERROR = {
  1: 'the advertising packet is too large for this phone',
  2: 'too many apps are already advertising',
  3: 'advertising is already running',
  4: 'internal Bluetooth stack error',
  5: 'this phone does not support BLE advertising',
};

export default function Mesh() {
  const { user } = useAuth();
  const { palette } = useTheme();
  // Themed stylesheet (Phase 5A): derived from the active palette so this
  // screen stays readable in dark mode too.
  const styles = useMemo(() => createStyles(palette), [palette]);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [queue, setQueue] = useState([]);
  const [backend, setBackend] = useState('…');
  const [ble, setBle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [beaconOn, setBeaconOn] = useState(false);
  const [beaconStatus, setBeaconStatus] = useState('');
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
    // Initial hydration for this screen (queue/backend/BLE availability). The
    // disable below covers the intended one-shot setState inside refresh().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => {});
    // Heal the queue: foreign packets may have been read while this phone was
    // offline (their relay upload failed). Upload them now so the owner still
    // gets them. Own sealed packets are skipped inside flushQueueAsGateway.
    listPackets()
      .then((queued) => flushQueueAsGateway(user.uid, queued))
      .then((sent) => {
        if (sent) refresh().catch(() => {});
      })
      .catch(() => {});
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
        `Sealed → queued → uploaded → harvested. Checked ${res.checked}, decrypted ${res.opened}` +
          (res.blank ? `, ${res.blank} ping(s) with no position.` : '.') +
          ' See device history.'
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
      setInfo(
        `Harvested: checked ${res.checked}, decrypted ${res.opened}` +
          (res.blank ? `, ${res.blank} without a position (ping only).` : '.')
      );
    } catch (e) {
      Alert.alert('Harvest failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onScan = async () => {
    if (!guard()) return;
    setBusy(true);
    setInfo('Scanning for stolen-phone beacons…');
    try {
      let found = 0;
      const uploaded = new Set();
      const { packets, stats, trace } = await helperScanOnce(async (packet) => {
        found += 1;
        await enqueuePacket(packet);
        // One upload per packet per scan: the radio may hand us the same beacon
        // several times (address rotation), and each upload would add another
        // identical relay document for the owner to decrypt.
        if (!uploaded.has(packet.packetId)) {
          uploaded.add(packet.packetId);
          console.log('[mesh] relaying packet', found, packet.packetId);
          try {
            await uploadRelay(packet);
            // Uploaded — drop it from the local queue. If the write failed
            // (helper offline), the packet stays queued and the flush on the
            // next mesh-screen visit uploads it instead.
            await removePacket(packet.packetId);
          } catch {}
        }
        await refresh();
      }, 25000);
      // Report WHY nothing was found, not just that nothing was found.
      let verdict;
      if (stats.read > 0) {
        verdict = `${stats.read} packet(s) read and relayed.`;
      } else if (stats.seen === 0) {
        verdict =
          'No mesh beacon heard. Either the other phone is not beaconing, or it is out of range. ' +
          'Run "Radio check" on this phone to confirm its own Bluetooth scanning works.';
      } else if (stats.connected === 0) {
        verdict = `Heard ${stats.seen} beacon(s) but could not connect. First error: ${stats.errors[0] ?? 'unknown'}`;
      } else {
        verdict = `Connected to ${stats.connected} beacon(s) but the packet read failed. First error: ${stats.errors[0] ?? 'unknown'}`;
      }
      const traceText = trace?.length ? `\n\nSteps: ${trace.join(' → ')}` : '';
      setInfo(`Scan: heard ${stats.seen}, connected ${stats.connected}, read ${stats.read}.`);
      Alert.alert('Helper scan', `${verdict}\n\n(packets handled: ${packets.length})${traceText}`);
    } catch (e) {
      Alert.alert('Scan failed', e.message);
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  };

  // Radio self-check: is THIS phone's BLE working at all? Lists every nearby
  // BLE device with no filter, so an empty result points at permissions/radio
  // or Location being off, while a non-empty result clears the phone.
  const onRadioCheck = async () => {
    if (!guard()) return;
    setBusy(true);
    setInfo('Radio check: listing every nearby BLE device…');
    try {
      const list = await scanNearbyDevices(8000);
      setInfo(`Radio check: ${list.length} BLE device(s) heard.`);
      Alert.alert(
        'Radio check',
        list.length
          ? `Bluetooth scanning works — heard ${list.length} device(s):\n\n` +
              list.slice(0, 8).join('\n') +
              (list.length > 8 ? `\n…+${list.length - 8} more` : '')
          : 'Bluetooth scanning heard NOTHING nearby.\n\nCheck: Bluetooth ON, Location ON (required by Android for BLE scanning on Android 11), "Nearby devices" permission granted.'
      );
    } catch (e) {
      Alert.alert('Radio check failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  // Live beacon status from the native module (Phase 4b). The Kotlin side emits
  // started / error / helper-connected / packet-read events. Surfacing "error"
  // here is what turns a silent advertising failure into a visible one.
  useEffect(() => {
    let sub;
    try {
      sub = addBeaconListener((evt) => {
        const type = evt?.type;
        if (!type) return;
        if (type === 'error') {
          const code = /code (\d+)/.exec(evt.message ?? '')?.[1];
          const why = (code && ADV_ERROR[code]) || evt.message || 'unknown error';
          setBeaconOn(false);
          setBeaconStatus(`Beacon FAILED: ${why}`);
          Alert.alert('Beacon failed', why);
        } else if (type === 'started') {
          setBeaconOn(true);
          setBeaconStatus('Beacon: advertising ✓');
        } else if (type === 'helper-connected') {
          setBeaconStatus(`Beacon: helper connected (${evt.device ?? '?'})`);
        } else if (type === 'packet-read') {
          setBeaconStatus(`Beacon: packet served to helper (${evt.device ?? '?'})`);
        }
      });
    } catch {
      // native beacon module absent on this build — the toggle reports it
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, []);

  // Stolen role: seal this phone's current fix and broadcast it over BLE for
  // nearby helpers. Toggle off when done (beacon dies with the app anyway).
  const onToggleBeacon = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      if (beaconOn) {
        await stopBeacon();
        setBeaconOn(false);
        setBeaconStatus('Beacon stopped.');
        setInfo('Beacon stopped.');
        return;
      }
      const Location = require('expo-location');
      // A stolen phone is often indoors, in a bag or in a moving car: a brand-new
      // GPS fix can take minutes or never arrive. Try briefly, fall back to the
      // last known fix, and beacon anyway with a blank position rather than
      // staying silent — a packet with no coordinates still proves the phone is
      // alive and within radio range of a helper.
      let fix = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60 * 1000 }).catch(() => null);
      if (!fix) {
        fix = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
        ]);
      }
      const hasFix = !!fix?.coords;
      const kp = await ensureDeviceKeys(user.uid, deviceId);
      const packet = await sealLocationPacket({
        ownerId: user.uid,
        deviceId,
        lat: hasFix ? fix.coords.latitude : null,
        lng: hasFix ? fix.coords.longitude : null,
        accuracy: hasFix ? fix.coords.accuracy ?? null : null,
        battery: null,
        ownerPubB64: encodeBase64(kp.publicKey),
      });
      await startBeacon(packet);
      setBeaconOn(true);
      setBeaconStatus(
        hasFix
          ? 'Beacon: starting… (waiting for the Bluetooth stack to confirm)'
          : 'Beacon: starting… (no GPS fix yet — the packet carries an empty position)'
      );
      setInfo(
        hasFix
          ? 'Beacon ON — nearby helpers can now find this phone over BLE.'
          : 'Beacon ON (last-known position unavailable) — helpers can still relay the ping.'
      );
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
      <Text style={styles.title}>Offline mesh (Phase 4a + 4b)</Text>
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
            <Text style={item.id === deviceId ? styles.chipTextOn : styles.chipText}>
              {item.deviceName}
            </Text>
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
      <View style={styles.row}>
        <Pressable style={[styles.button, styles.buttonAlt]} onPress={onRadioCheck} disabled={busy}>
          <Text style={[styles.buttonText, styles.buttonAltText]}>Radio check (list nearby BLE)</Text>
        </Pressable>
      </View>
      <Pressable style={styles.button} onPress={onToggleBeacon} disabled={busy}>
        <Text style={styles.buttonText}>
          {beaconOn ? 'Stop BLE beacon (stolen role)' : 'Start BLE beacon (stolen role)'}
        </Text>
      </Pressable>
      {beaconStatus ? <Text style={styles.status}>{beaconStatus}</Text> : null}
      <Text style={styles.hint}>
        {'Beacon broadcasts this phone\u2019s sealed location to nearby helpers over Bluetooth \u2014 the offline path. No internet needed on this phone while beaconing.'}
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

const createStyles = (palette) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, gap: 8, backgroundColor: palette.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.bg },
    title: { fontSize: 20, fontWeight: '700', color: palette.text },
    sub: { color: palette.textDim },
    section: { fontWeight: '700', marginTop: 8, color: palette.text },
    hint: { color: palette.textDim, fontSize: 12 },
    row: { flexDirection: 'row', gap: 8 },
    button: {
      flex: 1,
      backgroundColor: palette.accent,
      borderRadius: 10,
      padding: 12,
      alignItems: 'center',
      marginTop: 4,
    },
    buttonText: { color: palette.onAccent, fontWeight: '600', textAlign: 'center' },
    buttonAlt: { backgroundColor: palette.accentSoft, borderWidth: 1, borderColor: palette.accent },
    buttonAltText: { color: palette.accent },
    chip: {
      borderWidth: 1,
      borderColor: palette.borderStrong,
      borderRadius: 16,
      padding: 8,
      marginRight: 8,
    },
    chipText: { color: palette.textDim },
    chipOn: { backgroundColor: palette.accent, borderColor: palette.accent },
    chipTextOn: { color: palette.onAccent },
    status: { color: palette.success, fontSize: 12, fontWeight: '600' },
    item: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: palette.border, color: palette.text },
  });
