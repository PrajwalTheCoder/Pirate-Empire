/**
 * NetPacker — Binary serialization for Pirate Empire multiplayer packets.
 *
 * Replaces JSON.stringify / JSON.parse with compact ArrayBuffer encoding.
 * Protocol version: 3 (Authoritative snapshots, sequence ordering, ping/pong RTT, event deduplication)
 *
 * Message type IDs:
 *   0x01  SHIP_STATE       — own ship position/velocity/sequence (20 Hz, 25 bytes)
 *   0x02  AI_STATE         — array of enemy ship states (10 Hz)
 *   0x03  CANNON_FIRE      — cannonball spawn event (26 bytes)
 *   0x04  DAMAGE_EVENT     — authoritative damage commit (host → clients, 20 bytes)
 *   0x05  DMG_REQUEST      — client hit request (client → host, 14 bytes)
 *   0x06  WORLD_LAYOUT_ACK — client ACKs world layout receipt (1 byte)
 *   0x07  PING             — monotonic clock latency probe (13 bytes)
 *   0x08  PONG             — latency probe response (17 bytes)
 *   0x09  SHIP_DESTROYED   — authoritative destruction event (18 bytes)
 *   0x0A  SHIP_RESPAWNED   — authoritative respawn event (23 bytes)
 *   0xFF  JSON_ENVELOPE    — fallback for infrequent/complex messages
 */

// ── Type IDs ──────────────────────────────────────────────────────────────────
export const TYPE = Object.freeze({
  SHIP_STATE:       0x01,
  AI_STATE:         0x02,
  CANNON_FIRE:      0x03,
  DAMAGE_EVENT:     0x04,
  DMG_REQUEST:      0x05,
  WORLD_LAYOUT_ACK: 0x06,
  PING:             0x07,
  PONG:             0x08,
  SHIP_DESTROYED:   0x09,
  SHIP_RESPAWNED:   0x0A,
  JSON_ENVELOPE:    0xFF,
});

// ── Protocol version ──────────────────────────────────────────────────────────
export const PROTOCOL_VERSION = 3;

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

