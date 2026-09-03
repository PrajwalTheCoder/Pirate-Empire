/**
 * NetPacker — Binary serialization for Pirate Empire multiplayer packets.
 *
 * Replaces JSON.stringify / JSON.parse with compact ArrayBuffer encoding.
 * Reduces ship-state packet size from ~150 bytes (JSON text) to 16 bytes (binary),
 * an 89% reduction, and eliminates GC-thrashing string allocations at 20 Hz.
 *
 * Protocol version: 2  (increment when packet layout changes)
 *
 * Message type IDs (single byte header):
 *   0x01  SHIP_STATE     — own ship position/velocity (20 Hz)
 *   0x02  AI_STATE       — array of enemy ship states (10 Hz)
 *   0x03  CANNON_FIRE    — cannonball spawn event
 *   0x04  DAMAGE_EVENT   — authoritative damage (host → client)
 *   0x05  DMG_REQUEST    — client cannon hit enemy, wants host to apply
 *   0x06  WORLD_LAYOUT_ACK — client ACKs world layout receipt
 *   0xFF  JSON_ENVELOPE  — fallback for infrequent/complex messages
 *
 * Coordinate convention:
 *   Positions packed as int16 with scale ×10 → range ±3276.7 world units
 *   (GameConfig.WORLD_SIZE / 2 is typically 500, so ±3276 is plenty)
 *   Velocities packed as int8 with scale ×10 → range ±12.7 units/s
 *   Rotation Y packed as uint8 → 0–255 maps to 0–2π
 *   Health values packed as uint16 (max 65535)
 *   Thrust packed as uint8 → 0–200 maps to −1.0–+1.0 (offset 100)
 *
 * Clock convention:
 *   AI_STATE packets embed a uint32 timestamp (performance.now() & 0xFFFFFFFF).
 *   The receiver stamps packets with its own local performance.now() on arrival
 *   for the jitter buffer — the embedded timestamp is only for ordering.
 */

// ── Type IDs ──────────────────────────────────────────────────────────────────
export const TYPE = Object.freeze({
  SHIP_STATE:       0x01,
  AI_STATE:         0x02,
  CANNON_FIRE:      0x03,
  DAMAGE_EVENT:     0x04,
  DMG_REQUEST:      0x05,
  WORLD_LAYOUT_ACK: 0x06,
  JSON_ENVELOPE:    0xFF,
});

