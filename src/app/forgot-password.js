import { useState } from 'react';
import { Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Screen, Button, TextField } from '../components/ui';

// Phase 5A: Firebase password reset email flow.
export default function ForgotPassword() {
  const { resetPassword } = useAuth();
  const { palette } = useTheme();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const onSend = async () => {
    if (!email.trim()) return Alert.alert('Missing info', 'Enter your account email.');
    setBusy(true);
    try {
      await resetPassword(email.trim());
      Alert.alert('Email sent', 'Check your inbox (and spam folder) for the reset link.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e) {
      Alert.alert('Could not send', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen centered edges={['top', 'bottom']}>
      <Pressable onPress={() => router.back()} style={{ alignSelf: 'flex-start' }}>
        <Text style={{ color: palette.accent, fontWeight: '600' }}>‹ Back</Text>
      </Pressable>
      <Text style={{ fontSize: 24, fontWeight: '800', color: palette.text }}>Reset password</Text>
      <Text style={{ color: palette.textDim }}>
        Enter your account email — we’ll send you a link to set a new password.
      </Text>
      <TextField
        label="Email"
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Button title="Send reset link" onPress={onSend} busy={busy} disabled={busy} />
    </Screen>
  );
}
