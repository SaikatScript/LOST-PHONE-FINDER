import { useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Screen, Button, TextField } from '../components/ui';

export default function Register() {
  const { signUp } = useAuth();
  const { palette } = useTheme();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onRegister = async () => {
    if (!email || !password) return Alert.alert('Missing info', 'Enter email and password.');
    setBusy(true);
    try {
      await signUp(email.trim(), password, phone.trim());
      Alert.alert(
        'Account created',
        'We sent a verification email — check your inbox. You can verify later from Settings.'
      );
      router.replace('/devices');
    } catch (e) {
      Alert.alert('Sign up failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll centered edges={['top', 'bottom']}>
      <Text style={{ fontSize: 26, fontWeight: '800', color: palette.text }}>
        Create account
      </Text>
      <Text style={{ color: palette.textDim, fontSize: 14 }}>
        One account protects all your phones.
      </Text>

      <TextField
        label="Email"
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextField
        label="Phone (optional, SMS fallback)"
        placeholder="+91 …"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      <TextField
        label="Password (min 6 chars)"
        placeholder="Choose a password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Button title="Create account" onPress={onRegister} busy={busy} disabled={busy} />

      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: palette.accent, fontWeight: '600' }}>Already have an account? Log in</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
