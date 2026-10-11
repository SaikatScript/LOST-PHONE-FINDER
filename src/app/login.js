import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { Link, router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { isFirebaseConfigured } from '../lib/firebase';

export default function Login() {
  const { signIn } = useAuth();
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
    <View style={styles.container}>
      <Text style={styles.title}>Lost Phone Finder</Text>
      {!isFirebaseConfigured && (
        <Text style={styles.warn}>
          Firebase keys not set. Copy .env.example to .env and add your web-app config, then
          restart with `npx expo start --clear`.
        </Text>
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable style={styles.button} onPress={onLogin} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Logging in…' : 'Log in'}</Text>
      </Pressable>
      <Link href="/register" style={styles.link}>
        No account? Create one
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: 'center', gap: 12 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  warn: { backgroundColor: '#FFF7DB', padding: 10, borderRadius: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#111', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  link: { color: '#0B5FFF', marginTop: 8, textAlign: 'center' },
});
