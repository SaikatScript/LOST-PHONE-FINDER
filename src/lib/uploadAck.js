import { waitForPendingWrites, disableNetwork, enableNetwork } from 'firebase/firestore';
import { db } from './firebase';

// Firestore resolves writes made while OFFLINE locally (latency compensation),
// so a resolved pushLocation()/addDoc() does NOT prove the server got the
// write — with the default memory cache the write is simply lost if the app
// dies before it syncs. waitForPendingWrites() waits for the real backend
// acknowledgement; racing it with a timeout is the honest "did this upload?"
// signal that drives the Phase 5B offline broadcast and mesh uploads.

const UPLOAD_ACK_MS = 10000;

// In-memory QA state. Kept outside React so leaving the mesh screen cannot make
// the UI claim "online" while Firestore is still deliberately offline (that
// desync used to hide the switch and stall harvest until a full restart).
let simulatedOffline = false;

export function isFirestoreOffline() {
  return simulatedOffline;
}

export async function confirmedUpload(timeoutMs = UPLOAD_ACK_MS) {
  try {
    const res = await Promise.race([
      waitForPendingWrites(db).then(() => 'ok').catch(() => 'fail'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return res === 'ok';
  } catch {
    return false;
  }
}

// QA helper (mesh screen → Advanced tools): makes the Firestore SDK behave as
// if the phone had lost internet — writes queue locally, reads hit the cache,
// waitForPendingWrites never resolves — while the radios and adb stay up. This
// exercises the exact production offline chain (seal → queue → broadcast →
// auto upload + harvest) without unplugging the real network.
export async function setFirestoreOffline(off) {
  try {
    await (off ? disableNetwork(db) : enableNetwork(db));
    simulatedOffline = off;
    return true;
  } catch {
    return false;
  }
}
