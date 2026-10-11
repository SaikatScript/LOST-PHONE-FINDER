// Web stub: no BLE radio on web.
export const MESH_SERVICE_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6071';
export const MESH_PACKET_CHAR_UUID = '6f7a4d2e-7a6c-4f5e-9b1a-2c3d4e5f6072';

export function isBleAvailable() {
  return false;
}

export async function helperScanOnce() {
  throw new Error('BLE scanning is Android-only.');
}

export function stopHelperScan() {}

export async function startBeacon() {
  throw new Error('Mesh beacon is Android-only.');
}

export async function stopBeacon() {}

export function addBeaconListener() {
  return { remove: () => {} };
}
