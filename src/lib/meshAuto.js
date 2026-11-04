import { AppState, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encodeBase64 } from 'tweetnacl-util';
import { ensureDeviceKeys, sealLocationPacket } from './meshCrypto';
import { enqueuePacket, listPackets, removePacket } from './meshQueue';
import { uploadRelay, harvestRelays } from './meshRelay';
import { helperScanOnce, startBeacon, stopBeacon, isBleAvailable } from './meshBle';
import { confirmedUpload, isFirestoreOffline } from './uploadAck';

// Phase 5B automation: every mesh step that used to be a button now runs by
// itself, on every phone (same app = same behavior):
//
//   offline fix   → sealed + queued + broadcast over BLE (beacon ON)
//   beacon heard  → packet read, queued, uploaded to `relays` automatically
//   internet back → own queued fixes upload, helpers' backlog flushes
//   relays found  → decrypted into device history automatically (harvest)
//
// The agent lives while the app is open (foreground) and every step is also
// reachable from the background location task via beaconOfflineFix().
// Best-effort everywhere: a failure just leaves work for the next tick.

const TICK_MS = 60 * 1000; // heartbeat while the app is open
const HARVEST_EVERY_MS = 3 * 60 * 1000; // poll my relays (cheap: 1+ reads)
const SCAN_EVERY_MS = 5 * 60 * 1000; // helper BLE scan cadence
export const SCAN_WINDOW_MS = 25 * 1000; // one scan listens this long
const AUTO_FIX_EVERY_MS = 5 * 60 * 1000; // offline auto-seal retry cadence

let lastAutoFixAt = 0;
let lastResumeAt = 0;
let autoFixInFlight = false;

// Real connectivity, independent of Firestore's local cache. Used for the
// status chip AND to seal + broadcast the moment internet disappears - without
// waiting for a GPS update that a stationary phone may not get for hours.
async function hasInternet() {
  if (isFirestoreOffline()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://clients3.google.com/generate_204', {
      method: 'HEAD',
      signal: controller.signal,
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let uid = null;
let tickTimer = null;
let appSub = null;
let appActive = true;
let tickBusy = false;
let scanBusy = false;
let lastHarvestAt = 0;
let lastScanAt = 0;
let beaconOn = false;
// Packets handed to Firestore this session but NOT yet acknowledged by the
// server. addDoc() resolves locally while offline, so a packet may only be
// removed from the SQLite queue after confirmedUpload() sees the real ack.
const attemptedIds = new Set();

let status = {
  active: false,
  online: null, // null = unknown, true/false = last network attempt result
  scanning: false,
  lastScanAt: 0,
  lastScanSeen: 0,
  lastScanRead: 0,
  lastScanError: '',
  queuedTotal: 0,
  queuedOwn: 0,
  beaconOn: false,
  beaconAt: 0,
  beaconNote: '',
  relayedUp: 0, // packets this phone carried for others (uploaded)
  lastHarvestAt: 0,
  lastHarvestText: '',
  lastTickAt: 0,
  note: '',
};

const listeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of listeners) {
    try {
      fn(status);
    } catch {}
  }
}

export function getMeshStatus() {
  return status;
}

export function subscribeMeshStatus(fn) {
  listeners.add(fn);
  try {
    fn(status);
  } catch {}
  return () => listeners.delete(fn);
}

// --- Bluetooth grants -------------------------------------------------------

async function bleGrantsOk() {
  if (Platform.OS !== 'android') return false;
  if ((Platform.Version ?? 0) < 31) return true; // pre-12: location grants cover BLE
  try {
    const adv = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);
    const conn = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    return adv && conn;
  } catch {
    return false;
  }
}

// Called once when the owner enables tracking, so the offline broadcast can
// start later WITHOUT a permission dialog interrupting a phone in a pocket.
export async function prewarmMeshPermissions() {
  if (Platform.OS !== 'android') return false;
  if ((Platform.Version ?? 0) < 31) return true;
  try {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ]);
    return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}

