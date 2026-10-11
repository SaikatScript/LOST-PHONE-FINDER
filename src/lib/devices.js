import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from './firebase';

// Blueprint schema:
// users/{userId}/devices/{deviceId} {
//   deviceName, deviceModel, imsi, iccid, ownerPhone,
//   publicKey, lastLocation, lastBattery, lastUpdate, isLost, simSwapped
// }

export function userDevicesRef(userId) {
  return collection(db, 'users', userId, 'devices');
}

export function subscribeToDevices(userId, onData, onError) {
  const q = query(userDevicesRef(userId), orderBy('lastUpdate', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    onError
  );
}

export async function listDevices(userId) {
  const snap = await getDocs(userDevicesRef(userId));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getDevice(userId, deviceId) {
  const snap = await getDoc(doc(db, 'users', userId, 'devices', deviceId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function subscribeToDevice(userId, deviceId, onData, onError) {
  return onSnapshot(
    doc(db, 'users', userId, 'devices', deviceId),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

export async function registerDevice(userId, device) {
  const ref = await addDoc(userDevicesRef(userId), {
    deviceName: device.deviceName ?? 'My Android',
    deviceModel: device.deviceModel ?? 'unknown',
    imsi: device.imsi ?? '',
    iccid: device.iccid ?? '',
    ownerPhone: device.ownerPhone ?? '',
    publicKey: device.publicKey ?? '',
    lastLocation: device.lastLocation ?? null,
    lastBattery: device.lastBattery ?? null,
    lastUpdate: serverTimestamp(),
    isLost: false,
    simSwapped: false,
  });
  return ref.id;
}

export async function updateDevice(userId, deviceId, patch) {
  await setDoc(
    doc(db, 'users', userId, 'devices', deviceId),
    { ...patch, lastUpdate: serverTimestamp() },
    { merge: true }
  );
}
