import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pushLocation } from './locations';

// Blueprint §5.3: background task every ~10 min writes to Firestore.
// Task must be defined in global scope (TaskManager requirement).
export const LOCATION_TASK = 'lost-phone-location-task';
const TRACKED_KEY = 'lostphone.trackedDevice';

async function readTrackedDevice() {
  try {
    const raw = await AsyncStorage.getItem(TRACKED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function readBatteryPercent() {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.round(level * 100) : null;
  } catch {
    return null;
  }
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const tracked = await readTrackedDevice();
  if (!tracked) return;
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  const battery = await readBatteryPercent();
  for (const loc of locations) {
    try {
      await pushLocation(tracked.userId, tracked.deviceId, {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        accuracy: loc.coords.accuracy ?? null,
        battery,
        source: 'gps',
      });
    } catch {
      // Offline: drop (Phase 2). Local queue + retry comes with mesh work.
    }
  }
  // Phase 3: piggyback SIM-swap check on every background location batch.
  try {
    const { checkSimChange } = require('./sim');
    const { sendLocalAlert } = require('./alerts');
    await checkSimChange(tracked.userId, tracked.deviceId, sendLocalAlert);
  } catch {
    // Cellular module missing (old binary) or transient failure: ignore.
  }
});

let foregroundSub = null;

export async function ensureTrackingPermissions() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission denied.');
  }
  // Background is best-effort: denied/restricted (Expo Go Android, iOS
  // "Allow Once") still allows foreground tracking.
  try {
    await Location.requestBackgroundPermissionsAsync();
  } catch {
    // ignore — foreground fallback below covers this
  }
  return true;
}

export async function pushCurrentLocationNow(userId, deviceId, source = 'gps') {
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const battery = await readBatteryPercent();
  await pushLocation(userId, deviceId, {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    battery,
    source,
  });
  return { lat: pos.coords.latitude, lng: pos.coords.longitude, battery };
}

export async function startTracking(userId, deviceId) {
  if (Platform.OS === 'web') {
    throw new Error('Background tracking is not supported on web.');
  }
  await ensureTrackingPermissions();
  await AsyncStorage.setItem(TRACKED_KEY, JSON.stringify({ userId, deviceId }));

  // Preferred: background-capable updates every 10 min / 50 m.
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 10 * 60 * 1000,
      distanceInterval: 50,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: 'Lost Phone Finder',
        notificationBody: 'Tracking this device location for anti-theft recovery.',
      },
    });
    return { mode: 'background' };
  } catch (e) {
    // Fallback (e.g. Expo Go Android where TaskManager is unavailable):
    // foreground watcher that pushes each update.
    if (foregroundSub) foregroundSub.remove();
    foregroundSub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 10 * 60 * 1000,
        distanceInterval: 50,
      },
      async (pos) => {
        try {
          const battery = await readBatteryPercent();
          await pushLocation(userId, deviceId, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            battery,
            source: 'gps',
          });
        } catch {
          // ignore transient write failures
        }
      }
    );
    return { mode: 'foreground' };
  }
}

export async function stopTracking() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
  } catch {
    // ignore
  }
  if (foregroundSub) {
    foregroundSub.remove();
    foregroundSub = null;
  }
  await AsyncStorage.removeItem(TRACKED_KEY);
}

export async function isTracking() {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return foregroundSub !== null;
  }
}
