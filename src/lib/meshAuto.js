import { AppState, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encodeBase64 } from 'tweetnacl-util';
import { ensureDeviceKeys, sealLocationPacket } from './meshCrypto';
import { enqueuePacket, listPackets, removePacket } from './meshQueue';
import { uploadRelay, harvestRelays, flushQueueAsGateway } from './meshRelay';
import { helperScanOnce, startBeacon, stopBeacon, isBleAvailable } from './meshBle';

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

let uid = null;
let tickTimer = null;
let appSub = null;
let appActive = true;
let tickBusy = false;
let scanBusy = false;
let lastHarvestAt = 0;
let lastScanAt = 0;
let beaconOn = false;

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
  try {
    if (!(await bleGrantsOk())) {
      setStatus({
        note: 'Fix saved for upload. Bluetooth permission is missing, so the offline broadcast could not start.',
        queuedOwn: status.queuedOwn,
      });
      return false;
    }
    const kp = await ensureDeviceKeys(userId, deviceId);
    const packet = await sealLocationPacket({
      ownerId: userId,
      deviceId,
      lat,
      lng,
      accuracy,
      battery,
      ownerPubB64: encodeBase64(kp.publicKey),
    });
    await enqueuePacket(packet);
    setStatus({ queuedOwn: status.queuedOwn + 1, note: '' });
    await startBeaconInternal(packet);
    return true;
  } catch (e) {
    setStatus({ note: `Offline broadcast failed: ${e.message}` });
    return false;
  }
}

// Tracking calls this when a direct upload succeeds again.
export async function noteOnlinePush() {
  if (beaconOn) await stopBeaconInternal('internet back — sent directly, broadcast stopped');
  if (uid) tick().catch(() => {});
}

// --- Heartbeat --------------------------------------------------------------

async function tick() {
  if (!uid || tickBusy) return;
  tickBusy = true;
  try {
    let queued = [];
    try {
      queued = await listPackets();
    } catch {
      queued = [];
    }

    let sent = 0;
    let anyOk = false;
    let anyFail = false;

    // 1) Helper backlog: upload packets sealed by OTHER phones.
    const foreign = queued.filter((p) => p.ownerId !== uid);
    if (foreign.length) {
      try {
        const n = await flushQueueAsGateway(uid, foreign);
        sent += n;
        if (n > 0) anyOk = true;
        else anyFail = true;
      } catch {
        anyFail = true;
      }
    }

    // 2) My own fixes sealed while offline: straight to relays.
    const mine = queued.filter((p) => p.ownerId === uid);
    let mineSent = 0;
    for (const p of mine) {
      try {
        await uploadRelay(p);
        await removePacket(p.packetId);
        mineSent += 1;
        anyOk = true;
      } catch {
        anyFail = true;
        break; // still offline — keep the rest queued
      }
    }
    sent += mineSent;

    // 3) Harvest: fold my relays (own uploads + packets helpers carried for me)
    // into device history. Runs periodically and right after any upload.
    let harvestText = status.lastHarvestText;
    if (Date.now() - lastHarvestAt >= HARVEST_EVERY_MS || mineSent > 0) {
      try {
        const res = await harvestRelays(uid);
        lastHarvestAt = Date.now();
        anyOk = true;
        harvestText = `checked ${res.checked}, decrypted ${res.opened}${res.blank ? `, ${res.blank} ping` : ''}`;
      } catch {
        anyFail = true;
      }
    }

    // Everything of mine is uploaded again → the broadcast is no longer needed.
    if (beaconOn && mine.length - mineSent === 0 && anyOk) {
      await stopBeaconInternal('internet back — broadcast stopped');
    }

    if (mineSent > 0) console.log('[mesh-auto] uploaded own offline fixes:', mineSent);
    if (harvestText !== status.lastHarvestText) {
      console.log('[mesh-auto] harvest:', harvestText);
    }

    let after = queued;
    try {
      after = await listPackets();
    } catch {}
    const stillMine = after.filter((p) => p.ownerId === uid).length;

    setStatus({
      online: anyOk ? true : anyFail ? false : status.online,
      queuedTotal: after.length,
      queuedOwn: stillMine,
      lastTickAt: Date.now(),
      lastHarvestAt,
      lastHarvestText: harvestText,
      relayedUp: status.relayedUp + sent,
    });

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
  let uploaded = 0;
  try {
    const res = await helperScanOnce(async (packet) => {
      try {
        await enqueuePacket(packet);
        await uploadRelay(packet);
        await removePacket(packet.packetId);
        uploaded += 1;
      } catch {
        // Offline: stays in the queue; the next tick uploads it.
      }
    }, SCAN_WINDOW_MS);
    setStatus({
      scanning: false,
      lastScanAt: Date.now(),
      lastScanSeen: res.stats.seen,
      lastScanRead: res.stats.read,
      relayedUp: status.relayedUp + uploaded,
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
export async function manualBeacon(packet) {
  await startBeaconInternal(packet);
}

export async function manualBeaconStop() {
  await stopBeaconInternal('stopped manually');
}

export function isBeaconOn() {
  return beaconOn;
}
