// Native queue backend: persistent SQLite (blueprint §4 mesh_queue).
// Falls back to memory if the native module is missing (old dev binaries
// predate expo-sqlite) — same API, backlog lost on restart in that case.
const DB_NAME = 'mesh.db';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PACKETS = 200;

const SCHEMA = `CREATE TABLE IF NOT EXISTS mesh_packets (
  id INTEGER PRIMARY KEY NOT NULL,
  packet_id TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  hops INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);`;

// Android's SQLite can hand a valid-looking handle to a file that was left
// half-written (app killed mid-transaction, storage pressure, OS upgrade).
// Every query then rejects with NativeDatabase.prepareAsync + NullPointerException
// and the queue looks permanently empty. Treat those as repairable.
const STORAGE_FAULT =
  /prepareAsync|NullPointerException|not open|closed|no such table|malformed|disk I\/O|SQLITE_/i;

let db = null;
let sqliteFailed = false;
let healing = null;
const mem = new Map();

function isStorageFault(err) {
  return STORAGE_FAULT.test(String(err?.message ?? err ?? ''));
}

async function openFresh() {
  const SQLite = require('expo-sqlite');
  const opened = await SQLite.openDatabaseAsync(DB_NAME);
  await opened.execAsync(SCHEMA);
  return opened;
}

// Close, delete and recreate the file, then hand back a clean handle.
// Shared so simultaneous readers never race each other into two resets.
async function hardReset() {
  if (healing) return healing;
  healing = (async () => {
    const SQLite = require('expo-sqlite');
    const old = db;
    db = null;
    try {
      await old?.closeAsync();
    } catch {}
    try {
      await SQLite.deleteDatabaseAsync(DB_NAME);
    } catch {}
    const opened = await openFresh();
    db = opened;
    console.warn('[mesh-queue] storage fault repaired — queue database recreated');
    return opened;
  })();
  try {
    return await healing;
  } finally {
    healing = null;
  }
}

async function conn() {
  if (db) return db;
  if (healing) return healing.catch(() => null);
  if (sqliteFailed) return null;
  try {
    db = await openFresh();
  } catch (e) {
    if (isStorageFault(e)) {
      // The file itself is the problem: recreate it once before giving up.
      try {
        db = await hardReset();
      } catch {
        sqliteFailed = true;
      }
    } else {
      sqliteFailed = true;
    }
  }
  return db;
}

// Run against the live handle; on a storage fault, repair and retry once.
async function withDb(fn) {
  const first = await conn();
  if (!first) return fn(null);
  try {
    return await fn(first);
  } catch (e) {
    if (!isStorageFault(e)) throw e;
    console.warn('[mesh-queue] query failed, repairing:', e?.message ?? e);
    let fresh = null;
    try {
      fresh = await hardReset();
    } catch {
      db = null;
    }
    if (!fresh) return fn(null);
    return fn(fresh);
  }
}

export async function queueBackend() {
  await conn();
  return db ? 'sqlite' : 'memory';
}

export async function enqueuePacket(packet) {
  const expiresAt = Date.now() + TTL_MS;
  await withDb(async (c) => {
    if (!c) return memEnqueue(packet);
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
    await c.runAsync('DELETE FROM mesh_packets WHERE expires_at < ?', Date.now());
  });
}

export async function listPackets() {
  return withDb(async (c) => {
    if (!c) return memList();
    await c.runAsync('DELETE FROM mesh_packets WHERE expires_at < ?', Date.now());
    const rows = await c.getAllAsync(
      'SELECT packet_id AS packetId, owner_id AS ownerId, payload, hops, created_at AS createdAt FROM mesh_packets ORDER BY created_at DESC'
    );
    const out = [];
    for (const r of rows) {
      try {
        out.push({ ...JSON.parse(r.payload), storedAt: r.createdAt });
      } catch {
        // Corrupt or legacy row: drop it instead of letting one bad payload hide
        // the whole queue from the agent and the UI.
        try {
          await c.runAsync('DELETE FROM mesh_packets WHERE packet_id = ?', r.packetId);
        } catch {}
      }
    }
    return out;
  });
}

export async function removePacket(packetId) {
  await withDb(async (c) => {
    if (!c) return void mem.delete(packetId);
    await c.runAsync('DELETE FROM mesh_packets WHERE packet_id = ?', packetId);
  });
}

export async function pruneQueue() {
  const now = Date.now();
  await withDb(async (c) => {
    if (!c) {
      for (const [k, e] of mem) if (e.expiresAt < now) mem.delete(k);
      return;
    }
    await c.runAsync('DELETE FROM mesh_packets WHERE expires_at < ?', now);
  });
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
