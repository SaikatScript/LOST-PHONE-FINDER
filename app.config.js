// Dynamic Expo config: extends app.json and injects plugin props that need
// .env values or explicit options (single source of truth).
// - react-native-maps: Google key (empty until billing is sorted; app uses
//   keyless tiles meanwhile). Dev builds bake this into AndroidManifest.xml.
// - expo-sqlite: default options (plugin acknowledgement).
// - react-native-ble-plx: background BLE enabled for mesh scanning.
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    [
      'react-native-maps',
      {
        androidGoogleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
      },
    ],
    'expo-sqlite',
    [
      'react-native-ble-plx',
      {
        isBackgroundEnabled: true,
        bluetoothAlwaysPermission: 'Allow Lost Phone Finder to find nearby lost phones over Bluetooth.',
      },
    ],
  ],
});
