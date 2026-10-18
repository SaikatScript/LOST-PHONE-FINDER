import { Platform, PermissionsAndroid } from 'react-native';
import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';

// Phase 4a radio: HELPER role only (scan → connect → read packet characteristic).
// ble-plx is central-only — it cannot advertise or run a GATT server, so the
// STOLEN-side beacon needs a custom native advertiser module (Phase 4b).
// Everything here lazy-requires ble-plx: old binaries lack the native module.

// Lost Phone Finder mesh service + packet characteristic (fixed, app-wide).
export const MESH_SERVICE_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6071';
export const MESH_PACKET_CHAR_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6072';

// A sealed location packet measures ~417 JSON bytes (~556 base64 chars), far
// beyond the default BLE payload of 20 bytes — Android's stack follows long
// reads by itself, so a single read can still deliver the whole packet.
const PACKET_CHARS = 500; // used as a sanity reference when reporting read sizes

let manager = null;
let scanning = false;

function getBle() {
  const { BleManager } = require('react-native-ble-plx');
  if (!manager) manager = new BleManager();
  return manager;
}

export function isBleAvailable() {
  try {
    getBle();
    return true;
  } catch {
    return false; // native module missing (old binary)
  }
}

async function ensureBlePermissions() {
  if (Platform.OS !== 'android') return true;
  const api = Platform.Version ?? 0;
  const perms =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(perms);
  const denied = Object.values(res).some((v) => v !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied) throw new Error('Bluetooth/location permission denied.');
  return true;
}

async function poweredOn(ble) {
  const state = await ble.state();
  if (state !== 'PoweredOn') throw new Error(`Bluetooth is ${state}. Turn it on.`);
}

