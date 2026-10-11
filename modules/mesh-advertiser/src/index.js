// JS wrapper for the MeshAdvertiser native module (Android-only).
// Import this file LAZILY (require inside the calling function): old dev
// binaries predate the native module and would red-screen on static import.
import { requireNativeModule } from 'expo';

const MeshAdvertiser = requireNativeModule('MeshAdvertiser');

export function startBeacon(serviceUuid, charUuid, packetBase64) {
  return MeshAdvertiser.startBeacon(serviceUuid, charUuid, packetBase64);
}

export function stopBeacon() {
  return MeshAdvertiser.stopBeacon();
}

export function isBeaconAdvertising() {
  try {
    return MeshAdvertiser.isAdvertising();
  } catch {
    return false;
  }
}

export function getBeaconLastError() {
  try {
    return MeshAdvertiser.getLastError();
  } catch {
    return '';
  }
}

export function addBeaconListener(fn) {
  return MeshAdvertiser.addListener('onBeaconEvent', fn);
}
