import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, FlatList, Alert, ActivityIndicator, AppState } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { subscribeToDevice, updateDevice, renameDevice, removeDevice } from '../../lib/devices';
import { subscribeToLocations } from '../../lib/locations';
import {
  startTracking,
  stopTracking,
  pushCurrentLocationNow,
  isTracking,
} from '../../lib/tracking';
import { fmtDateTime, timeAgo, toMillis } from '../../lib/format';
import DeviceMap from '../../components/DeviceMap';
import {
  Screen,
  Card,
  Chip,
  Button,
  TextField,
  SectionTitle,
  StatusDot,
  EmptyState,
} from '../../components/ui';
import { space } from '../../theme';

export default function DeviceDetail() {
  const { id } = useLocalSearchParams();
  const { user } = useAuth();
  const { palette } = useTheme();
  const [device, setDevice] = useState(null);
  const [history, setHistory] = useState([]);
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // Clock for "this fix is N minutes old". Kept in state (updated by an effect)
  // so the render body never calls Date.now() directly.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Refs used by the auto-refresh below. Declared before the subscription
  // effect so its snapshot callback can feed historyRef directly.
  const autoInFlight = useRef(false);
  const autoLastAt = useRef(0);
  const historyReady = useRef(false);
  const historyRef = useRef([]);
  const doAutoRefreshRef = useRef(() => {});

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    const un1 = subscribeToDevice(user.uid, id, setDevice, (e) => setError(e.message));
    const un2 = subscribeToLocations(
      user.uid,
      id,
      50,
      (data) => {
        // Fresh snapshot: remember it, mark ready, then let the auto-refresh
        // decide (it skips when the newest fix is younger than 2 minutes).
        historyRef.current = data;
        historyReady.current = true;
        setHistory(data);
        doAutoRefreshRef.current();
      },
      (e) => setError(e.message)
    );
    isTracking().then(setTracking).catch(() => {});
    return () => {
      un1();
      un2();
    };
  }, [user, id]);

  // Auto-refresh like a maps app: when this screen opens or the app returns to
  // the foreground, a stale fix (older than 2 min) is quietly replaced by a
  // fresh one. Without this, the screen kept showing e.g. the 02:10 fix until
  // the 10-minute background task happened to fire — users saw an "old/wrong"
  // position right after Google Maps had shown the correct one.
  // pushCurrentLocationNow has a capped chain (~35 s worst case), so a failed
  // attempt is cheap and silent; the on-screen stale-fix hint explains what to
  // do when it never succeeds (indoors, no sky view).
  const doAutoRefresh = useCallback(() => {
    if (!user || autoInFlight.current || !historyReady.current) return;
    const nowMs = Date.now();
    if (nowMs - autoLastAt.current < 60 * 1000) return;
    const ts = historyRef.current[0]?.timestamp;
    const newestMs = toMillis(ts);
    if (Number.isFinite(newestMs) && newestMs > 0 && nowMs - newestMs < 2 * 60 * 1000) return;
    autoLastAt.current = nowMs;
    autoInFlight.current = true;
    pushCurrentLocationNow(user.uid, id)
      .catch(() => {})
      .finally(() => {
        autoInFlight.current = false;
      });
  }, [user, id]);
  useEffect(() => {
    doAutoRefreshRef.current = doAutoRefresh;
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') doAutoRefresh();
    });
    return () => sub.remove();
  }, [doAutoRefresh]);

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

  const onSaveName = async () => {
    if (!guard()) return;
    const clean = nameDraft.trim();
    if (!clean) return Alert.alert('Name required', 'Enter a device name.');
    setBusy(true);
    try {
      await renameDevice(user.uid, id, clean);
      setEditingName(false);
    } catch (e) {
      Alert.alert('Rename failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      await removeDevice(user.uid, id);
      router.replace('/devices');
    } catch (e) {
      Alert.alert('Remove failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = () => {
    Alert.alert(
      'Remove device?',
      `“${device?.deviceName ?? 'This device'}” and its location history will be deleted from your account. The phone itself is not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: onRemove },
      ]
    );
  };

  if (!device) {
    return (
      <>
        <Stack.Screen options={{ title: 'Device' }} />
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.bg,
            gap: 8,
          }}
        >
          <ActivityIndicator color={palette.accent} />
          {error ? <Text style={{ color: palette.danger }}>{error}</Text> : null}
        </View>
      </>
    );
  }

  const latest = history[0];
  const latestMs = latest ? toMillis(latest.timestamp) : null;
  const ageMin = latestMs ? Math.round((now - latestMs) / 60000) : 0;
  const stale = !!latest && Number.isFinite(ageMin) && ageMin >= 3;
  const ageLabel = ageMin < 90 ? `${ageMin} min` : `${Math.round(ageMin / 60)} h`;
  // Dashboard map shows ONLY the latest fix (plus its accuracy circle). Drawing
  // all 20 history fixes made a wall of overlapping dots and ±500 m circles
  // that covered the map — the history list below already shows the path.
  const markers = latest
    ? [
        {
          id: latest.id,
          lat: latest.lat,
          lng: latest.lng,
          title: latest.source === 'mesh' ? 'Latest fix (via mesh)' : 'Latest fix',
          description: `Battery ${latest.battery ?? '?'}% • ${latest.source ?? ''}`,
          color: 'blue',
          acc: latest.accuracy ?? null,
          at: latestMs,
        },
      ]
    : [];

  const header = (
    <View style={{ padding: space.lg, gap: space.md }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text
            style={{ flex: 1, fontSize: 24, fontWeight: '800', color: palette.text }}
            numberOfLines={1}
          >
            {device.deviceName}
          </Text>
          <Chip dot tone={device.isLost ? 'bad' : 'ok'} label={device.isLost ? 'LOST' : 'OK'} />
        </View>
        <Text style={{ color: palette.textDim, fontSize: 13 }} numberOfLines={2}>
          {device.deviceModel}
        </Text>
      </View>

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionTitle style={{ marginTop: 0 }}>Latest position</SectionTitle>
          {latest ? <Chip dot tone={stale ? 'warn' : 'ok'} label={stale ? 'may be old' : 'fresh'} /> : null}
        </View>
        {latest ? (
          <>
            <Text style={{ color: palette.text, fontSize: 18, fontWeight: '700' }}>
              {latest.lat.toFixed(5)}, {latest.lng.toFixed(5)}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip label={latest.accuracy == null ? '± ?' : `± ${Math.round(latest.accuracy)} m`} />
              <Chip label={`🔋 ${latest.battery ?? '?'}%`} />
              {latest.source ? (
                <Chip tone={latest.source === 'mesh' ? 'info' : 'neutral'} label={latest.source} />
              ) : null}
              <Chip label={timeAgo(latest.timestamp)} />
            </View>
            <Text style={{ color: palette.textFaint, fontSize: 12 }}>
              {fmtDateTime(latest.timestamp)}
            </Text>
            {stale ? (
              <Text style={{ color: palette.warning, fontSize: 12, fontWeight: '600' }}>
                This fix is {ageLabel} old — tap “Send location now” for a fresh GPS reading.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={{ color: palette.textDim }}>
            No fixes yet — tap “Send location now” below.
          </Text>
        )}
      </Card>

      <Button title="📍  Send location now" onPress={onSendNow} busy={busy} disabled={busy} />
      {tracking ? (
        <Button tone="secondary" title="Stop tracking" onPress={onStop} disabled={busy} />
      ) : (
        <Button
          tone="secondary"
          title="Start background tracking (every 10 min)"
          onPress={onStart}
          disabled={busy}
        />
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusDot tone={tracking ? 'ok' : 'neutral'} />
        <Text style={{ color: palette.textDim, fontSize: 12, flex: 1 }}>
          {tracking
            ? 'Tracking is ON for this phone.'
            : 'Tracking is off — turn it on for automatic updates.'}
        </Text>
      </View>

      <Card>
        <SectionTitle style={{ marginTop: 0 }}>SIM & theft protection</SectionTitle>
        <Text style={{ color: palette.text }}>
          {device.simCarrier ?? 'Unknown carrier'}
          {device.simMccMnc ? ` • ${device.simMccMnc}` : ''}
        </Text>
        <Chip
          dot
          tone={device.simSwapped ? 'bad' : 'ok'}
          label={device.simSwapped ? 'SIM swapped — marked LOST' : 'No swap detected'}
        />
        <Button
          compact
          tone="secondary"
          style={{ alignSelf: 'flex-start' }}
          title="Check SIM now"
          onPress={onCheckSim}
          disabled={busy}
        />
      </Card>

      <Card tone={device.isLost ? 'danger' : undefined}>
        <SectionTitle style={{ marginTop: 0 }}>Emergency</SectionTitle>
        <Button
          tone={device.isLost ? 'secondary' : 'danger'}
          title={device.isLost ? 'Clear LOST flag' : '⚠  Mark LOST (emergency mode)'}
          onPress={onToggleLost}
          disabled={busy}
        />
        <Button
          tone="secondary"
          title="💬  SMS owner location"
          onPress={onSmsOwner}
          disabled={busy}
        />
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <DeviceMap markers={markers} />
      </Card>

      <SectionTitle style={{ marginTop: space.sm }}>Device settings</SectionTitle>
      <Card>
        {editingName ? (
          <>
            <TextField
              label="Device name"
              value={nameDraft}
              onChangeText={setNameDraft}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button
                style={{ flex: 1 }}
                compact
                title="Save name"
                onPress={onSaveName}
                disabled={busy}
              />
              <Button
                style={{ flex: 1 }}
                compact
                tone="secondary"
                title="Cancel"
                onPress={() => setEditingName(false)}
                disabled={busy}
              />
            </View>
          </>
        ) : (
          <Button
            tone="secondary"
            title="✎  Rename device"
            onPress={() => {
              setNameDraft(device.deviceName ?? '');
              setEditingName(true);
            }}
            disabled={busy}
          />
        )}
        <Button
          tone="dangerGhost"
          title="Remove device"
          onPress={confirmRemove}
          disabled={busy}
        />
        <Text style={{ color: palette.textFaint, fontSize: 12 }}>
          Removing deletes this device’s location history from your account. The phone itself
          keeps working.
        </Text>
      </Card>

      <SectionTitle style={{ marginTop: space.sm }}>History ({history.length})</SectionTitle>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: device.deviceName ?? 'Device' }} />
      <Screen pad={false} edges={['bottom']} style={{ gap: 0 }}>
        <FlatList
        style={{ flex: 1 }}
        data={history}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: space.xl }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyState
            icon="📍"
            title="No fixes yet"
            hint="Tap “Send location now” above to record the first position."
          />
        }
        renderItem={({ item, index }) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: space.lg,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: palette.border,
            }}
          >
            <StatusDot tone={index === 0 ? 'accent' : 'neutral'} />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: palette.text,
                  fontSize: 13,
                  fontWeight: index === 0 ? '700' : '500',
                }}
              >
                {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
              </Text>
              <Text style={{ color: palette.textDim, fontSize: 12 }}>
                ±{item.accuracy == null ? '?' : `${Math.round(item.accuracy)} m`} • Battery{' '}
                {item.battery ?? '?'}% • {fmtDateTime(item.timestamp)}
              </Text>
            </View>
            {item.source === 'mesh' ? (
              <Chip tone="info" label="mesh" />
            ) : item.source === 'network fallback' ? (
              <Chip tone="warn" label="network" />
            ) : null}
          </View>
        )}
      />
      </Screen>
    </>
  );
}
