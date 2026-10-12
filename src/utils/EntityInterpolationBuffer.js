/**
 * EntityInterpolationBuffer — Bounded snapshot interpolation buffer for remote ships.
 *
 * Implements client-side snapshot interpolation (Hermite/Linear with shortest-path angle wrapping),
 * bounded extrapolation on packet loss, and robust rejection of out-of-order, stale, or wrong-match packets.
 *
 * Requirements:
 * - Reject packets from wrong match or older sequence numbers.
 * - Reject stale packets from a previous lifecycle generation after respawn.
 * - Never interpolate across death, sinking, or respawn events.
 * - Smooth position & rotation rendering slightly behind authoritative host time.
 * - Controlled teleport correction when error exceeds threshold.
 */

export class EntityInterpolationBuffer {
  /**
   * @param {object} [options]
   * @param {number} [options.baseDelayMs=70]       — Baseline interpolation buffer delay
   * @param {number} [options.maxExtrapolationSec=0.20] — Bounded extrapolation ceiling (200ms)
   * @param {number} [options.teleportThreshold=35.0]   — Distance threshold to snap instead of lerp
   * @param {number} [options.maxBufferSize=30]        — Maximum snapshot capacity
   */
  constructor(options = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 70;
    this.maxExtrapolationSec = options.maxExtrapolationSec ?? 0.20;
    this.teleportThreshold = options.teleportThreshold ?? 35.0;
    this.maxBufferSize = options.maxBufferSize ?? 30;

    /** @type {Array<object>} Ring buffer of accepted snapshots */
    this.snapshots = [];

    this.currentMatchIdHash = 0;
    this.currentGeneration = 1;
    this.latestAcceptedSeq = 0;
    this.latestAcceptedTick = 0;
    this.hasReceivedFirst = false;

    // Diagnostics counters
    this.staleRejectedCount = 0;
    this.sequenceGaps = 0;
    this.missedUpdates = 0;
    this.lastExtrapolating = false;
    this.lastExtrapolationConfidence = 1.0;

    // Dynamic jitter compensation
    this.measuredJitterMs = 0;
  }

  setMatchIdHash(hash) {
    this.currentMatchIdHash = hash;
  }

  setMeasuredJitter(jitterMs) {
    this.measuredJitterMs = Math.max(0, jitterMs || 0);
  }

  /**
   * Compute dynamic interpolation delay: base delay + jitter margin.
   * Clamped to [50ms, 180ms].
   */
  getInterpolationDelayMs() {
    const dynamic = this.baseDelayMs + this.measuredJitterMs * 1.25;
    return Math.min(180, Math.max(50, dynamic));
  }

  getRenderDelayMs() {
    return this.getInterpolationDelayMs();
  }

  get rejectedStaleCount() {
    return this.staleRejectedCount;
  }

  get rejectedWrongMatchCount() {
    return this.staleRejectedCount;
  }

  get expectedGeneration() {
    return this.currentGeneration;
  }

  setAuthoritativeLifecycle(gen) {
    this.currentGeneration = gen;
    this.latestAcceptedSeq = 0;
    this.hasReceivedFirst = false;
    this.snapshots.length = 0;
  }

