import { Text } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { Screen, Card, Chip } from '../components/ui';

// Template text for Phase 5A — needs a legal review + a hosted URL before the
// Play Store submission (Phase 5D).
export default function PrivacyPolicy() {
  const { palette } = useTheme();
  const p = { color: palette.textDim, lineHeight: 21, fontSize: 14 };
  const h = { color: palette.text, fontWeight: '700', fontSize: 15, marginTop: 12 };
  return (
    <Screen scroll edges={['bottom']}>
      <Chip tone="warn" label="Template — final legal review pending" />
      <Card>
        <Text style={h}>1. What we collect</Text>
        <Text style={p}>
          Account email and optional phone number. For each device you register: device name and
          model, location fixes (with accuracy and battery level), SIM identifiers (carrier, MCC/MNC,
          ICCID/IMSI when Android allows), and encrypted Bluetooth mesh packets.
        </Text>
        <Text style={h}>2. How it is used</Text>
        <Text style={p}>
          Only to show you your own devices: the live position, history, theft alerts and relayed
          mesh locations. We do not sell data and there are no ads.
        </Text>
        <Text style={h}>3. Where it lives</Text>
        <Text style={p}>
          In Google Firebase (Firestore) under your account. Security rules allow only your signed-in
          account to read your data; mesh relay blobs are end-to-end encrypted so helper phones
          cannot read them.
        </Text>
        <Text style={h}>4. Background location</Text>
        <Text style={p}>
          Location is recorded only while tracking is enabled for a device, including in the
          background, so the device can be found when lost. You can turn it off anytime from the
          device screen.
        </Text>
        <Text style={h}>5. Retention & deletion</Text>
        <Text style={p}>
          History keeps the last 50 fixes per device. Mesh relays are deleted after the owner
          harvests them. Removing a device from the app deletes its stored location history.
        </Text>
        <Text style={h}>6. Contact</Text>
        <Text style={p}>support@lostphonefinder.example (placeholder — update before release).</Text>
      </Card>
    </Screen>
  );
}