// Scan for stolen phones advertising MESH_SERVICE_UUID. For each found device:
// connect → read sealed packet characteristic → hand to onPacket → disconnect.
// Resolves with { packets, stats } so the UI can report WHY it found nothing
// (radio dead vs. beacon missing vs. connect/read failure). Rejects on
// permission/radio errors.
export async function helperScanOnce(onPacket, timeoutMs = 20000) {
  const ble = getBle(); // throws on old binary — caller surfaces it
  await ensureBlePermissions();
  await poweredOn(ble);
  const packets = [];
  const stats = { seen: 0, connected: 0, read: 0, errors: [] };
  const trace = []; // step-by-step breadcrumbs for the alert on failure

  return new Promise((resolve, reject) => {
    if (scanning) return reject(new Error('Scan already running.'));
    scanning = true;
    let done = false;
    let restarts = 0;
    const stop = () => {
      try {
        ble.stopDeviceScan();
      } catch {}
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      scanning = false;
      resolve({ packets, stats, trace });
    };
    const timer = setTimeout(finish, timeoutMs);

    const fail = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      scanning = false;
      // Surface the real reason even when the failure surfaced as a scan
      // restart error (the old code reported only "Cannot start scanning").
      const first = stats.errors[0] ? ` — first device error: ${stats.errors[0]}` : '';
      reject(new Error(`${error?.message ?? String(error)}${first}`));
    };

    const startScan = () => {
      try {
        ble.startDeviceScan(null, { allowDuplicates: false }, listener);
      } catch (e) {
        stats.errors.push(`scan start failed: ${e?.message ?? e}`);
      }
    };

    // Resume scanning WITHOUT racing Android's stopDeviceScan (starting a scan
    // too soon after stopping is what produced "Cannot start scanning
    // operation" on the OPPO).
    const resume = async () => {
      if (done) return;
      await new Promise((r) => setTimeout(r, 400));
      if (done) return;
      restarts += 1;
      startScan();
    };

    // Match the mesh service in JS instead of using a scan filter: Android's
    // ScanFilter silently returns nothing on several stacks (Samsung firmware
    // especially) even while the advertiser is right next to it. Unfiltered +
    // local matching is the reliable path.
    const advertisesMesh = (dev) => {
      const uuids = dev.serviceUUIDs ?? dev.advertising?.serviceUUIDs ?? null;
      if (!uuids) return false;
      return uuids.some((u) => (u ?? '').toLowerCase() === MESH_SERVICE_UUID.toLowerCase());
    };

    // A sealed packet is ~420-560 base64 chars but the default BLE payload is
    // only 20 bytes. Android's stack follows long reads by itself (that is how
    // 568 chars arrived on the OPPO), so the failure here is decode-side. Keep
    // the loop to also handle stacks that hand out chunks manually.
    const readPacket = async (char) => {
      let b64 = '';
      let prev = null;
      let lastErr = null;
      for (let i = 0; i < 12; i++) {
        const res = await char.read();
        const chunk = res?.value ?? '';
        if (!chunk) break;
        if (chunk === prev) break; // stack repeats itself → no continuation support
        b64 += chunk;
        prev = chunk;
        try {
          const bytes = decodeBase64(b64);
          const text = encodeUTF8(bytes);
          const parsed = JSON.parse(text);
          console.log('[mesh] read ok, b64', b64.length, 'bytes', bytes.length);
          return parsed;
        } catch (e) {
          lastErr = e;
          // Log EVERY attempt so logcat shows whether the bytes or the parser
          // are at fault (the old code hid this behind "truncated").
          console.log(
            '[mesh] read attempt',
            i,
            'b64len',
            b64.length,
            'err',
            e?.message ?? String(e),
            'head',
            headOf(b64)
          );
        }
      }
      throw new Error(
        `read failed: ${b64.length} base64 chars, last error: ${lastErr?.message ?? 'unknown'}` +
          ` | decoded head: ${headOf(b64)}`
      );
    };

    // Best-effort peek at the first bytes of what actually arrived, so the
    // alert says WHAT came back instead of guessing.
    const headOf = (b64) => {
      try {
        return JSON.stringify(encodeUTF8(decodeBase64(b64.slice(0, 80))).slice(0, 70));
      } catch (e) {
        return `<- base64/utf8 decode threw: ${e?.message ?? e}`;
      }
    };

    // Named function so a failed connect can resume the SAME handler (the old
    // code restarted with a no-op callback and then silently ignored every
    // later advertisement).
    const listener = async (error, dev) => {
      if (done) return;
      if (error) {
        const msg = error?.message ?? String(error);
        // A scan that refuses to restart is not fatal: the packet may already
        // be in hand. Retry once, then finish with what we have.
        if (restarts > 0 && /cannot start scanning|already started/i.test(msg)) {
          stats.errors.push(`scan resume failed: ${msg}`);
          if (restarts < 3) return void resume();
          return finish();
        }
        return fail(error);
      }
      if (!dev) return;
      if (!advertisesMesh(dev)) return; // just a random nearby BLE device
      stats.seen += 1;
      try {
        stop(); // pause scanning while connected to this device
        trace.push(`found beacon ${dev.id}`);
        const connected = await dev.connect({ timeout: 8000 });
        stats.connected += 1;
        trace.push('connected');
        // Big MTU so the whole sealed packet fits in one read where the stack
        // allows it (Android 14+ already negotiates ~517 and ignores this).
        try {
          await connected.requestMTU(512);
          trace.push('mtu 512 requested');
        } catch (e) {
          trace.push(`mtu request failed: ${e?.message ?? e}`);
        }
        // NOTE ble-plx 3.x: discoverAllServicesAndCharacteristics() resolves to
        // the Device itself — the service list comes from connected.services().
        await connected.discoverAllServicesAndCharacteristics();
        const svcArr = (await connected.services().catch(() => [])) ?? [];
        const svcList = svcArr.map((s) => s?.uuid ?? '?').join(',');
        trace.push(`services: ${svcArr.length} [${svcList.slice(0, 80)}]`);
        const chars = await connected.characteristicsForService(MESH_SERVICE_UUID);
        trace.push(`mesh characteristics: ${chars?.length ?? 0}`);
        const packetChar = (chars ?? []).find(
          (c) => (c.uuid ?? '').toLowerCase() === MESH_PACKET_CHAR_UUID.toLowerCase()
        );
        if (packetChar) {
          const packet = await readPacket(packetChar);
          packets.push(packet);
          stats.read += 1;
          trace.push('packet read + parsed');
          if (onPacket) await onPacket(packet);
        } else {
          trace.push('mesh service found but packet characteristic missing');
          stats.errors.push('connected, packet characteristic missing');
        }
        await connected.cancelConnection().catch(() => {});
      } catch (e) {
        // this device failed — record it and keep scanning the rest
        trace.push(`FAILED: ${e?.message ?? e}`);
        stats.errors.push(e?.message ?? String(e));
      } finally {
        await resume();
      }
    };

    startScan();
  });
}

