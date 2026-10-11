import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import * as Device from 'expo-device';
import { useAuth } from '../context/AuthContext';
import { registerDevice } from '../lib/devices';

export default function AddDevice() {
  const { user } = useAuth();
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
    <View style={styles.container}>
      <Text style={styles.title}>Register this phone</Text>
      <Text style={styles.sub}>
        Phase 1: saves name + model to users/{'{uid}'}/devices. Location, SIM and mesh come in
        later phases.
      </Text>
      <TextInput style={styles.input} placeholder="Device name" value={name} onChangeText={setName} />
      <TextInput
        style={styles.input}
        placeholder="Owner phone for SMS fallback"
        keyboardType="phone-pad"
        value={ownerPhone}
        onChangeText={setOwnerPhone}
      />
      <Pressable style={styles.button} onPress={onAdd} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Saving…' : 'Save device'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  sub: { color: '#666' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#111', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
