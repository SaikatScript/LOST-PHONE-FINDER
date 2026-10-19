import {
  collection,
  addDoc,
  doc,
  deleteDoc,
  getDocs,
  serverTimestamp,
  query,
  where,
  limit,
} from 'firebase/firestore';
import { db } from './firebase';
import { openLocationPacket } from './meshCrypto';
import { pushLocation } from './locations';

// Phase 4a gateway: a helper WITH internet uploads queued packets (opaque to
// the helper) to relays/; the owner's app harvests its own relays, decrypts,
// and folds fixes into device locations. Firestore rules: anyone authed can
// create; only the ownerId account can read/delete.

export async function uploadRelay(packet) {
  await addDoc(collection(db, 'relays'), {
    packetId: packet.packetId,
    ownerId: packet.ownerId,
    deviceId: packet.deviceId,
    eph: packet.eph,
    nonce: packet.nonce,
    body: packet.body,
    hops: (packet.hops ?? 0) + 1,
    createdAt: serverTimestamp(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

// Upload every queued packet not owned by me (my own go direct via tracking).
// Does NOT delete from the SQLite queue: addDoc() resolves locally while
// offline, so a packet may only be dropped once the server has ACKNOWLEDGED
// the write (uploadAck.js). The caller checks the ack and removes the packets.
// Returns the packetIds handed to Firestore.
export async function flushQueueAsGateway(myUid, queued) {
  const attempted = [];
  for (const p of queued) {
    if (p.ownerId === myUid) continue;
    try {
      await uploadRelay(p);
      attempted.push(p.packetId);
    } catch {
      // keep for next flush (transient failure)
    }
  }
  return attempted;
}

// Owner harvest: decrypt my relays into device locations, then delete them.
export async function harvestRelays(userId) {
  const q = query(collection(db, 'relays'), where('ownerId', '==', userId), limit(50));
  const snap = await getDocs(q);
  let opened = 0;
  let blank = 0;
  const seen = new Set();
  for (const d of snap.docs) {
    const r = d.data();
    if (r.packetId && seen.has(r.packetId)) {
      // Duplicate relay of a packet already folded in above — drop the copy.
      try {
        await deleteDoc(doc(db, 'relays', d.id));
      } catch {}
      continue;
    }
    if (r.packetId) seen.add(r.packetId);
    try {
      const fix = await openLocationPacket(userId, r.deviceId, {
        body: r.body,
        nonce: r.nonce,
        eph: r.eph,
      });
      if (fix.lat == null || fix.lng == null) {
        // Beacon sealed without a GPS fix — nothing to plot, count the ping only.
        blank += 1;
      } else {
        await pushLocation(userId, r.deviceId, {
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
          battery: fix.battery,
          source: 'mesh',
        });
      }
      opened += 1;
    } catch {
      // undecryptable (wrong key/rotation) — drop so it doesn't loop forever
    }
    try {
      await deleteDoc(doc(db, 'relays', d.id));
    } catch {
      // leave for next harvest
    }
  }
  return { checked: snap.docs.length, opened, blank };
}
