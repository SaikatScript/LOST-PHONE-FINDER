// Web queue backend: in-memory (expo-sqlite web needs wasm + COOP/COEP server
// headers — alpha, not worth it for an Android-first app). Same API as native.
// Backlog is lost on reload.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PACKETS = 200;

const mem = new Map();

export async function queueBackend() {
  return 'memory';
}

export async function enqueuePacket(packet) {
  if (!mem.has(packet.packetId)) {
    mem.set(packet.packetId, { packet, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS });
    while (mem.size > MAX_PACKETS) mem.delete(mem.keys().next().value);
  }
  await pruneQueue();
}

export async function listPackets() {
  await pruneQueue();
  return [...mem.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({ ...e.packet, storedAt: e.createdAt }));
}

export async function removePacket(packetId) {
  mem.delete(packetId);
}

export async function pruneQueue() {
  const now = Date.now();
  for (const [k, e] of mem) if (e.expiresAt < now) mem.delete(k);
}

export async function queueCount() {
  return (await listPackets()).length;
}
