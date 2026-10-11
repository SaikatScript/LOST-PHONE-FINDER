import {
  collection,
  addDoc,
  doc,
  setDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db } from './firebase';

// Blueprint §5.3: locations live under users/{uid}/devices/{deviceId}/locations,
// plus lastLocation/lastBattery rollup on the device doc.
export function deviceLocationsRef(userId, deviceId) {
  return collection(db, 'users', userId, 'devices', deviceId, 'locations');
}

export async function pushLocation(userId, deviceId, { lat, lng, accuracy, battery, source = 'gps' }) {
  const payload = {
    lat,
    lng,
    accuracy: accuracy ?? null,
    battery: battery ?? null,
    timestamp: serverTimestamp(),
    source,
    hopCount: 0,
  };
  await addDoc(deviceLocationsRef(userId, deviceId), payload);
  // Rollup for list/map markers (blueprint §4: lastLocation, lastBattery, lastUpdate).
  await setDoc(
    doc(db, 'users', userId, 'devices', deviceId),
    {
      lastLocation: { latitude: lat, longitude: lng },
      lastBattery: battery ?? null,
      lastUpdate: serverTimestamp(),
    },
    { merge: true }
  );
}

export function subscribeToLocations(userId, deviceId, count, onData, onError) {
  const q = query(deviceLocationsRef(userId, deviceId), orderBy('timestamp', 'desc'), limit(count));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export async function listRecentLocations(userId, deviceId, count = 50) {
  const q = query(deviceLocationsRef(userId, deviceId), orderBy('timestamp', 'desc'), limit(count));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
