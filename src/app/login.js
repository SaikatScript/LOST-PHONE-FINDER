import { useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Screen, Button, TextField, Card } from '../components/ui';
import { isFirebaseConfigured } from '../lib/firebase';

export default function Login() {
  const { signIn } = useAuth();
  const { palette } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onLogin = async () => {
    if (!email || !password) return Alert.alert('Missing info', 'Enter email and password.');
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/devices');
    } catch (e) {
      Alert.alert('Login failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll centered edges={['top', 'bottom']}>
      <View style={{ alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: palette.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 30 }}>🛰️</Text>
        </View>
        <Text style={{ fontSize: 26, fontWeight: '800', color: palette.text }}>
          Lost Phone Finder
        </Text>
        <Text style={{ color: palette.textDim, fontSize: 14 }}>
          Find your phone — even offline.
        </Text>
      </View>

      {!isFirebaseConfigured && (
        <Card tone="warning">
          <Text style={{ color: palette.warning, fontSize: 13 }}>
            Firebase keys not set. Copy .env.example to .env and add your web-app config, then
            restart with `npx expo start --clear`.
          </Text>
        </Card>
      )}

      <TextField
        label="Email"
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextField
        label="Password"
        placeholder="Your password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Button title="Log in" onPress={onLogin} busy={busy} disabled={busy} />

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 4 }}>
        <Pressable onPress={() => router.push('/forgot-password')}>
          <Text style={{ color: palette.accent, fontWeight: '600' }}>Forgot password?</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/register')}>
          <Text style={{ color: palette.accent, fontWeight: '600' }}>Create account</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
