// Native queue backend: persistent SQLite (blueprint §4 mesh_queue).
// Falls back to memory if the native module is missing (old dev binaries
// predate expo-sqlite) — same API, backlog lost on restart in that case.
const DB_NAME = 'mesh.db';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PACKETS = 200;

let db = null;
let sqliteFailed = false;
const mem = new Map();

async function conn() {
  if (db || sqliteFailed) return db;
  try {
    const SQLite = require('expo-sqlite');
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS mesh_packets (
        id INTEGER PRIMARY KEY NOT NULL,
        packet_id TEXT UNIQUE NOT NULL,
        owner_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        hops INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`
    );
  } catch {
    sqliteFailed = true;
    db = null;
  }
  return db;
}

export async function queueBackend() {
  await conn();
  return db ? 'sqlite' : 'memory';
}

export async function enqueuePacket(packet) {
  const c = await conn();
  if (!c) return memEnqueue(packet);
  const expiresAt = Date.now() + TTL_MS;
  await c.runAsync(
    'INSERT OR IGNORE INTO mesh_packets (packet_id, owner_id, payload, hops, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    packet.packetId,
    packet.ownerId,
    JSON.stringify(packet),
    packet.hops ?? 0,
    Date.now(),
    expiresAt
  );
  await c.runAsync(
    'DELETE FROM mesh_packets WHERE id NOT IN (SELECT id FROM mesh_packets ORDER BY created_at DESC LIMIT ?)',
    MAX_PACKETS
  );
  await pruneQueue();
}

export async function listPackets() {
  const c = await conn();
  if (!c) return memList();
  await pruneQueue();
  const rows = await c.getAllAsync(
    'SELECT packet_id AS packetId, owner_id AS ownerId, payload, hops, created_at AS createdAt FROM mesh_packets ORDER BY created_at DESC'
  );
  return rows.map((r) => ({ ...JSON.parse(r.payload), storedAt: r.createdAt }));
}

export async function removePacket(packetId) {
  const c = await conn();
  if (!c) return void mem.delete(packetId);
  await c.runAsync('DELETE FROM mesh_packets WHERE packet_id = ?', packetId);
}

export async function pruneQueue() {
  const c = await conn();
  const now = Date.now();
  if (!c) {
    for (const [k, e] of mem) if (e.expiresAt < now) mem.delete(k);
    return;
  }
  await c.runAsync('DELETE FROM mesh_packets WHERE expires_at < ?', now);
}

function memEnqueue(packet) {
  if (!mem.has(packet.packetId)) {
    mem.set(packet.packetId, { packet, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS });
    while (mem.size > MAX_PACKETS) mem.delete(mem.keys().next().value);
  }
}

function memList() {
  return [...mem.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({ ...e.packet, storedAt: e.createdAt }));
}

export async function queueCount() {
  return (await listPackets()).length;
}
