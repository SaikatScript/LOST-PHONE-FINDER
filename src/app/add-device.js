import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { router } from 'expo-router';
import * as Device from 'expo-device';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Screen, Button, TextField } from '../components/ui';
import { registerDevice } from '../lib/devices';

export default function AddDevice() {
  const { user } = useAuth();
  const { palette } = useTheme();
  const [name, setName] = useState(`${Device.manufacturer ?? 'My'} ${Device.modelName ?? 'Android'}`);
  const [ownerPhone, setOwnerPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const onAdd = async () => {
    if (!user) return router.replace('/login');
    setBusy(true);
    try {
      const deviceId = await registerDevice(user.uid, {
        deviceName: name.trim() || 'My Android',
        deviceModel: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''} (${Device.osName ?? ''} ${Device.osVersion ?? ''})`.trim(),
        ownerPhone: ownerPhone.trim(),
      });
      // Phase 3: baseline the current SIM for swap detection (best effort —
      // skipped silently if permission denied or native module missing).
      try {
        const { ensureSimPermission, snapshotSim } = require('../lib/sim');
        await ensureSimPermission();
        await snapshotSim(user.uid, deviceId);
      } catch {
        // baseline adopts itself on first check instead
      }
      router.replace('/devices');
    } catch (e) {
      Alert.alert('Add device failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll edges={['bottom']}>
      <Text style={{ fontSize: 24, fontWeight: '800', color: palette.text }}>
        Register this phone
      </Text>
      <Text style={{ color: palette.textDim }}>
        Saves this phone to your account so you can track it, watch its SIM, and use the offline
        mesh.
      </Text>
      <TextField label="Device name" placeholder="My phone" value={name} onChangeText={setName} />
      <TextField
        label="Owner phone (SMS fallback)"
        placeholder="+91 …"
        keyboardType="phone-pad"
        value={ownerPhone}
        onChangeText={setOwnerPhone}
      />
      <Button title="Save device" onPress={onAdd} busy={busy} disabled={busy} />
    </Screen>
  );
}
