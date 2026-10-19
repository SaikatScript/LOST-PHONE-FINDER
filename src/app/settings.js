import { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Screen, Card, Chip, Button, SectionTitle } from '../components/ui';
import { radius } from '../theme';

// Phase 5A settings: profile, appearance (dark/light), legal links, sign out.
export default function Settings() {
  const { user, logOut, resendVerification } = useAuth();
  const { mode, palette, setMode } = useTheme();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) router.replace('/login');
  }, [user]);

  const onLogout = async () => {
    setBusy(true);
    try {
      await logOut();
      router.replace('/login');
    } catch (e) {
      Alert.alert('Logout failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const onResend = async () => {
    setBusy(true);
    try {
      await resendVerification();
      Alert.alert('Verification email sent', 'Open the link in your inbox, then restart the app.');
    } catch (e) {
      Alert.alert('Could not send', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll edges={['bottom']}>
      <SectionTitle style={{ marginTop: 0 }}>Account</SectionTitle>
      <Card>
        <Text style={{ color: palette.textDim, fontSize: 13 }}>Signed in as</Text>
        <Text style={{ color: palette.text, fontWeight: '700', fontSize: 15 }}>
          {user?.email ?? '…'}
        </Text>
        {user?.emailVerified ? (
          <Chip dot tone="ok" label="Email verified" />
        ) : (
          <View style={{ gap: 10 }}>
            <Chip dot tone="warn" label="Email not verified" />
            <Button
              compact
              tone="secondary"
              title="Resend verification email"
              onPress={onResend}
              disabled={busy}
            />
          </View>
        )}
      </Card>

      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <Text style={{ color: palette.textDim, fontSize: 13 }}>Theme</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[
            ['dark', '🌙 Dark'],
            ['light', '☀️ Light'],
          ].map(([m, label]) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={{
                flex: 1,
                paddingVertical: 11,
                borderRadius: radius.md,
                borderWidth: 1,
                alignItems: 'center',
                backgroundColor: mode === m ? palette.accentSoft : 'transparent',
                borderColor: mode === m ? palette.accent : palette.border,
              }}
            >
              <Text style={{ color: mode === m ? palette.accent : palette.textDim, fontWeight: '700' }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <SectionTitle>About</SectionTitle>
      <Card>
        <Pressable onPress={() => router.push('/privacy')}>
          <Text style={{ color: palette.text, paddingVertical: 8 }}>Privacy Policy</Text>
        </Pressable>
        <View style={{ height: 1, backgroundColor: palette.border }} />
        <Pressable onPress={() => router.push('/terms')}>
          <Text style={{ color: palette.text, paddingVertical: 8 }}>Terms of Service</Text>
        </Pressable>
        <View style={{ height: 1, backgroundColor: palette.border }} />
        <Text style={{ color: palette.textFaint, paddingVertical: 8, fontSize: 12 }}>
          Lost Phone Finder v{Constants.expoConfig?.version ?? '1.0.0'}
        </Text>
      </Card>

      <Button tone="danger" title="Log out" onPress={onLogout} busy={busy} disabled={busy} />
    </Screen>
  );
}
