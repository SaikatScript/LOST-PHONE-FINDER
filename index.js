// Custom entry point (Expo Router).
// Use this file for global side-effects (polyfills, logging, services)
// before the router mounts. expo-router/entry must stay last.
import { AppRegistry } from 'react-native';
import 'expo-router/entry';

// Phase 5B: the native BootReceiver wakes this task (headless, no UI) after a
// reboot or an app update, so tracking, the foreground service and the offline
// Bluetooth beacon resume without the owner opening the app.
AppRegistry.registerHeadlessTask('lostphone-boot', () => async () => {
  try {
    const { resumeProtectionAfterBoot } = require('./src/lib/tracking');
    return await resumeProtectionAfterBoot();
  } catch {
    return { resumed: false };
  }
});