  /**
   * Push an authoritative snapshot.
   * Returns true if accepted, false if rejected.
   *
   * @param {object} s
   * @param {number} s.seq         — 16-bit sequence number (0..65535)
   * @param {number} [s.tick]      — authoritative simulation tick
   * @param {number} [s.generation]— ship lifecycle generation
   * @param {number} [s.matchIdHash] — match ID hash
   * @param {number} s.x
   * @param {number} s.y
   * @param {number} s.z
   * @param {number} s.ry        — rotation Y in radians
   * @param {number} s.vx
   * @param {number} s.vz
   * @param {number} s.hp
   * @param {number} s.mhp
   * @param {number} [s.shipState] — 0=SAILING, 1=SINKING, 2=SUNK
   */
  pushSnapshot(s) {
    if (!s) return false;

    // 1. Match validation
    if (this.currentMatchIdHash !== 0 && s.matchIdHash !== undefined && s.matchIdHash !== 0) {
      if (s.matchIdHash !== this.currentMatchIdHash) {
        this.staleRejectedCount++;
        return false;
      }
    }

    const gen = s.generation ?? 1;

    // 2. Lifecycle generation check
    if (gen < this.currentGeneration) {
      // Stale packet from before respawn — reject
      this.staleRejectedCount++;
      return false;
    } else if (gen > this.currentGeneration) {
      // Ship has respawned! Flush old history so we don't interpolate across lifecycles
      this.currentGeneration = gen;
      this.snapshots.length = 0;
      this.latestAcceptedSeq = s.seq ?? 0;
      this.latestAcceptedTick = s.tick ?? 0;
      this.hasReceivedFirst = false;
    }

    // 3. Sequence number ordering check (16-bit sequence with wrap-around)
    if (this.hasReceivedFirst && s.seq !== undefined) {
      const diff = (s.seq - this.latestAcceptedSeq + 65536) % 65536;
      if (diff > 32768) {
        // Older sequence number received out-of-order — reject
        this.staleRejectedCount++;
        return false;
      }
      if (diff > 1) {
        this.sequenceGaps++;
        this.missedUpdates += (diff - 1);
      }
      this.latestAcceptedSeq = s.seq;
    } else if (s.seq !== undefined) {
      this.latestAcceptedSeq = s.seq;
      this.hasReceivedFirst = true;
    }

    if (s.tick !== undefined && s.tick > this.latestAcceptedTick) {
      this.latestAcceptedTick = s.tick;
    }

    const snapshot = {
      seq: s.seq ?? this.latestAcceptedSeq,
      tick: s.tick ?? this.latestAcceptedTick,
      generation: gen,
      matchIdHash: s.matchIdHash ?? this.currentMatchIdHash,
      x: s.x,
      y: s.y ?? 1.0,
      z: s.z,
      ry: s.ry ?? s.rotY ?? 0,
      rotY: s.rotY ?? s.ry ?? 0,
      vx: s.vx ?? 0,
      vz: s.vz ?? 0,
      hp: s.hp ?? 100,
      mhp: s.mhp ?? 100,
      thrust: s.thx ?? s.thrust ?? 0,
      shipState: s.shipState ?? 0,
      receiveTime: s.receiveTime ?? s.timestamp ?? performance.now(),
    };

    this.snapshots.push(snapshot);

    // Keep sorted by receiveTime
    this.snapshots.sort((a, b) => a.receiveTime - b.receiveTime);

    // Bound buffer size
    while (this.snapshots.length > this.maxBufferSize) {
      this.snapshots.shift();
    }

    return true;
  }

  /**
   * Sample the buffer at the given monotonic time.
   * @param {number} [nowTime] — performance.now()
   * @param {boolean} [isRenderTime=false] — if true, nowTime is treated as the direct renderTime
   * @returns {object|null} Interpolated transform & state
   */
  sample(nowTime = performance.now(), isRenderTime = false) {
    if (this.snapshots.length === 0) return null;

    const renderTime = isRenderTime ? nowTime : (nowTime - this.getInterpolationDelayMs());
    const newest = this.snapshots[this.snapshots.length - 1];
    const oldest = this.snapshots[0];

    // Single snapshot in buffer: allow bounded extrapolation if moving into future, else return as-is
    if (this.snapshots.length === 1) {
      if (!(renderTime > newest.receiveTime && (newest.vx !== 0 || newest.vz !== 0))) {
        this.lastExtrapolating = false;
        this.lastExtrapolationConfidence = 1.0;
        return {
          x: newest.x,
          y: newest.y,
          z: newest.z,
          ry: newest.ry,
          rotY: newest.ry,
          vx: newest.vx,
          vz: newest.vz,
          hp: newest.hp,
          mhp: newest.mhp,
          thrust: newest.thrust,
          shipState: newest.shipState,
          isExtrapolating: false,
          confidence: 1.0,
        };
      }
    }

    // Render time is before our oldest available snapshot: snap to oldest
    if (renderTime <= oldest.receiveTime) {
      this.lastExtrapolating = false;
      this.lastExtrapolationConfidence = 1.0;
      return {
        x: oldest.x,
        y: oldest.y,
        z: oldest.z,
        ry: oldest.ry,
        rotY: oldest.ry,
        vx: oldest.vx,
        vz: oldest.vz,
        hp: oldest.hp,
        mhp: oldest.mhp,
        thrust: oldest.thrust,
        shipState: oldest.shipState,
        isExtrapolating: false,
        confidence: 1.0,
      };
    }

    // Normal interpolation: find the two snapshots straddling renderTime
    if (renderTime <= newest.receiveTime) {
      let prev = oldest;
      let next = newest;

      for (let i = 0; i < this.snapshots.length; i++) {
        const s = this.snapshots[i];
        if (s.receiveTime <= renderTime) {
          prev = s;
        } else {
          next = s;
          break;
        }
      }

      const span = next.receiveTime - prev.receiveTime;
      const alpha = span > 0 ? Math.min(1.0, Math.max(0.0, (renderTime - prev.receiveTime) / span)) : 1.0;

      // Position linear interpolation
      const x = prev.x + (next.x - prev.x) * alpha;
      const y = prev.y + (next.y - prev.y) * alpha;
      const z = prev.z + (next.z - prev.z) * alpha;

      // Shortest-path rotation interpolation
      let da = next.ry - prev.ry;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const ry = prev.ry + da * alpha;

      const vx = prev.vx + (next.vx - prev.vx) * alpha;
      const vz = prev.vz + (next.vz - prev.vz) * alpha;

      this.lastExtrapolating = false;
      this.lastExtrapolationConfidence = 1.0;

      return {
        x, y, z, ry, rotY: ry, vx, vz,
        hp: next.hp,
        mhp: next.mhp,
        thrust: next.thrust,
        shipState: next.shipState,
        isExtrapolating: false,
        confidence: 1.0,
      };
    }

    // Packet delayed or missing: bounded dead-reckoning extrapolation
    const extraTimeSec = (renderTime - newest.receiveTime) / 1000.0;
    this.lastExtrapolating = true;

    if (extraTimeSec <= this.maxExtrapolationSec) {
      // Linear extrapolation with speed degradation
      const decay = Math.max(0, 1.0 - (extraTimeSec / this.maxExtrapolationSec));
      this.lastExtrapolationConfidence = decay;

      return {
        x: newest.x + newest.vx * extraTimeSec * decay,
        y: newest.y,
        z: newest.z + newest.vz * extraTimeSec * decay,
        ry: newest.ry,
        rotY: newest.ry,
        vx: newest.vx * decay,
        vz: newest.vz * decay,
        hp: newest.hp,
        mhp: newest.mhp,
        thrust: newest.thrust,
        shipState: newest.shipState,
        isExtrapolating: true,
        confidence: decay,
      };
    }

    // Beyond max extrapolation time: zero confidence, freeze at last valid position
    this.lastExtrapolationConfidence = 0.0;
    return {
      x: newest.x,
      y: newest.y,
      z: newest.z,
      ry: newest.ry,
      rotY: newest.ry,
      vx: 0,
      vz: 0,
      hp: newest.hp,
      mhp: newest.mhp,
      thrust: 0,
      shipState: newest.shipState,
      isExtrapolating: true,
      confidence: 0.0,
    };
  }

