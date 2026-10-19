import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

// Phase 4a: sealed mesh packets (NaCl public-key box, pure JS).
// Threat model: nearby stranger phones relaying packets must NOT read
// locations — payloads are opaque blobs to everyone except the owner account.
// Owner-side privacy rests on owner-only Firestore rules (see firestore.rules:
// relays + deviceKeys readable only by the owning uid).
//
// Key model (MVP): one box keypair per DEVICE. Private key lives in SecureStore
// (+ owner-only backup in deviceKeys/{deviceId} so the owner's OTHER phones
// can harvest). Public key is published on the device doc (blueprint §4 field).

const privKeyName = (deviceId) => `mesh.priv.${deviceId}`;

// Secure random comes straight from expo-crypto's native implementation
// (documented getRandomBytesAsync). tweetnacl's internal PRNG needs
// crypto.getRandomValues, missing in Hermes — so we never let nacl generate:
// secrets/nonces are made here and injected via fromSecretKey/explicit nonce.
// STATIC require on purpose: Metro inlines it into the main bundle, so sealing
// works with zero internet. An async import() is fetched from the dev server
// at first use and fails on an offline phone ("Secure random unavailable") —
// exactly the stolen-phone case this beacon exists for. Old binaries without
// the native module still get a clear error instead of a red screen.
async function randBytes(n) {
  let Crypto;
  try {
    Crypto = require('expo-crypto');
  } catch {
    throw new Error('Secure random unavailable — install the latest dev build.');
  }
  // The bridge may hand back a plain Array: nacl demands real Uint8Arrays.
  return Uint8Array.from(await Crypto.getRandomBytesAsync(n));
}

export async function ensureDeviceKeys(userId, deviceId) {
  let privB64 = await SecureStore.getItemAsync(privKeyName(deviceId));
  if (!privB64) {
    const kp = nacl.box.keyPair.fromSecretKey(await randBytes(32));
    privB64 = encodeBase64(kp.secretKey);
    await SecureStore.setItemAsync(privKeyName(deviceId), privB64);
    const pubB64 = encodeBase64(kp.publicKey);
    await setDoc(
      doc(db, 'users', userId, 'devices', deviceId),
      { publicKey: pubB64 },
      { merge: true }
    );
    await setDoc(
      doc(db, 'deviceKeys', deviceId),
      { userId, privKey: privB64 },
      { merge: true }
    );
    return kp;
  }
  const secretKey = decodeBase64(privB64);
  return { publicKey: nacl.box.keyPair.fromSecretKey(secretKey).publicKey, secretKey };
}

async function loadSecretKey(userId, deviceId) {
  const privB64 =
    (await SecureStore.getItemAsync(privKeyName(deviceId))) ??
    (await getDoc(doc(db, 'deviceKeys', deviceId)).then((snap) =>
      snap.exists() && snap.data().userId === userId ? snap.data().privKey : null
    ));
  if (!privB64) throw new Error('No mesh key for this device.');
  return decodeBase64(privB64);
}

// Seal a location fix so only the holder of the device private key can open it.
// Returns the relay-ready packet (plaintext routing header + sealed body).
export async function sealLocationPacket({ ownerId, deviceId, lat, lng, accuracy, battery, ownerPubB64 }) {
  // NOTE tweetnacl-util naming: decodeUTF8(string)->bytes, encodeUTF8(bytes)->string.
  const body = decodeUTF8(
    JSON.stringify({ lat, lng, accuracy: accuracy ?? null, battery: battery ?? null, ts: Date.now(), src: 'mesh' })
  );
  const nonce = await randBytes(nacl.box.nonceLength);
  const eph = nacl.box.keyPair.fromSecretKey(await randBytes(32));
  const sealed = nacl.box(body, nonce, decodeBase64(ownerPubB64), eph.secretKey);
  const rand = Array.from(await randBytes(4), (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    packetId: `${deviceId}-${Date.now()}-${rand}`,
    ownerId,
    deviceId,
    eph: encodeBase64(eph.publicKey),
    nonce: encodeBase64(nonce),
    body: encodeBase64(sealed),
    hops: 0,
    createdAt: Date.now(),
  };
}

export async function openLocationPacket(userId, deviceId, packet) {
  const secretKey = await loadSecretKey(userId, deviceId);
  const opened = nacl.box.open(
    decodeBase64(packet.body),
    decodeBase64(packet.nonce),
    decodeBase64(packet.eph),
    secretKey
  );
  if (!opened) throw new Error('Packet failed to decrypt (wrong key or tampered).');
  return JSON.parse(encodeUTF8(opened));
}
