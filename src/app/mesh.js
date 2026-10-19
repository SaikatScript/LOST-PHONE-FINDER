import { useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { encodeBase64 } from 'tweetnacl-util';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { subscribeToDevices } from '../lib/devices';
import { ensureDeviceKeys, sealLocationPacket } from '../lib/meshCrypto';
import { listPackets, queueBackend } from '../lib/meshQueue';
import { uploadRelay, harvestRelays } from '../lib/meshRelay';
import {
  isBleAvailable,
  helperScanOnce,
  scanNearbyDevices,
  addBeaconListener,
} from '../lib/meshBle';
import {
  subscribeMeshStatus,
  runMeshNow,
  manualBeacon,
  manualBeaconStop,
} from '../lib/meshAuto';
import { Screen, Card, Chip, Button, SectionTitle, StatusDot, EmptyState } from '../components/ui';
import { space } from '../theme';

// Android's AdvertiseCallback error codes → human text.
const ADV_ERROR = {
  1: 'the advertising packet is too large for this phone',
  2: 'too many apps are already advertising',
  3: 'advertising is already running',
  4: 'internal Bluetooth stack error',
  5: 'this phone does not support BLE advertising',
};

function sinceText(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export default function Mesh() {
  const { user } = useAuth();
  const { palette } = useTheme();
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [queue, setQueue] = useState([]);
  const [backend, setBackend] = useState('…');
  const [ble, setBle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [agent, setAgent] = useState(null);

  useEffect(() => subscribeMeshStatus(setAgent), []);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // Live beacon events from the native module (helper-connected / served).
  useEffect(() => {
    let sub;
    try {
      sub = addBeaconListener((evt) => {
        const type = evt?.type;
        if (!type) return;
        if (type === 'error') {
          const code = /code (\d+)/.exec(evt.message ?? '')?.[1];
          const why = (code && ADV_ERROR[code]) || evt.message || 'unknown error';
          setInfo(`Broadcast failed: ${why}`);
        } else if (type === 'helper-connected') {
          setInfo(`A nearby phone connected to carry this fix (${evt.device ?? '?'}).`);
        } else if (type === 'packet-read') {
          setInfo(`A nearby phone picked up this fix (${evt.device ?? '?'}). It will be uploaded to your account.`);
        }
      });
    } catch {
      // native beacon module absent on this build — nothing to listen to
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, []);

  const guard = () => {
    if (!user) {
      router.replace('/login');
      return false;
    }
    return true;
  };

  const guardDevice = () => {
    if (!guard()) return false;
    if (!deviceId) {
      Alert.alert('No device', 'Add a device first.');
      return false;
    }
    return true;
  };

  // --- Advanced / diagnostic actions (the daily flow is fully automatic) ----

  const onUpdateNow = async () => {
    setBusy(true);
    try {
      await runMeshNow();
      await refresh();
      setInfo('Updated: queue flushed, uploads and harvest done.');
    } catch (e) {
      setInfo(`Update failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const onTestRelay = async () => {
    if (!guardDevice()) return;
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
      await uploadRelay(packet);
      const res = await harvestRelays(user.uid);
      await refresh();
      Alert.alert(
        'Sealed packet test',
        `Sealed → uploaded → decrypted. Checked ${res.checked}, decrypted ${res.opened}` +
          (res.blank ? `, ${res.blank} ping(s) with no position.` : '.') +
          ' See device history.'
      );
    } catch (e) {
      Alert.alert('Test failed', e.message);
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
        `Checked ${res.checked} relay(s), decrypted ${res.opened}` +
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
    setInfo('Scanning for nearby lost phones…');
    try {
      let found = 0;
      const { stats, trace } = await helperScanOnce(async (packet) => {
        found += 1;
        try {
          await uploadRelay(packet);
        } catch {
          // stays in the queue — the agent uploads it when internet returns
        }
      }, 25000);
      let verdict;
      if (stats.read > 0) verdict = `${stats.read} packet(s) read and relayed.`;
      else if (stats.seen === 0) {
        verdict =
          'No lost phone heard nearby. (Their app only broadcasts while it has no internet.)';
      } else if (stats.connected === 0) {
        verdict = `Heard ${stats.seen} beacon(s) but could not connect. First error: ${stats.errors[0] ?? 'unknown'}`;
      } else {
        verdict = `Connected to ${stats.connected} beacon(s) but the read failed. First error: ${stats.errors[0] ?? 'unknown'}`;
      }
      const traceText = trace?.length ? `\n\nSteps: ${trace.join(' → ')}` : '';
      setInfo(`Scan: heard ${stats.seen}, connected ${stats.connected}, read ${stats.read}.`);
      Alert.alert('Manual scan', `${verdict}\n\n(packets handled: ${found})${traceText}`);
    } catch (e) {
      Alert.alert('Scan failed', e.message);
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  };

  const onRadioCheck = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const list = await scanNearbyDevices(8000);
      Alert.alert(
        'Radio check',
        list.length
          ? `Bluetooth scanning works — heard ${list.length} device(s):\n\n` +
              list.slice(0, 8).join('\n') +
              (list.length > 8 ? `\n…+${list.length - 8} more` : '')
          : 'Bluetooth heard NOTHING nearby.\n\nCheck: Bluetooth ON, Location ON (Android requires it for BLE scanning), "Nearby devices" permission granted.'
      );
    } catch (e) {
      Alert.alert('Radio check failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  // Manual broadcast: only needed for testing — the app starts it by itself
  // when a fix cannot be uploaded.
  const onToggleBeacon = async () => {
    if (!guardDevice()) return;
    setBusy(true);
    try {
      if (agent?.beaconOn) {
        await manualBeaconStop();
        setInfo('Broadcast stopped.');
        return;
      }
      const Location = require('expo-location');
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
      await manualBeacon(packet);
      setInfo(
        hasFix
          ? 'Broadcasting — nearby phones can now carry this fix.'
          : 'Broadcasting (no position yet) — nearby phones can still carry the ping.'
      );
    } catch (e) {
      Alert.alert('Broadcast failed', e.message);
    } finally {
      setBusy(false);
      refresh().catch(() => {});
    }
  };

  if (!user) {
    return (
      <Screen centered>
        <ActivityIndicator color={palette.accent} />
      </Screen>
    );
  }

  const st = agent ?? {};
  // One plain-language headline for whatever the agent is doing right now.
  let hero = { tone: 'ok', title: 'Automatic protection is on', text: 'Nothing to do — fixes upload and sync by themselves.' };
  if (st.beaconOn) {
    hero = {
      tone: 'warn',
      title: 'No internet — broadcasting over Bluetooth',
      text: 'This phone sealed its location and is sending it to nearby Lost Phone Finder phones. It reaches your account automatically.',
    };
  } else if ((st.queuedOwn ?? 0) > 0) {
    hero = {
      tone: 'warn',
      title: 'Waiting for internet',
      text: `${st.queuedOwn} fix(es) saved on this phone. They upload automatically — no action needed.`,
    };
  } else if (st.scanning) {
    hero = {
      tone: 'info',
      title: 'Checking for lost phones nearby',
      text: 'Listening over Bluetooth for a phone that needs to get its location out.',
    };
  } else if (st.online === false) {
    hero = {
      tone: 'warn',
      title: 'No internet right now',
      text: 'Fixes are saved here and upload automatically when internet returns.',
    };
  }

  return (
    <Screen scroll>
      <Card tone={hero.tone === 'ok' ? 'success' : hero.tone === 'info' ? undefined : 'warning'}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <StatusDot tone={hero.tone} size={10} />
          <Text style={{ flex: 1, color: palette.text, fontSize: 16, fontWeight: '800' }}>
            {hero.title}
          </Text>
        </View>
        <Text style={{ color: palette.textDim, fontSize: 13, lineHeight: 19 }}>{hero.text}</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Chip label={`${st.queuedTotal ?? queue.length} in queue`} />
          {st.beaconOn ? <Chip tone="warn" dot label="broadcasting" /> : null}
          {st.scanning ? <Chip tone="info" dot label="scanning" /> : null}
          {st.online === true ? <Chip tone="ok" dot label="internet ok" /> : null}
        </View>
      </Card>

      <SectionTitle>Live status</SectionTitle>
      <Card>
        <StatusRow label="Mesh protection" value={st.active ? 'running' : 'stopped'} tone={st.active ? 'ok' : 'neutral'} />
        <StatusRow
          label="Internet"
          value={st.online === true ? 'connected' : st.online === false ? 'offline' : '—'}
          tone={st.online === true ? 'ok' : st.online === false ? 'warn' : 'neutral'}
        />
        <StatusRow label="Queue" value={`${st.queuedTotal ?? queue.length} packet(s) · ${backend}`} />
        <StatusRow
          label="Broadcasting (Bluetooth)"
          value={st.beaconOn ? 'ON' : 'off'}
          tone={st.beaconOn ? 'warn' : 'neutral'}
        />
        <StatusRow
          label="Last helper scan"
          value={
            st.lastScanAt
              ? `${sinceText(st.lastScanAt)} — heard ${st.lastScanSeen ?? 0}, read ${st.lastScanRead ?? 0}`
              : 'starting…'
          }
        />
        <StatusRow label="Carried for others" value={`${st.relayedUp ?? 0} packet(s)`} />
        <StatusRow
          label="Last sync from relays"
          value={st.lastHarvestAt ? `${sinceText(st.lastHarvestAt)} (${st.lastHarvestText})` : 'pending'}
        />
        {st.note ? (
          <Text style={{ color: palette.warning, fontSize: 12 }}>{st.note}</Text>
        ) : null}
        {st.lastScanError ? (
          <Text style={{ color: palette.textFaint, fontSize: 12 }}>Last scan note: {st.lastScanError}</Text>
        ) : null}
        <Button
          compact
          tone="secondary"
          style={{ alignSelf: 'flex-start', marginTop: space.xs }}
          title="Update now"
          onPress={onUpdateNow}
          busy={busy}
        />
      </Card>

      {info ? <Text style={{ color: palette.textDim, fontSize: 13 }}>{info}</Text> : null}

      <SectionTitle>How it works</SectionTitle>
      <Card>
        {[
          'No internet? This phone seals its location and broadcasts it over Bluetooth.',
          'Any nearby Lost Phone Finder phone picks it up automatically — no taps needed.',
          'As soon as any of those phones has internet, the fix lands in your account.',
        ].map((line, i) => (
          <View key={line} style={{ flexDirection: 'row', gap: 10 }}>
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: palette.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: palette.accent, fontSize: 11, fontWeight: '800' }}>{i + 1}</Text>
            </View>
            <Text style={{ flex: 1, color: palette.textDim, fontSize: 13, lineHeight: 19 }}>{line}</Text>
          </View>
        ))}
      </Card>

      <Pressable onPress={() => setShowAdvanced((v) => !v)}>
        <Text style={{ color: palette.accent, fontWeight: '700', fontSize: 13 }}>
          {showAdvanced ? 'Hide advanced tools ▴' : 'Advanced tools (testing only) ▾'}
        </Text>
      </Pressable>

      {showAdvanced ? (
        <>
          <Card>
            <Text style={{ color: palette.textDim, fontSize: 13 }}>
              Manual tools used during testing. The app does all of this by itself.
            </Text>
            <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>Act as device</Text>
            <FlatList
              horizontal
              data={devices}
              keyExtractor={(d) => d.id}
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => (
                <Pressable onPress={() => setDeviceId(item.id)}>
                  <Chip
                    style={{ marginRight: 8 }}
                    tone={item.id === deviceId ? 'accent' : 'neutral'}
                    label={item.deviceName}
                  />
                </Pressable>
              )}
            />
            <Button
              compact
              tone="secondary"
              title="Sealed packet test (upload + decrypt)"
              onPress={onTestRelay}
              disabled={busy}
            />
            <Button
              compact
              tone="secondary"
              title="Harvest my relays now"
              onPress={onHarvest}
              disabled={busy}
            />
            <Button
              compact
              tone="secondary"
              title="Scan for lost phones now (25 s)"
              onPress={onScan}
              disabled={busy}
            />
            <Button
              compact
              tone="secondary"
              title="Radio check (list nearby Bluetooth)"
              onPress={onRadioCheck}
              disabled={busy}
            />
            <Button
              compact
              tone={agent?.beaconOn ? 'dangerGhost' : 'secondary'}
              title={agent?.beaconOn ? 'Stop manual broadcast' : 'Start manual broadcast (test)'}
              onPress={onToggleBeacon}
              disabled={busy}
            />
            <Text style={{ color: palette.textFaint, fontSize: 12 }}>
              Bluetooth scan: {ble ? 'ready on this phone' : 'needs a newer app build'}
            </Text>
          </Card>

          <SectionTitle>Queue ({queue.length})</SectionTitle>
          <Card style={{ paddingVertical: 4 }}>
            {queue.length === 0 ? (
              <EmptyState
                icon="📭"
                title="Queue is empty"
                hint="Sealed fixes appear here only while they are still waiting for upload."
              />
            ) : (
              queue.map((p) => (
                <Text
                  key={p.packetId}
                  style={{
                    color: palette.textDim,
                    fontSize: 12,
                    paddingVertical: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: palette.border,
                  }}
                >
                  {p.packetId.slice(0, 10)}… · hops {p.hops ?? 0} ·{' '}
                  {p.ownerId === user.uid ? 'this phone' : 'from a lost phone'}
                </Text>
              ))
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function StatusRow({ label, value, tone = 'neutral' }) {
  const { palette } = useTheme();
  const colors = {
    ok: palette.success,
    warn: palette.warning,
    bad: palette.danger,
    info: palette.info,
    neutral: palette.textDim,
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }}>
      <StatusDot tone={tone} size={7} />
      <Text style={{ flex: 1, color: palette.textDim, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: colors[tone] ?? palette.textDim, fontSize: 13, fontWeight: '600' }}>
        {value}
      </Text>
    </View>
  );
}
