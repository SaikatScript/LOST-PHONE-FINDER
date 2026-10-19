import { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { subscribeToDevices } from '../lib/devices';
import { subscribeMeshStatus } from '../lib/meshAuto';
import { Screen, Card, Chip, Button, EmptyState } from '../components/ui';
import { timeAgo } from '../lib/format';
import { space } from '../theme';

export default function Devices() {
  const { user, resendVerification } = useAuth();
  const { palette } = useTheme();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState('');
  const [mesh, setMesh] = useState(null);

  // Live mesh/automation state: the strip under the title tells the owner what
  // the phone is doing by itself (scanning, broadcasting, waiting to upload).
  useEffect(() => subscribeMeshStatus(setMesh), []);

  let meshTone = 'neutral';
  let meshLabel = 'Offline mesh: starting…';
  if (mesh) {
    meshTone = 'ok';
    meshLabel = 'Offline mesh: ready';
    if (mesh.beaconOn) {
      meshTone = 'warn';
      meshLabel = 'Offline mesh: broadcasting (no internet)';
    } else if ((mesh.queuedOwn ?? 0) > 0) {
      meshTone = 'warn';
      meshLabel = `Offline mesh: ${mesh.queuedOwn} fix waiting to upload`;
    } else if (mesh.scanning) {
      meshTone = 'info';
      meshLabel = 'Offline mesh: checking nearby phones';
    } else if (mesh.online === false) {
      meshTone = 'warn';
      meshLabel = 'Offline mesh: offline — fixes are saved';
    }
  }

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

  const onResend = async () => {
    try {
      await resendVerification();
      Alert.alert('Verification email sent', 'Open the link in your inbox, then restart the app.');
    } catch (e) {
      Alert.alert('Could not send', e.message);
    }
  };

  return (
    <Screen pad={false} edges={['top', 'bottom']} style={{ gap: 0 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: space.lg,
          paddingBottom: space.sm,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 26, fontWeight: '800', color: palette.text }}>My Devices</Text>
          <Text style={{ color: palette.textDim, fontSize: 13 }}>{user?.email ?? ''}</Text>
        </View>
        <Pressable
          onPress={() => router.push('/settings')}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            borderWidth: 1,
            borderColor: palette.border,
            backgroundColor: palette.card,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 19, color: palette.text }}>⚙</Text>
        </Pressable>
      </View>

      {!user?.emailVerified && (
        <Card
          style={{
            marginHorizontal: space.lg,
            marginBottom: space.sm,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 10,
          }}
        >
          <Chip tone="warn" dot label="Email not verified" />
          <Pressable onPress={onResend}>
            <Text style={{ color: palette.accent, fontWeight: '600', fontSize: 13 }}>Resend link</Text>
          </Pressable>
        </Card>
      )}

      <Pressable
        onPress={() => router.push('/mesh')}
        style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}
      >
        <Chip dot tone={meshTone} label={meshLabel} />
      </Pressable>

      {error ? (
        <Text style={{ color: palette.danger, paddingHorizontal: space.lg }}>{error}</Text>
      ) : null}

      <FlatList
        style={{ flex: 1 }}
        data={devices}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.md }}
        ListEmptyComponent={
          <EmptyState
            icon="📱"
            title="No devices yet"
            hint="Tap “Add this device” below to register this phone and start tracking."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/device/[id]', params: { id: item.id } })}
            style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
          >
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text
                  style={{ flex: 1, color: palette.text, fontSize: 17, fontWeight: '700' }}
                  numberOfLines={1}
                >
                  {item.deviceName}
                </Text>
                <Chip dot tone={item.isLost ? 'bad' : 'ok'} label={item.isLost ? 'LOST' : 'OK'} />
              </View>
              <Text style={{ color: palette.textDim, fontSize: 13 }} numberOfLines={1}>
                {item.deviceModel}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip label={`🔋 ${item.lastBattery ?? '?'}%`} />
                {item.simSwapped ? <Chip tone="warn" label="SIM swapped" /> : null}
                {item.lastLocationSource === 'mesh' ? <Chip tone="info" label="via mesh" /> : null}
                {item.lastLocationAt ? (
                  <Text style={{ color: palette.textFaint, fontSize: 12 }}>
                    {timeAgo(item.lastLocationAt)}
                  </Text>
                ) : null}
              </View>
            </Card>
          </Pressable>
        )}
      />

      <View style={{ padding: space.lg, paddingTop: space.sm, gap: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button
            style={{ flex: 1 }}
            tone="secondary"
            title="Fleet map"
            onPress={() => router.push('/map')}
          />
          <Button
            style={{ flex: 1 }}
            tone="secondary"
            title="Offline mesh"
            onPress={() => router.push('/mesh')}
          />
        </View>
        <Button title="＋  Add this device" onPress={() => router.push('/add-device')} />
      </View>
    </Screen>
  );
}
