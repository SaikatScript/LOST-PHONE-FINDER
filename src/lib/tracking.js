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

// One-shot fix used by "Send location now". Never hang and never greet the
// owner with an error while a usable fix exists: 1) true GPS (High), 2) the
// network fix (Wi-Fi/cell), 3) whatever was cached last. Each step is capped
// and the source label says honestly where the fix came from.
const FIX_TIMEOUT_MS = 20000;
const NET_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise.then((v) => v ?? null).catch(() => null), timeout]);
}

async function getBestAvailablePosition() {
  const gps = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    FIX_TIMEOUT_MS
  );
  if (gps) return { pos: gps, source: 'gps' };
  const net = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    NET_TIMEOUT_MS
  );
  if (net) return { pos: net, source: 'network fallback' };
  const last = await Location.getLastKnownPositionAsync().catch(() => null);
  if (last) return { pos: last, source: 'last known' };
  return null;
}

export async function pushCurrentLocationNow(userId, deviceId) {
  const best = await getBestAvailablePosition();
  if (!best) {
    throw new Error('No location available — move near a window or outdoors, then retry.');
  }
  const battery = await readBatteryPercent();
  await pushLocation(userId, deviceId, {
    lat: best.pos.coords.latitude,
    lng: best.pos.coords.longitude,
    accuracy: best.pos.coords.accuracy ?? null,
    battery,
    source: best.source,
  });
  return { lat: best.pos.coords.latitude, lng: best.pos.coords.longitude, battery };
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
      // High = GPS. Balanced was giving Wi-Fi/cell fixes (±600 m here), which
      // are not good enough to walk to a stolen phone.
      accuracy: Location.Accuracy.High,
      timeInterval: 10 * 60 * 1000,
      distanceInterval: 25,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: 'Lost Phone Finder',
        notificationBody: 'Tracking this device location for anti-theft recovery.',
      },
    });
    return { mode: 'background' };
  } catch {
    // Fallback (e.g. Expo Go Android where TaskManager is unavailable):
    // foreground watcher that pushes each update.
    if (foregroundSub) foregroundSub.remove();
    foregroundSub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 10 * 60 * 1000,
        distanceInterval: 25,
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
