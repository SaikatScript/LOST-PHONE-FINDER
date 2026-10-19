import { waitForPendingWrites } from 'firebase/firestore';
import { db } from './firebase';

// Firestore resolves writes made while OFFLINE locally (latency compensation),
// so a resolved pushLocation()/addDoc() does NOT prove the server got the
// write — with the default memory cache the write is simply lost if the app
// dies before it syncs. waitForPendingWrites() waits for the real backend
// acknowledgement; racing it with a timeout is the honest "did this upload?"
// signal that drives the Phase 5B offline broadcast and mesh uploads.

const UPLOAD_ACK_MS = 10000;

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
