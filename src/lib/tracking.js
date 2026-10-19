import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { waitForPendingWrites } from 'firebase/firestore';
import { db } from './firebase';
import { pushLocation } from './locations';
import { beaconOfflineFix, noteOnlinePush } from './meshAuto';

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

// Pushing every delivered fix spammed Firestore: indoors the fused provider
// re-emits the SAME ±500 m network fix every ~5 s, which filled the 50-entry
// history in minutes and burned quota/battery. Policy: GPS-quality fixes
// (≤100 m) flow freely (expo already gates them by 25 m / 10 min); rough
// network fixes are capped to one per 5 minutes — honest "phone is around
// here" pings without the flood. Rough vs good also drives the source label.
const ROUGH_FIX_GAP_MS = 5 * 60 * 1000;
let lastRoughPushAt = 0;

// Firestore resolves writes made while OFFLINE locally (latency compensation),
// so a resolved pushLocation does NOT prove the server got the fix — with the
// default memory cache the write is simply lost if the app dies before sync.
// waitForPendingWrites() waits for the real backend acknowledgement; racing it
// with a timeout is the honest "did this fix upload?" signal that drives the
// Phase 5B offline broadcast.
const UPLOAD_ACK_MS = 10000;
async function confirmedUpload(timeoutMs = UPLOAD_ACK_MS) {
  try {
    const res = await Promise.race([
      waitForPendingWrites(db).then(() => 'ok').catch(() => 'fail'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return res === 'ok';
  } catch {
    return false;
  }
}

async function pushTrackedBatch(tracked, locations) {
  const battery = await readBatteryPercent();
  let lastFailed = null;
  let lastOk = false;
  for (const loc of locations) {
    const acc = loc.coords.accuracy ?? null;
    const rough = !(acc != null && acc <= 100);
    if (rough && Date.now() - lastRoughPushAt < ROUGH_FIX_GAP_MS) continue;
    try {
      await pushLocation(tracked.userId, tracked.deviceId, {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        accuracy: acc,
        battery,
        source: rough ? 'network fallback' : 'gps',
      });
      if (rough) lastRoughPushAt = Date.now();
      if (await confirmedUpload()) {
        lastOk = true;
        lastFailed = null;
      } else {
        // Locally queued but not acknowledged: treat as offline, seal + queue
        // + broadcast below. If it syncs later it lands twice — harmless.
        lastFailed = { lat: loc.coords.latitude, lng: loc.coords.longitude, acc };
        break;
      }
    } catch {
      // Offline (Phase 5B): the fix is NOT lost — it is sealed, queued and
      // broadcast over Bluetooth below; the agent uploads it automatically
      // the moment internet returns.
      lastFailed = { lat: loc.coords.latitude, lng: loc.coords.longitude, acc };
    }
  }
  if (lastFailed && !lastOk) {
    await beaconOfflineFix({
      userId: tracked.userId,
      deviceId: tracked.deviceId,
      lat: lastFailed.lat,
      lng: lastFailed.lng,
      accuracy: lastFailed.acc,
      battery,
    }).catch(() => {});
  } else if (lastOk) {
    noteOnlinePush().catch(() => {});
  }
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const tracked = await readTrackedDevice();
  if (!tracked) return;
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  await pushTrackedBatch(tracked, locations);
  // Phase 3: piggyback SIM-swap check on every background location batch.
  try {
    const { checkSimChange } = require('./sim');
    const { sendLocalAlert } = require('./alerts');
    await checkSimChange(tracked.userId, tracked.deviceId, sendLocalAlert);
  } catch {
    // Cellular module missing (old binary) or transient failure: ignore.
  }
  // Phase 5B: piggyback the mesh agent on the same wake-up — upload queued
  // packets, harvest relays, scan for nearby lost phones. Best-effort.
  try {
    const { backgroundAgentPass } = require('./meshAuto');
    await backgroundAgentPass();
  } catch {
    // ignore — the foreground agent retries
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
  try {
    await pushLocation(userId, deviceId, {
      lat: best.pos.coords.latitude,
      lng: best.pos.coords.longitude,
      accuracy: best.pos.coords.accuracy ?? null,
      battery,
      source: best.source,
    });
    // Firestore acks offline writes locally — require the real upload.
    if (!(await confirmedUpload())) throw new Error('not acknowledged');
  } catch {
    // No internet: seal + queue + broadcast automatically (Phase 5B).
    await beaconOfflineFix({
      userId,
      deviceId,
      lat: best.pos.coords.latitude,
      lng: best.pos.coords.longitude,
      accuracy: best.pos.coords.accuracy ?? null,
      battery,
    }).catch(() => {});
    throw new Error(
      'No internet right now — the fix was saved and is broadcasting over Bluetooth. ' +
        'It reaches your account automatically once any Lost Phone Finder phone has internet.'
    );
  }
  noteOnlinePush().catch(() => {});
  return { lat: best.pos.coords.latitude, lng: best.pos.coords.longitude, battery };
}

export async function startTracking(userId, deviceId) {
  if (Platform.OS === 'web') {
    throw new Error('Background tracking is not supported on web.');
  }
  await ensureTrackingPermissions();
  await AsyncStorage.setItem(TRACKED_KEY, JSON.stringify({ userId, deviceId }));

  // Phase 5B: ask for the Bluetooth grants NOW, while the owner is looking at
  // the screen, so the automatic offline broadcast can start later without a
  // permission dialog interrupting a stolen phone in a pocket.
  try {
    const { prewarmMeshPermissions } = require('./meshAuto');
    await prewarmMeshPermissions();
  } catch {}

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
          await pushTrackedBatch({ userId, deviceId }, [pos]);
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