// ── Protocol version ──────────────────────────────────────────────────────────
export const PROTOCOL_VERSION = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp a number to [min, max]. */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Encode rotation Y (radians) as a uint8 (0–255 = 0–2π). */
function encodeAngle(rad) {
  const normalized = ((rad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round((normalized / (Math.PI * 2)) * 255) & 0xFF;
}

/** Decode uint8 back to radians. */
function decodeAngle(byte) {
  return (byte / 255) * Math.PI * 2;
}

// ── SHIP STATE (16 bytes) ─────────────────────────────────────────────────────
//  Byte 0:     type = 0x01
//  Bytes 1–2:  x  (int16, ×10)
//  Bytes 3–4:  y  (int16, ×10)
//  Bytes 5–6:  z  (int16, ×10)
//  Byte 7:     rotY (uint8, 0–255 = 0–2π)
//  Byte 8:     vx (int8, ×10)
//  Byte 9:     vz (int8, ×10)
//  Bytes 10–11: health (uint16)
//  Bytes 12–13: maxHealth (uint16)
//  Byte 14:    thrust (uint8, 0–200 offset 100)
//  Byte 15:    spare / flags

export function packShipState(ship) {
  const buf = new ArrayBuffer(16);
  const v   = new DataView(buf);
  const p   = ship.group.position;
  const vel = ship.velocity;

  v.setUint8 (0,  TYPE.SHIP_STATE);
  v.setInt16 (1,  Math.round(clamp(p.x, -3276, 3276) * 10), false);
  v.setInt16 (3,  Math.round(clamp(p.y, -3276, 3276) * 10), false);
  v.setInt16 (5,  Math.round(clamp(p.z, -3276, 3276) * 10), false);
  v.setUint8 (7,  encodeAngle(ship.group.rotation.y));
  v.setInt8  (8,  Math.round(clamp(vel.x, -12.7, 12.7) * 10));
  v.setInt8  (9,  Math.round(clamp(vel.z, -12.7, 12.7) * 10));
  v.setUint16(10, Math.round(clamp(ship.health,    0, 65535)), false);
  v.setUint16(12, Math.round(clamp(ship.maxHealth, 0, 65535)), false);
  v.setUint8 (14, Math.round(clamp(ship.thrust * 100 + 100, 0, 200)));
  v.setUint8 (15, 0); // flags — reserved
  return buf;
}

export function unpackShipState(buf) {
  const v = new DataView(buf);
  return {
    x:   v.getInt16 (1,  false) / 10,
    y:   v.getInt16 (3,  false) / 10,
    z:   v.getInt16 (5,  false) / 10,
    ry:  decodeAngle(v.getUint8(7)),
    vx:  v.getInt8  (8)  / 10,
    vz:  v.getInt8  (9)  / 10,
    hp:  v.getUint16(10, false),
    mhp: v.getUint16(12, false),
    thx: (v.getUint8(14) - 100) / 100,
  };
}

// ── AI STATE (4-byte header + N × 12 bytes per ship) ─────────────────────────
//  Byte 0:      type = 0x02
//  Bytes 1–4:   timestamp low 32 bits of performance.now() (uint32, big-endian)
//  Byte 5:      ship count (uint8, max 255 ships)
//  Per ship (12 bytes):
//    Bytes 0–3: id hash (uint32) — FNV-1a hash of ship.id string
//    Bytes 4–5: x (int16, ×10)
//    Bytes 6–7: z (int16, ×10)
//    Byte 8:    rotY (uint8)
//    Bytes 9–10: health (uint16)
//    Byte 11:   class+faction packed byte (upper 4 bits = classIdx, lower 4 = factionIdx)

// Ship class index map (matches ShipConfig)
const CLASS_IDX = {
  PIRATE_SMALL: 0, PIRATE_MEDIUM: 1, PIRATE_LARGE: 2,
  MERCHANT: 3, SMALL: 4, MEDIUM: 5, LARGE: 6,
  GHOST: 7, PIRATE_HUNTER: 8,
};
const IDX_CLASS = Object.fromEntries(Object.entries(CLASS_IDX).map(([k,v]) => [v,k]));

const FACTION_IDX = {
  PLAYER: 0, PIRATE: 1, BRITISH: 2, SPANISH: 3,
  DUTCH: 4, MERCHANT: 5, PIRATE_HUNTER: 6,
};
const IDX_FACTION = Object.fromEntries(Object.entries(FACTION_IDX).map(([k,v]) => [v,k]));

/** FNV-1a 32-bit hash — maps a ship.id string to a stable uint32. */
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** Inverse map: hash → id string (populated lazily on the host, sent with full AI layout). */
const _hashToId = new Map();

/** Register a ship id → hash mapping so the client can look up strings from hashes. */
export function registerShipId(id) {
  const h = fnv32(id);
  _hashToId.set(h, id);
  return h;
}

/** Look up a string id from its hash. Returns null if unknown. */
export function resolveShipId(hash) {
  return _hashToId.get(hash) ?? null;
}

export function packAIState(stateArray) {
  const count = Math.min(stateArray.length, 255);
  // 6-byte header + 12 bytes per ship
  const buf = new ArrayBuffer(6 + count * 12);
  const v   = new DataView(buf);
  const ts  = (performance.now() * 1) | 0; // integer ms timestamp

  v.setUint8 (0, TYPE.AI_STATE);
  v.setUint32(1, ts >>> 0, false);  // low 32-bits of timestamp (big-endian)
  v.setUint8 (5, count);

  let offset = 6;
  for (let i = 0; i < count; i++) {
    const s = stateArray[i];
    const hash  = registerShipId(s.id);
    const clsI  = CLASS_IDX[s.cls]  ?? 4;
    const facI  = FACTION_IDX[s.fac] ?? 1;

    v.setUint32(offset,     hash >>> 0, false);
    v.setInt16 (offset + 4, Math.round(clamp(s.x, -3276, 3276) * 10), false);
    v.setInt16 (offset + 6, Math.round(clamp(s.z, -3276, 3276) * 10), false);
    v.setUint8 (offset + 8, encodeAngle(s.ry));
    v.setUint16(offset + 9, Math.round(clamp(s.hp,  0, 65535)), false);
    v.setUint8 (offset + 11, ((clsI & 0xF) << 4) | (facI & 0xF));
    offset += 12;
  }
  return buf;
}

export function unpackAIState(buf) {
  const v     = new DataView(buf);
  const ts    = v.getUint32(1, false); // raw ms timestamp from sender
  const count = v.getUint8(5);
  const ships = [];

  let offset = 6;
  for (let i = 0; i < count; i++) {
    const hash  = v.getUint32(offset, false);
    const id    = resolveShipId(hash) ?? `ghost_${hash.toString(16)}`;
    const x     = v.getInt16 (offset + 4, false) / 10;
    const z     = v.getInt16 (offset + 6, false) / 10;
    const ry    = decodeAngle(v.getUint8(offset + 8));
    const hp    = v.getUint16(offset + 9, false);
    const flags = v.getUint8 (offset + 11);
    const cls   = IDX_CLASS  [(flags >> 4) & 0xF] ?? 'PIRATE_SMALL';
    const fac   = IDX_FACTION[flags & 0xF]        ?? 'PIRATE';
    ships.push({ id, cls, fac, x, z, ry, hp, mhp: hp }); // mhp not transmitted (saves 2 bytes); set to hp as placeholder
    offset += 12;
  }
  return { ts, ships };
}

// ── CANNON FIRE (24 bytes) ────────────────────────────────────────────────────
//  Byte 0:     type = 0x03
//  Bytes 1–6:  posL (x,y,z int16 ×10 each)
//  Bytes 7–12: velL (x,y,z int16 ×10 each)
//  Bytes 13–18: posR
//  Bytes 19–24: velR
//  Byte 25:    ammo type byte (0=ROUND,1=CHAIN,2=FIRE)

const AMMO_BYTE = { ROUND: 0, CHAIN: 1, FIRE: 2, CURSED_SPECTRAL: 3 };
const BYTE_AMMO = Object.fromEntries(Object.entries(AMMO_BYTE).map(([k,v]) => [v,k]));

export function packCannonFire(posL, velL, posR, velR, ammo) {
  const buf = new ArrayBuffer(26);
  const v   = new DataView(buf);

  const writeVec3Int16 = (offset, vec) => {
    v.setInt16(offset,     Math.round(clamp(vec.x, -3276, 3276) * 10), false);
    v.setInt16(offset + 2, Math.round(clamp(vec.y, -3276, 3276) * 10), false);
    v.setInt16(offset + 4, Math.round(clamp(vec.z, -3276, 3276) * 10), false);
  };

  v.setUint8(0, TYPE.CANNON_FIRE);
  writeVec3Int16(1,  posL);
  writeVec3Int16(7,  velL);
  writeVec3Int16(13, posR);
  writeVec3Int16(19, velR);
  v.setUint8(25, AMMO_BYTE[ammo] ?? 0);
  return buf;
}

export function unpackCannonFire(buf) {
  const v = new DataView(buf);
  const readVec3 = (offset) => ({
    x: v.getInt16(offset,     false) / 10,
    y: v.getInt16(offset + 2, false) / 10,
    z: v.getInt16(offset + 4, false) / 10,
  });
  return {
    pL: readVec3(1),  vL: readVec3(7),
    pR: readVec3(13), vR: readVec3(19),
    a:  BYTE_AMMO[v.getUint8(25)] ?? 'ROUND',
  };
}

// ── DAMAGE EVENT / DMG REQUEST (7 bytes) ─────────────────────────────────────
//  Byte 0:     type (0x04 or 0x05)
//  Bytes 1–4:  ship id hash (uint32)
//  Bytes 5–6:  damage (uint16)

export function packDamageEvent(shipId, damage) {
  const buf = new ArrayBuffer(7);
  const v   = new DataView(buf);
  v.setUint8 (0, TYPE.DAMAGE_EVENT);
  v.setUint32(1, fnv32(shipId) >>> 0, false);
  v.setUint16(5, Math.round(clamp(damage, 0, 65535)), false);
  return buf;
}

export function packDamageRequest(shipId, damage) {
  const buf = new ArrayBuffer(7);
  const v   = new DataView(buf);
  v.setUint8 (0, TYPE.DMG_REQUEST);
  v.setUint32(1, fnv32(shipId) >>> 0, false);
  v.setUint16(5, Math.round(clamp(damage, 0, 65535)), false);
  return buf;
}

export function unpackDamage(buf) {
  const v    = new DataView(buf);
  const hash = v.getUint32(1, false);
  return {
    id:  resolveShipId(hash) ?? `unknown_${hash.toString(16)}`,
    dmg: v.getUint16(5, false),
  };
}

// ── WORLD LAYOUT ACK (1 byte) ─────────────────────────────────────────────────
export function packWorldLayoutAck() {
  const buf = new ArrayBuffer(1);
  new DataView(buf).setUint8(0, TYPE.WORLD_LAYOUT_ACK);
  return buf;
}

// ── JSON ENVELOPE (fallback for complex messages) ─────────────────────────────
//  Byte 0:   type = 0xFF
//  Bytes 1+: UTF-8 encoded JSON string (TextEncoder)

const _enc = new TextEncoder();
const _dec = new TextDecoder();

export function packJSON(msgType, data) {
  const json  = JSON.stringify({ t: msgType, d: data });
  const bytes = _enc.encode(json);
  const buf   = new ArrayBuffer(1 + bytes.byteLength);
  const v     = new DataView(buf);
  v.setUint8(0, TYPE.JSON_ENVELOPE);
  new Uint8Array(buf, 1).set(bytes);
  return buf;
}

export function unpackJSON(buf) {
  const text = _dec.decode(new Uint8Array(buf, 1));
  return JSON.parse(text);
}

// ── Top-level dispatcher ──────────────────────────────────────────────────────

/**
 * Dispatch an incoming ArrayBuffer to the correct unpack function.
 * Returns { typeId, payload } where payload shape depends on typeId.
 */
export function unpack(buf) {
  const typeId = new DataView(buf).getUint8(0);
  switch (typeId) {
    case TYPE.SHIP_STATE:       return { typeId, payload: unpackShipState(buf) };
    case TYPE.AI_STATE:         return { typeId, payload: unpackAIState(buf) };
    case TYPE.CANNON_FIRE:      return { typeId, payload: unpackCannonFire(buf) };
    case TYPE.DAMAGE_EVENT:
    case TYPE.DMG_REQUEST:      return { typeId, payload: unpackDamage(buf) };
    case TYPE.WORLD_LAYOUT_ACK: return { typeId, payload: null };
    case TYPE.JSON_ENVELOPE:    return { typeId, payload: unpackJSON(buf) };
    default:
      console.warn('[NetPacker] Unknown typeId:', typeId);
      return { typeId, payload: null };
  }
}
