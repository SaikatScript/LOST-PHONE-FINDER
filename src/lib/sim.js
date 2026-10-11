import { getDevice, updateDevice } from './devices';

// Blueprint §5.4 honesty note: true IMSI/ICCID reads need
// READ_PRIVILEGED_PHONE_STATE (system apps only, Android 10+ blocks regular
// apps), so no store app — native module or not — can compare real IMSIs.
// We detect SIM swaps heuristically via expo-cellular: carrier name + MCC +
// MNC + ISO country. A thief swapping in a different operator's SIM changes
// at least one of these; same-operator swaps may not be caught (documented
// limitation, see README Phase 3).

// Lazy requires: these native modules postdate the currently installed dev
// build binary; top-level imports would red-screen old binaries.
const getCellular = () => require('expo-cellular');

export async function ensureSimPermission() {
  const Cellular = getCellular();
  const res = await Cellular.requestPermissionsAsync();
  if (res.status !== 'granted') throw new Error('Phone-state permission denied.');
  return true;
}

async function safe(promise) {
  try {
    return (await promise) ?? null;
  } catch {
    return null;
  }
}

export async function readSimFingerprint() {
  const Cellular = getCellular();
  const [carrier, mcc, mnc, iso] = await Promise.all([
    safe(Cellular.getCarrierNameAsync()),
    safe(Cellular.getMobileCountryCodeAsync()),
    safe(Cellular.getMobileNetworkCodeAsync()),
    safe(Cellular.getIsoCountryCodeAsync()),
  ]);
  return { carrier, mcc, mnc, iso };
}

export function fingerprintId(fp) {
  if (!fp) return '';
  return [fp.carrier ?? '?', fp.mcc ?? '?', fp.mnc ?? '?', fp.iso ?? '?'].join('|');
}

export async function snapshotSim(userId, deviceId) {
  const fp = await readSimFingerprint();
  await updateDevice(userId, deviceId, {
    simFingerprint: fingerprintId(fp),
    simCarrier: fp.carrier ?? null,
    simMccMnc: fp.mcc && fp.mnc ? `${fp.mcc}${fp.mnc}` : null,
  });
  return fp;
}

// Returns { swapped, firstSnapshot, current, stored }.
// Marks the device simSwapped + isLost when a previously snapshotted SIM changes.
export async function checkSimChange(userId, deviceId, notify) {
  const current = await readSimFingerprint();
  const currentId = fingerprintId(current);
  const device = await getDevice(userId, deviceId);
  const storedId = device?.simFingerprint ?? '';

  if (!storedId) {
    // No baseline yet (device added before Phase 3): adopt current silently.
    await updateDevice(userId, deviceId, {
      simFingerprint: currentId,
      simCarrier: current.carrier ?? null,
      simMccMnc: current.mcc && current.mnc ? `${current.mcc}${current.mnc}` : null,
    });
    return { swapped: false, firstSnapshot: true, current, stored: '' };
  }

  if (currentId !== storedId) {
    await updateDevice(userId, deviceId, { simSwapped: true, isLost: true });
    if (notify) {
      await notify(
        'SIM swap detected',
        `This device's SIM changed (${current.carrier ?? 'unknown carrier'}). Marked LOST.`
      ).catch(() => {});
    }
    return { swapped: true, firstSnapshot: false, current, stored: storedId };
  }
  return { swapped: false, firstSnapshot: false, current, stored: storedId };
}
