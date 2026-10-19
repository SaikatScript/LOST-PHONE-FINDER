import { Text } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { Screen, Card, Chip } from '../components/ui';

// Template text for Phase 5A — needs a legal review + a hosted URL before the
// Play Store submission (Phase 5D).
export default function Terms() {
  const { palette } = useTheme();
  const p = { color: palette.textDim, lineHeight: 21, fontSize: 14 };
  const h = { color: palette.text, fontWeight: '700', fontSize: 15, marginTop: 12 };
  return (
    <Screen scroll edges={['bottom']}>
      <Chip tone="warn" label="Template — final legal review pending" />
      <Card>
        <Text style={h}>1. What this app is</Text>
        <Text style={p}>
          Lost Phone Finder helps you locate and protect devices you own. It is provided as-is with
          no guarantee that a lost device will be recovered.
        </Text>
        <Text style={h}>2. Use only your own devices</Text>
        <Text style={p}>
          Track, monitor and act only on devices you own or are authorized to manage. Using the app
          to track another person without consent may be illegal.
        </Text>
        <Text style={h}>3. your responsibilities</Text>
        <Text style={p}>
          Keep your account password safe. The location history and mesh relays are protected by
          your account — anyone with access to your account can see them.
        </Text>
        <Text style={h}>4. Service limits</Text>
        <Text style={p}>
          Location accuracy depends on GPS and networks and may be inaccurate, especially indoors.
          Offline mesh relays depend on other phones running the app nearby. Emergency features
          (Ring / Lock / Wipe, when released) require the device to be online and properly
          configured.
        </Text>
        <Text style={h}>5. Changes</Text>
        <Text style={p}>
          We may update these terms as the app evolves; continued use means you accept the current
          version.
        </Text>
        <Text style={h}>6. Contact</Text>
        <Text style={p}>support@lostphonefinder.example (placeholder — update before release).</Text>
      </Card>
    </Screen>
  );
}
