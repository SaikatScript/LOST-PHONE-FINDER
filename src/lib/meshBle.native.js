import { Platform, PermissionsAndroid } from 'react-native';
import { decodeBase64, encodeBase64, decodeUTF8 } from 'tweetnacl-util';

// Phase 4a radio: HELPER role only (scan → connect → read packet characteristic).
// ble-plx is central-only — it cannot advertise or run a GATT server, so the
// STOLEN-side beacon needs a custom native advertiser module (Phase 4b).
// Everything here lazy-requires ble-plx: old binaries lack the native module.

// Lost Phone Finder mesh service + packet characteristic (fixed, app-wide).
export const MESH_SERVICE_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6071';
export const MESH_PACKET_CHAR_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6072';

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
// Resolves with packets received; rejects on permission/radio errors.
export async function helperScanOnce(onPacket, timeoutMs = 20000) {
  const ble = getBle(); // throws on old binary — caller surfaces it
  await ensureBlePermissions();
  await poweredOn(ble);
  const found = [];
  return new Promise((resolve, reject) => {
    if (scanning) return reject(new Error('Scan already running.'));
    scanning = true;
    const timer = setTimeout(() => {
      try {
        ble.stopDeviceScan();
      } catch {}
      scanning = false;
      resolve(found);
    }, timeoutMs);

    ble.startDeviceScan([MESH_SERVICE_UUID], { allowDuplicates: false }, async (error, dev) => {
      if (error) {
        clearTimeout(timer);
        scanning = false;
        try {
          ble.stopDeviceScan();
        } catch {}
        reject(new Error(error.message));
        return;
      }
      if (!dev) return;
      try {
        ble.stopDeviceScan();
        const connected = await dev.connect({ timeout: 8000 });
        await connected.discoverAllServicesAndCharacteristics();
        const chars = await connected.characteristicsForService(MESH_SERVICE_UUID);
        const packetChar = chars.find(
          (c) => c.uuid.toLowerCase() === MESH_PACKET_CHAR_UUID.toLowerCase()
        );
        if (packetChar) {
          const read = await packetChar.read();
          const json = encodeUTF8(decodeBase64(read.value ?? ''));
          const packet = JSON.parse(json);
          found.push(packet);
          if (onPacket) await onPacket(packet);
        }
        await connected.cancelConnection().catch(() => {});
      } catch {
        // device vanished / unreadable — keep scanning others
        try {
          ble.startDeviceScan([MESH_SERVICE_UUID], { allowDuplicates: false }, () => {});
        } catch {}
      }
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