// --- Beacon (this phone's own sealed fix, broadcast while offline) ----------

async function startBeaconInternal(packet) {
  await startBeacon(packet); // native side stops any previous beacon first
  beaconOn = true;
  console.log('[mesh-auto] beacon ON — offline fix queued + broadcasting');
  setStatus({
    beaconOn: true,
    beaconAt: Date.now(),
    beaconNote: 'offline — broadcasting location over Bluetooth',
  });
  return true;
}

async function stopBeaconInternal(reason) {
  try {
    await stopBeacon();
  } catch {}
  beaconOn = false;
  console.log('[mesh-auto] beacon stopped:', reason ?? '');
  setStatus({ beaconOn: false, beaconNote: reason ?? '' });
}

// Tracking calls this the moment a direct upload fails: the fix is sealed,
// queued and broadcast so any nearby Lost Phone Finder phone can carry it.
export async function beaconOfflineFix({ userId, deviceId, lat, lng, accuracy = null, battery = null }) {
  if (!userId || !deviceId) return false;
  setStatus({ online: false });
  // Seal + queue FIRST: the fix must survive even when the radio cannot
  // broadcast (permission refused, BLE stack busy, old binary). It then uploads
  // automatically the moment internet returns — losing it is never acceptable.
  let packet;
  try {
    const kp = await ensureDeviceKeys(userId, deviceId);
    packet = await sealLocationPacket({
      ownerId: userId,
      deviceId,
      lat,
      lng,
      accuracy,
      battery,
      ownerPubB64: encodeBase64(kp.publicKey),
    });
    await enqueuePacket(packet);
    console.log('[mesh-auto] sealed + queued', packet.packetId);
    setStatus({ queuedOwn: status.queuedOwn + 1, note: '' });
  } catch (e) {
    console.warn('[mesh-auto] offline seal failed:', e?.message ?? String(e));
    setStatus({ note: `Could not save the offline fix: ${e.message}` });
    return false;
  }
  try {
    if (!(await bleGrantsOk())) {
      setStatus({
        note: 'Fix saved — it uploads automatically. Bluetooth permission is missing, so it is not broadcasting to nearby phones.',
        queuedOwn: status.queuedOwn,
      });
      return true;
    }
    await startBeaconInternal(packet);
    return true;
  } catch (e) {
    console.warn('[mesh-auto] beacon start failed:', e?.message ?? String(e));
    setStatus({
      note: `Fix saved for automatic upload. Bluetooth broadcast failed: ${e.message}`,
      queuedOwn: status.queuedOwn,
    });
    return false;
  }
}

// Tracking calls this when a direct upload succeeds again.
export async function noteOnlinePush() {
  setStatus({ online: true });
  if (beaconOn) await stopBeaconInternal('internet back — sent directly, broadcast stopped');
  if (uid) tick().catch(() => {});
}

// --- Heartbeat --------------------------------------------------------------