  /**
   * Apply interpolated state smoothly onto a Three.js Ship instance.
   *
   * @param {import('../systems/ShipSystem.js').Ship} ship
   * @param {number} [nowTime]
   * @returns {boolean} true if applied, false if ship is sinking/sunk or buffer empty
   */
  applyToShip(ship, nowTime = performance.now()) {
    if (!ship || !ship.group) return false;

    // Do NOT overwrite sinking or sunk ships with movement interpolation
    if (ship.state === 'SINKING' || ship.state === 'SUNK') {
      return false;
    }

    const s = this.sample(nowTime);
    if (!s) return false;

    // Check for large positional error -> teleport correction
    const curX = ship.group.position.x;
    const curZ = ship.group.position.z;
    const distSq = (s.x - curX) ** 2 + (s.z - curZ) ** 2;

    if (distSq > (this.teleportThreshold * this.teleportThreshold)) {
      // Immediate teleport correction
      ship.group.position.x = s.x;
      ship.group.position.y = s.y;
      ship.group.position.z = s.z;
      ship.group.rotation.y = s.ry;
    } else {
      // Smooth position assignment (driven by interpolation buffer)
      ship.group.position.x = s.x;
      ship.group.position.y = s.y;
      ship.group.position.z = s.z;

      // Smooth rotation with wrap-around
      let da = s.ry - ship.group.rotation.y;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      ship.group.rotation.y += da * 0.45;
    }

    if (ship.velocity) {
      if (typeof ship.velocity.set === 'function') {
        ship.velocity.set(s.vx, 0, s.vz);
      } else {
        ship.velocity.x = s.vx;
        ship.velocity.z = s.vz;
      }
    }
    ship.health = s.hp;
    ship.maxHealth = s.mhp;

    // Trigger sinking if authoritative state reports health <= 0
    if (s.hp <= 0 && ship.state === 'SAILING') {
      ship.health = 0;
      ship._beginSinking?.();
    }

    // Prune very old snapshots (> 1.5s older than render window)
    const cutoff = (nowTime - this.getInterpolationDelayMs()) - 1500;
    while (this.snapshots.length > 2 && this.snapshots[0].receiveTime < cutoff) {
      this.snapshots.shift();
    }

    return true;
  }

  clear() {
    this.snapshots.length = 0;
    this.hasReceivedFirst = false;
  }
}

export default EntityInterpolationBuffer;