// Radio self-check: scan with NO filter and report every BLE device nearby.
// Distinguishes "my radio/permissions are dead" (empty list) from "the radio is
// fine but no phone is advertising our mesh service" (list is non-empty).
export async function scanNearbyDevices(ms = 8000) {
  const ble = getBle();
  await ensureBlePermissions();
  await poweredOn(ble);
  const seen = new Map();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ble.stopDeviceScan();
      } catch {}
      resolve([...seen.values()]);
    };
    setTimeout(finish, ms);
    ble.startDeviceScan(null, { allowDuplicates: false }, (error, dev) => {
      if (error) {
        if (!done) {
          done = true;
          try {
            ble.stopDeviceScan();
          } catch {}
          reject(new Error(error?.message ?? String(error)));
        }
        return;
      }
      if (dev) seen.set(dev.id, dev.name || dev.localName || dev.id);
    });
  });
}

export function stopHelperScan() {
  try {
    manager?.stopDeviceScan();
  } catch {}
  scanning = false;
}

// Stolen-side beacon: NOT implementable with ble-plx (no peripheral support).
// Phase 4b ships a small Expo native module (BluetoothLeAdvertiser + GATT
// server exposing MESH_PACKET_CHAR_UUID). Until then, relay testing uses the
// cloud path (create packet → upload → harvest), which exercises identical
// crypto/queue/relay logic.
// Stolen-side beacon via the MeshAdvertiser native module: serves one sealed
// packet over GATT + advertises the mesh service UUID. Lazy-requires the
// wrapper (old binaries lack the native module). Runtime Bluetooth grants are
// requested here with RN-core PermissionsAndroid (string form works on every
// RN version, no extra dependency).
export async function startBeacon(packet) {
  if (Platform.OS !== 'android') throw new Error('Mesh beacon is Android-only.');
  if ((Platform.Version ?? 0) >= 31) {
    const res = await PermissionsAndroid.requestMultiple([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_ADVERTISE',
    ]);
    const denied = Object.values(res).some((v) => v !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied) throw new Error('Bluetooth permissions denied.');
  }
  let Adv;
  try {
    Adv = require('../../modules/mesh-advertiser/src/index');
  } catch {
    throw new Error('Beacon module missing — install the latest dev build.');
  }
  const payload = encodeBase64(decodeUTF8(JSON.stringify(packet)));
  const ok = Adv.startBeacon(MESH_SERVICE_UUID, MESH_PACKET_CHAR_UUID, payload);
  if (!ok) throw new Error(Adv.getBeaconLastError() || 'Beacon failed to start.');
  return true;
}

export async function stopBeacon() {
  try {
    const Adv = require('../../modules/mesh-advertiser/src/index');
    Adv.stopBeacon();
  } catch {
    // module missing or already stopped — nothing to do
  }
}

export function addBeaconListener(fn) {
  const Adv = require('../../modules/mesh-advertiser/src/index');
  return Adv.addBeaconListener(fn);
}