/** FNV-1a 32-bit hash — maps string to uint32. */
export function fnv32(str) {
  if (!str) return 0;
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Map match/session code string to 16-bit integer hash */
export function hashMatchId(matchId) {
  if (!matchId) return 0;
  return fnv32(String(matchId)) & 0xFFFF;
}

// ── SHIP STATE (v3: 25 bytes | v2 legacy: 16 bytes) ───────────────────────────
//  Byte 0:     type = 0x01
//  Bytes 1–2:  matchIdHash (uint16)
//  Bytes 3–4:  seq (uint16, 0..65535)
//  Bytes 5–8:  tick / timestamp (uint32)
//  Byte 9:     generation (uint8)
//  Bytes 10–11: x (int16, ×10)
//  Bytes 12–13: y (int16, ×10)
//  Bytes 14–15: z (int16, ×10)
//  Byte 16:    rotY (uint8, 0–255 = 0–2π)
//  Byte 17:    vx (int8, ×10)
//  Byte 18:    vz (int8, ×10)
//  Bytes 19–20: health (uint16)
//  Bytes 21–22: maxHealth (uint16)
//  Byte 23:    thrust (uint8, 0–200 offset 100)
//  Byte 24:    shipState (uint8: 0=SAILING, 1=SINKING, 2=SUNK)

export function packShipState(ship, seq = 0, tick = 0, matchId = '', generation = 1) {
  const buf = new ArrayBuffer(25);
  const v   = new DataView(buf);
  const p   = ship.group ? ship.group.position : (ship.position || { x: 0, y: 1, z: 0 });
  const vel = ship.velocity || { x: 0, z: 0 };
  const rotY = ship.group ? ship.group.rotation.y : (ship.ry ?? ship.rotY ?? 0);

  const mHash = typeof matchId === 'number' ? (matchId & 0xFFFF) : hashMatchId(matchId);
  const gen   = Math.max(1, Math.min(255, generation || ship.lifecycleGen || 1));
  const sSeq  = (seq || ship._netSeq || 0) & 0xFFFF;
  const sTick = (tick || ship._netTick || 0) >>> 0;

  const stateByte = ship.state === 'SUNK' ? 2 : (ship.state === 'SINKING' ? 1 : 0);

  v.setUint8 (0,  TYPE.SHIP_STATE);
  v.setUint16(1,  mHash, false);
  v.setUint16(3,  sSeq, false);
  v.setUint32(5,  sTick, false);
  v.setUint8 (9,  gen);
  v.setInt16 (10, Math.round(clamp(p.x, -3276, 3276) * 10), false);
  v.setInt16 (12, Math.round(clamp(p.y ?? 1.0, -3276, 3276) * 10), false);
  v.setInt16 (14, Math.round(clamp(p.z, -3276, 3276) * 10), false);
  v.setUint8 (16, encodeAngle(rotY));
  v.setInt8  (17, Math.round(clamp(vel.x ?? 0, -12.7, 12.7) * 10));
  v.setInt8  (18, Math.round(clamp(vel.z ?? 0, -12.7, 12.7) * 10));
  v.setUint16(19, Math.round(clamp(ship.health ?? 100, 0, 65535)), false);
  v.setUint16(21, Math.round(clamp(ship.maxHealth ?? 100, 0, 65535)), false);
  v.setUint8 (23, Math.round(clamp((ship.thrust ?? 0) * 100 + 100, 0, 200)));
  v.setUint8 (24, stateByte);
  return buf;
}

export function unpackShipState(buf) {
  const v = new DataView(buf);
  // v3 protocol (25 bytes)
  if (buf.byteLength >= 25) {
    const stateByte = v.getUint8(24);
    const shipStateStr = stateByte === 2 ? 'SUNK' : (stateByte === 1 ? 'SINKING' : 'SAILING');
    return {
      matchIdHash: v.getUint16(1, false),
      seq:         v.getUint16(3, false),
      tick:        v.getUint32(5, false),
      generation:  v.getUint8(9),
      x:           v.getInt16(10, false) / 10,
      y:           v.getInt16(12, false) / 10,
      z:           v.getInt16(14, false) / 10,
      ry:          decodeAngle(v.getUint8(16)),
      rotY:        decodeAngle(v.getUint8(16)),
      vx:          v.getInt8(17) / 10,
      vz:          v.getInt8(18) / 10,
      hp:          v.getUint16(19, false),
      mhp:         v.getUint16(21, false),
      thx:         (v.getUint8(23) - 100) / 100,
      shipState:   shipStateStr,
      flags:       stateByte,
    };
  }

  // Legacy fallback (v2: 16 bytes)
  return {
    matchIdHash: 0,
    seq:         0,
    tick:        0,
    generation:  1,
    x:           v.getInt16(1, false) / 10,
    y:           v.getInt16(3, false) / 10,
    z:           v.getInt16(5, false) / 10,
    ry:          decodeAngle(v.getUint8(7)),
    rotY:        decodeAngle(v.getUint8(7)),
    vx:          v.getInt8(8) / 10,
    vz:          v.getInt8(9) / 10,
    hp:          v.getUint16(10, false),
    mhp:         v.getUint16(12, false),
    thx:         (v.getUint8(14) - 100) / 100,
    shipState:   'SAILING',
    flags:       0,
  };
}

// ── AI STATE (6-byte header + N × 12 bytes per ship) ─────────────────────────
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

const _hashToId = new Map();
const _idToHash = new Map();

export function registerShipId(id) {
  const h = fnv32(id);
  _hashToId.set(h, id);
  _idToHash.set(id, h);
  return h;
}

export function registerShipIdWithHash(id, hash) {
  const h = hash >>> 0;
  _hashToId.set(h, id);
  _idToHash.set(id, h);
}

export function resolveShipId(hash) {
  return _hashToId.get(hash >>> 0) ?? null;
}

export function getShipHash(id) {
  if (typeof id === 'number') return id >>> 0;
  if (_idToHash.has(id)) return _idToHash.get(id);
  if (typeof id === 'string' && id.startsWith('ghost_')) {
    const parsed = parseInt(id.slice(6), 16);
    if (!isNaN(parsed)) return parsed >>> 0;
  }
  return fnv32(String(id));
}

export function packAIState(stateArray, tick = 0) {
  const count = Math.min(stateArray.length, 255);
  const buf = new ArrayBuffer(6 + count * 12);
  const v   = new DataView(buf);
  const ts  = tick || ((performance.now() * 1) | 0);

  v.setUint8 (0, TYPE.AI_STATE);
  v.setUint32(1, ts >>> 0, false);
  v.setUint8 (5, count);

  let offset = 6;
  for (let i = 0; i < count; i++) {
    const s = stateArray[i];
    const hash = registerShipId(s.id);
    const clsI = CLASS_IDX[s.cls] ?? 4;
    const facI = FACTION_IDX[s.fac] ?? 1;

    v.setUint32(offset,     hash >>> 0, false);
    v.setInt16 (offset + 4, Math.round(clamp(s.x, -3276, 3276) * 10), false);
    v.setInt16 (offset + 6, Math.round(clamp(s.z, -3276, 3276) * 10), false);
    v.setUint8 (offset + 8, encodeAngle(s.ry));
    v.setUint16(offset + 9, Math.round(clamp(s.hp, 0, 65535)), false);
    v.setUint8 (offset + 11, ((clsI & 0xF) << 4) | (facI & 0xF));
    offset += 12;
  }
  return buf;
}

export function unpackAIState(buf) {
  const v     = new DataView(buf);
  const ts    = v.getUint32(1, false);
  const count = v.getUint8(5);
  const ships = [];

  let offset = 6;
  for (let i = 0; i < count; i++) {
    const hash  = v.getUint32(offset, false);
    let id      = resolveShipId(hash);
    if (!id) {
      id = `ghost_${hash.toString(16)}`;
      registerShipIdWithHash(id, hash);
    }
    const x     = v.getInt16(offset + 4, false) / 10;
    const z     = v.getInt16(offset + 6, false) / 10;
    const ry    = decodeAngle(v.getUint8(offset + 8));
    const hp    = v.getUint16(offset + 9, false);
    const flags = v.getUint8(offset + 11);
    const cls   = IDX_CLASS[(flags >> 4) & 0xF] ?? 'PIRATE_SMALL';
    const fac   = IDX_FACTION[flags & 0xF] ?? 'PIRATE';
    ships.push({ id, cls, fac, x, z, ry, hp, mhp: hp, netHash: hash });
    offset += 12;
  }
  return { ts, ships };
}

// ── CANNON FIRE (26 bytes) ────────────────────────────────────────────────────
const AMMO_BYTE = { ROUND: 0, CHAIN: 1, FIRE: 2, CURSED_SPECTRAL: 3 };
const BYTE_AMMO = Object.fromEntries(Object.entries(AMMO_BYTE).map(([k,v]) => [v,k]));

export function packCannonFire(posL, velL, posR, velR, ammo) {
  const buf = new ArrayBuffer(26);
  const v   = new DataView(buf);

  const writeVec3Int16 = (offset, vec) => {
    v.setInt16(offset,     Math.round(clamp(vec.x ?? 0, -3276, 3276) * 10), false);
    v.setInt16(offset + 2, Math.round(clamp(vec.y ?? 0, -3276, 3276) * 10), false);
    v.setInt16(offset + 4, Math.round(clamp(vec.z ?? 0, -3276, 3276) * 10), false);
  };

  v.setUint8(0, TYPE.CANNON_FIRE);
  writeVec3Int16(1,  posL || {});
  writeVec3Int16(7,  velL || {});
  writeVec3Int16(13, posR || {});
  writeVec3Int16(19, velR || {});
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
  const ammo = BYTE_AMMO[v.getUint8(25)] ?? 'ROUND';
  return {
    pL: readVec3(1),  vL: readVec3(7),
    pR: readVec3(13), vR: readVec3(19),
    a:  ammo,
    ammo: ammo,
  };
}

// ── DAMAGE EVENT (v3: 20 bytes | legacy: 7 bytes) ─────────────────────────────
//  Byte 0:     type = 0x04
//  Bytes 1–4:  eventId (uint32) — unique commit sequence for deduplication
//  Bytes 5–8:  shipIdHash (uint32)
//  Bytes 9–10: damageDealt (uint16)
//  Bytes 11–12: remainingHp (uint16)
//  Byte 13:    flags (bit 0 = isKill, bit 1 = isCrit)
//  Bytes 14–15: matchIdHash (uint16)
//  Bytes 16–19: authoritativeTick (uint32)

export function packDamageEvent(shipId, damage, remainingHp = 0, isKill = false, isCrit = false, eventId = 0, matchId = '', tick = 0) {
  const buf = new ArrayBuffer(20);
  const v   = new DataView(buf);
  const mHash = typeof matchId === 'number' ? (matchId & 0xFFFF) : hashMatchId(matchId);
  let flags = 0;
  if (isKill) flags |= 0x01;
  if (isCrit) flags |= 0x02;

  v.setUint8 (0,  TYPE.DAMAGE_EVENT);
  v.setUint32(1,  eventId >>> 0, false);
  v.setUint32(5,  getShipHash(shipId) >>> 0, false);
  v.setUint16(9,  Math.round(clamp(damage, 0, 65535)), false);
  v.setUint16(11, Math.round(clamp(remainingHp, 0, 65535)), false);
  v.setUint8 (13, flags);
  v.setUint16(14, mHash, false);
  v.setUint32(16, tick >>> 0, false);
  return buf;
}

export function unpackDamage(buf) {
  const v = new DataView(buf);
  // v3 protocol (20 bytes)
  if (buf.byteLength >= 20) {
    const eventId   = v.getUint32(1, false);
    const hash      = v.getUint32(5, false);
    const dmg       = v.getUint16(9, false);
    const remainingHp = v.getUint16(11, false);
    const flags     = v.getUint8(13);
    const isKill    = (flags & 0x01) !== 0;
    const isCrit    = (flags & 0x02) !== 0;
    const matchIdHash = v.getUint16(14, false);
    const tick      = v.getUint32(16, false);

    return {
      eventId,
      id: resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
      hash: hash >>> 0,
      dmg,
      remainingHp,
      isKill,
      isCrit,
      matchIdHash,
      tick,
    };
  }

  // Legacy fallback (7 bytes)
  const hash = v.getUint32(1, false);
  return {
    eventId: 0,
    id: resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
    hash: hash >>> 0,
    dmg: v.getUint16(5, false),
    remainingHp: 0,
    isKill: false,
    isCrit: false,
    matchIdHash: 0,
    tick: 0,
  };
}

// ── DMG REQUEST (v3: 14 bytes | legacy: 7 bytes) ──────────────────────────────
//  Byte 0:     type = 0x05
//  Bytes 1–4:  requestId (uint32)
//  Bytes 5–8:  shipIdHash (uint32)
//  Bytes 9–10: rawDamage (uint16)
//  Bytes 11–12: matchIdHash (uint16)
//  Byte 13:    ammoType (uint8)

export function packDamageRequest(shipId, damage, requestId = 0, matchId = '', ammo = 'ROUND') {
  const buf = new ArrayBuffer(14);
  const v   = new DataView(buf);
  const mHash = typeof matchId === 'number' ? (matchId & 0xFFFF) : hashMatchId(matchId);

  v.setUint8 (0,  TYPE.DMG_REQUEST);
  v.setUint32(1,  requestId >>> 0, false);
  v.setUint32(5,  getShipHash(shipId) >>> 0, false);
  v.setUint16(9,  Math.round(clamp(damage, 0, 65535)), false);
  v.setUint16(11, mHash, false);
  v.setUint8 (13, AMMO_BYTE[ammo] ?? 0);
  return buf;
}

export function unpackDamageRequest(buf) {
  const v = new DataView(buf);
  if (buf.byteLength >= 14) {
    const requestId   = v.getUint32(1, false);
    const hash        = v.getUint32(5, false);
    const dmg         = v.getUint16(9, false);
    const matchIdHash = v.getUint16(11, false);
    const ammoByte    = v.getUint8(13);
    return {
      requestId,
      id: resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
      hash: hash >>> 0,
      dmg,
      matchIdHash,
      ammo: BYTE_AMMO[ammoByte] ?? 'ROUND',
    };
  }

  const hash = v.getUint32(1, false);
  return {
    requestId: 0,
    id: resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
    hash: hash >>> 0,
    dmg: v.getUint16(5, false),
    matchIdHash: 0,
    ammo: 'ROUND',
  };
}

// ── PING / PONG (13 bytes / 17 bytes) ─────────────────────────────────────────
export function packPing(pingId, clientSendTime) {
  const buf = new ArrayBuffer(13);
  const v   = new DataView(buf);
  v.setUint8  (0, TYPE.PING);
  v.setUint32 (1, pingId >>> 0, false);
  v.setFloat64(5, clientSendTime, false);
  return buf;
}

export function unpackPing(buf) {
  const v = new DataView(buf);
  return {
    pingId:   v.getUint32(1, false),
    sendTime: v.getFloat64(5, false),
  };
}

export function packPong(pingId, clientSendTime, receiverTick = 0) {
  const buf = new ArrayBuffer(17);
  const v   = new DataView(buf);
  v.setUint8  (0,  TYPE.PONG);
  v.setUint32 (1,  pingId >>> 0, false);
  v.setFloat64(5,  clientSendTime, false);
  v.setUint32 (13, receiverTick >>> 0, false);
  return buf;
}

export function unpackPong(buf) {
  const v = new DataView(buf);
  return {
    pingId:       v.getUint32(1, false),
    sendTime:     v.getFloat64(5, false),
    receiverTick: v.getUint32(13, false),
  };
}

// ── SHIP DESTROYED (18 bytes) ─────────────────────────────────────────────────
//  Byte 0:     type = 0x09
//  Bytes 1–4:  eventId (uint32)
//  Bytes 5–8:  shipIdHash (uint32)
//  Byte 9:     lifecycleGen (uint8)
//  Bytes 10–13: tick (uint32)
//  Bytes 14–15: respawnDeadlineSecX10 (uint16)
//  Bytes 16–17: matchIdHash (uint16)

export function packShipDestroyed(shipId, lifecycleGen, respawnSec = 8.0, eventId = 0, matchId = '', tick = 0) {
  const buf = new ArrayBuffer(18);
  const v   = new DataView(buf);
  const mHash = typeof matchId === 'number' ? (matchId & 0xFFFF) : hashMatchId(matchId);

  v.setUint8 (0,  TYPE.SHIP_DESTROYED);
  v.setUint32(1,  eventId >>> 0, false);
  v.setUint32(5,  getShipHash(shipId) >>> 0, false);
  v.setUint8 (9,  (lifecycleGen || 1) & 0xFF);
  v.setUint32(10, tick >>> 0, false);
  v.setUint16(14, Math.round(clamp(respawnSec * 10, 0, 65535)), false);
  v.setUint16(16, mHash, false);
  return buf;
}

export function unpackShipDestroyed(buf) {
  const v = new DataView(buf);
  const hash = v.getUint32(5, false);
  return {
    eventId:         v.getUint32(1, false),
    id:              resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
    hash:            hash >>> 0,
    lifecycleGen:    v.getUint8(9),
    tick:            v.getUint32(10, false),
    respawnDeadline: v.getUint16(14, false) / 10,
    respawnSec:      v.getUint16(14, false) / 10,
    matchIdHash:     v.getUint16(16, false),
  };
}

// ── SHIP RESPAWNED (23 bytes) ─────────────────────────────────────────────────
//  Byte 0:     type = 0x0A
//  Bytes 1–4:  eventId (uint32)
//  Bytes 5–8:  shipIdHash (uint32)
//  Byte 9:     newLifecycleGen (uint8)
//  Bytes 10–11: spawnX (int16, ×10)
//  Bytes 12–13: spawnZ (int16, ×10)
//  Byte 14:    spawnRy (uint8)
//  Bytes 15–16: health (uint16)
//  Bytes 17–18: matchIdHash (uint16)
//  Bytes 19–22: tick (uint32)

export function packShipRespawned(shipId, newLifecycleGen, spawnX, spawnZ, spawnRy = 0, health = 100, eventId = 0, matchId = '', tick = 0) {
  const buf = new ArrayBuffer(23);
  const v   = new DataView(buf);
  const mHash = typeof matchId === 'number' ? (matchId & 0xFFFF) : hashMatchId(matchId);

  v.setUint8 (0,  TYPE.SHIP_RESPAWNED);
  v.setUint32(1,  eventId >>> 0, false);
  v.setUint32(5,  getShipHash(shipId) >>> 0, false);
  v.setUint8 (9,  (newLifecycleGen || 1) & 0xFF);
  v.setInt16 (10, Math.round(clamp(spawnX, -3276, 3276) * 10), false);
  v.setInt16 (12, Math.round(clamp(spawnZ, -3276, 3276) * 10), false);
  v.setUint8 (14, encodeAngle(spawnRy));
  v.setUint16(15, Math.round(clamp(health, 0, 65535)), false);
  v.setUint16(17, mHash, false);
  v.setUint32(19, tick >>> 0, false);
  return buf;
}

export function unpackShipRespawned(buf) {
  const v = new DataView(buf);
  const hash = v.getUint32(5, false);
  return {
    eventId:      v.getUint32(1, false),
    id:           resolveShipId(hash) ?? `ghost_${hash.toString(16)}`,
    hash:         hash >>> 0,
    lifecycleGen: v.getUint8(9),
    spawnX:       v.getInt16(10, false) / 10,
    spawnZ:       v.getInt16(12, false) / 10,
    spawnRy:      decodeAngle(v.getUint8(14)),
    health:       v.getUint16(15, false),
    matchIdHash:  v.getUint16(17, false),
    tick:         v.getUint32(19, false),
  };
}

// ── WORLD LAYOUT ACK (1 byte) ─────────────────────────────────────────────────
export function packWorldLayoutAck() {
  const buf = new ArrayBuffer(1);
  new DataView(buf).setUint8(0, TYPE.WORLD_LAYOUT_ACK);
  return buf;
}

// ── JSON ENVELOPE (fallback for complex messages) ─────────────────────────────
const _enc = new TextEncoder();
const _dec = new TextDecoder();

export function packJSON(msgType, data) {
  const json  = JSON.stringify({ t: msgType, d: data });
  const bytes = _enc.encode(json);
  const buf   = new ArrayBuffer(1 + bytes.byteLength);
  new DataView(buf).setUint8(0, TYPE.JSON_ENVELOPE);
  new Uint8Array(buf, 1).set(bytes);
  return buf;
}

export function unpackJSON(buf) {
  const text = _dec.decode(new Uint8Array(buf, 1));
  return JSON.parse(text);
}

// ── Top-level dispatcher ──────────────────────────────────────────────────────
export function unpack(buf) {
  const typeId = new DataView(buf).getUint8(0);
  switch (typeId) {
    case TYPE.SHIP_STATE:       return { typeId, payload: unpackShipState(buf) };
    case TYPE.AI_STATE:         return { typeId, payload: unpackAIState(buf) };
    case TYPE.CANNON_FIRE:      return { typeId, payload: unpackCannonFire(buf) };
    case TYPE.DAMAGE_EVENT:     return { typeId, payload: unpackDamage(buf) };
    case TYPE.DMG_REQUEST:      return { typeId, payload: unpackDamageRequest(buf) };
    case TYPE.WORLD_LAYOUT_ACK: return { typeId, payload: null };
    case TYPE.PING:             return { typeId, payload: unpackPing(buf) };
    case TYPE.PONG:             return { typeId, payload: unpackPong(buf) };
    case TYPE.SHIP_DESTROYED:   return { typeId, payload: unpackShipDestroyed(buf) };
    case TYPE.SHIP_RESPAWNED:   return { typeId, payload: unpackShipRespawned(buf) };
    case TYPE.JSON_ENVELOPE:    return { typeId, payload: unpackJSON(buf) };
    default:
      console.warn('[NetPacker] Unknown typeId:', typeId);
      return { typeId, payload: null };
  }
}

export const NetPacker = {
  PROTOCOL_VERSION,
  TYPE,
  getShipHash,
  hashMatchId,
  packShipState,
  unpackShipState,
  packAIState,
  unpackAIState,
  packCannonFire,
  unpackCannonFire,
  packDamageEvent,
  unpackDamage,
  packDamageRequest,
  unpackDamageRequest,
  packPing,
  unpackPing,
  packPong,
  unpackPong,
  packShipDestroyed,
  unpackShipDestroyed,
  packShipRespawned,
  unpackShipRespawned,
  packWorldLayoutAck,
  packJSON,
  unpackJSON,
  unpack,
};

export default NetPacker;
