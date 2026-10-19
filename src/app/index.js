import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function Index() {
  const { user, loading } = useAuth();
  const { palette } = useTheme();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/devices' : '/login');
  }, [user, loading]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.bg,
      }}
    >
      <ActivityIndicator size="large" color={palette.accent} />
    </View>
  );
}