async function tick() {
  if (!uid || tickBusy) return;
  tickBusy = true;
  try {
    const reachable = await hasInternet();
    let queued = [];
    try {
      queued = await listPackets();
    } catch (e) {
      // Never swallow this: a queue read failure used to look exactly like an
      // empty queue (no upload attempt, no log, UI showing 0).
      console.log('[mesh-auto] queue read failed:', e?.message ?? String(e));
      queued = [];
    }
    if (queued.length) {
      console.log('[mesh-auto] tick — queue', queued.length, 'attempted', attemptedIds.size);
    }

    let sent = 0;
    let acked = null;

    // 1) Hand every queued packet (helper backlog + my own offline fixes) to
    // Firestore at most once per session. The write resolves locally even when
    // offline — nothing is deleted from the queue until step 2 sees the ack.
    for (const p of queued) {
      if (attemptedIds.has(p.packetId)) continue;
      try {
        await uploadRelay(p);
        attemptedIds.add(p.packetId);
      } catch {
        // keep it queued; the server-ack check decides whether we are offline
      }
    }

    // 2) Real upload check: waitForPendingWrites() only resolves once the
    // SERVER has acknowledged every queued write. A timeout means the packets
    // are only sitting in the local cache — keep them queued (the offline
    // broadcast keeps running) and retry on a later tick.
    if (attemptedIds.size) {
      acked = await confirmedUpload();
      if (acked) {
        for (const id of attemptedIds) {
          try {
            await removePacket(id);
          } catch {}
        }
        sent = attemptedIds.size;
        attemptedIds.clear();
        console.log('[mesh-auto] upload acknowledged — cleared', sent, 'packet(s)');
      } else {
        console.log('[mesh-auto] upload not acknowledged (offline) —', attemptedIds.size, 'packet(s) kept queued');
      }
    }

    // 3) Harvest: fold my relays (own uploads + packets helpers carried for me)
    // into device history. Runs periodically and right after an acknowledged
    // upload. NOTE: getDocs() also resolves while offline (from the local
    // cache), so a "successful" harvest is NOT proof of internet.
    let harvestText = status.lastHarvestText;
    if (Date.now() - lastHarvestAt >= HARVEST_EVERY_MS || (acked === true && sent > 0)) {
      try {
        const res = await harvestRelays(uid);
        lastHarvestAt = Date.now();
        harvestText = `checked ${res.checked}, decrypted ${res.opened}${res.blank ? `, ${res.blank} ping` : ''}`;
      } catch {
        // offline: nothing to read yet — retry on the next tick
      }
    }

    if (harvestText !== status.lastHarvestText) {
      console.log('[mesh-auto] harvest:', harvestText);
    }

    let after = queued;
    try {
      after = await listPackets();
    } catch {}
    const stillMine = after.filter((p) => p.ownerId === uid).length;

    // Everything of mine is on the server → the broadcast is no longer needed.
    if (beaconOn && acked === true && stillMine === 0) {
      await stopBeaconInternal('internet back — broadcast stopped');
    }

    const online = reachable && acked !== false;
    setStatus({
      online,
      queuedTotal: after.length,
      queuedOwn: stillMine,
      lastTickAt: Date.now(),
      lastHarvestAt,
      lastHarvestText: harvestText,
      relayedUp: status.relayedUp + sent,
    });

    // Internet is gone: seal + broadcast NOW. A phone left on a table (or in a
    // thief's drawer) may produce no GPS update for hours, and waiting for one
    // meant airplane mode showed "internet ok / broadcasting off" forever.
    if (
      !online &&
      !autoFixInFlight &&
      !beaconOn &&
      stillMine === 0 &&
      Date.now() - lastAutoFixAt >= AUTO_FIX_EVERY_MS
    ) {
      lastAutoFixAt = Date.now();
      autoFixInFlight = true;
      Promise.resolve()
        .then(() => {
          const { pushOfflineFixFromTracked } = require('./tracking');
          return pushOfflineFixFromTracked();
        })
        .catch(() => {})
        .finally(() => {
          autoFixInFlight = false;
        });
    }

    // A fix is already queued but the beacon is off (e.g. Bluetooth was turned
    // off): retry the broadcast so it resumes without a manual tap.
    if (!online && !beaconOn && stillMine > 0 && Date.now() - lastResumeAt >= AUTO_FIX_EVERY_MS) {
      lastResumeAt = Date.now();
      resumeBeaconFromQueue().catch(() => {});
    }

    // 4) Helper scan while the app is open (cadence enforced inside).
    if (appActive) runScanCycle().catch(() => {});
  } finally {
    tickBusy = false;
  }
}

// One helper scan window: listen for stolen-phone beacons, store + upload each.
async function runScanCycle(force = false) {
  if (scanBusy || !uid || !isBleAvailable()) return;
  if (!force && Date.now() - lastScanAt < SCAN_EVERY_MS) return;
  scanBusy = true;
  lastScanAt = Date.now();
  setStatus({ scanning: true, lastScanError: '' });
  try {
    const res = await helperScanOnce(async (packet) => {
      // Keep it in the queue: the next tick uploads it and only drops it once
      // the server acknowledges the write (offline scans stay queued safely).
      try {
        await enqueuePacket(packet);
        console.log('[mesh-auto] heard + queued', packet.packetId);
      } catch {}
    }, SCAN_WINDOW_MS);
    setStatus({
      scanning: false,
      lastScanAt: Date.now(),
      lastScanSeen: res.stats.seen,
      lastScanRead: res.stats.read,
    });
  } catch (e) {
    // "Scan already running" just means a manual scan is up — retry next time.
    if (/already running/i.test(e?.message ?? '')) lastScanAt = Date.now() - SCAN_EVERY_MS + 60 * 1000;
    setStatus({ scanning: false, lastScanError: e?.message ?? String(e) });
  } finally {
    scanBusy = false;
  }
}

// A phone killed while offline still has sealed fixes queued — resume the
// broadcast on the next launch so it stays findable.
async function resumeBeaconFromQueue() {
  if (!uid || !isBleAvailable() || !(await bleGrantsOk())) return;
  let queued = [];
  try {
    queued = await listPackets();
  } catch {}
  const mine = queued.filter((p) => p.ownerId === uid);
  if (!mine.length) return;
  try {
    await startBeaconInternal(mine[0]); // listPackets() orders newest first
  } catch (e) {
    setStatus({ note: `Broadcast resume failed: ${e.message}` });
  }
}

// Manual trigger used by the mesh screen ("Update now"): flush + upload +
// harvest right away (the helper scan follows its own 5-minute cadence).
export async function runMeshNow() {
  await tick();
  return getMeshStatus();
}

// Called by the background location task (every ~10 min): flush + upload +
// harvest + a scan window. This is what keeps the helper role alive when the
// app is closed — no buttons, no open screen. Works from a cold start too:
// when the task wakes the app and the module state is fresh, the signed-in
// account is adopted from the tracked-device record.
export async function backgroundAgentPass() {
  if (!uid) {
    try {
      const raw = await AsyncStorage.getItem('lostphone.trackedDevice');
      const t = raw ? JSON.parse(raw) : null;
      if (t?.userId) uid = t.userId;
    } catch {}
  }
  if (!uid) return;
  await tick();
  if (!appActive) await runScanCycle().catch(() => {});
}

// --- Lifecycle --------------------------------------------------------------

export function setMeshUser(nextUid) {
  if (uid === nextUid) return;
  uid = nextUid ?? null;
  if (!uid) {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    setStatus({ active: false });
    return;
  }
  if (!appSub) {
    appSub = AppState.addEventListener('change', (s) => {
      appActive = s === 'active';
      if (appActive) tick().catch(() => {});
    });
  }
  appActive = AppState.currentState === 'active';
  setStatus({ active: true });
  resumeBeaconFromQueue().catch(() => {});
  tick().catch(() => {});
  if (!tickTimer) tickTimer = setInterval(() => tick().catch(() => {}), TICK_MS);
}

// Used by the mesh screen's manual beacon toggle to stay in sync with the agent.
// Also queue the packet: a manual test broadcast must survive a restart exactly
// like an automatic one (previously it only lived in the BLE advertiser).
export async function manualBeacon(packet) {
  try {
    await enqueuePacket(packet);
    console.log('[mesh-auto] sealed + queued', packet.packetId);
    setStatus({ queuedOwn: status.queuedOwn + 1 });
  } catch (e) {
    console.warn('[mesh-auto] manual beacon queue failed:', e?.message ?? String(e));
  }
  await startBeaconInternal(packet);
}

export async function manualBeaconStop() {
  await stopBeaconInternal('stopped manually');
}

export function isBeaconOn() {
  return beaconOn;
}
