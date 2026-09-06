/**
 * ShipSystem — manages all Ship entities in the world.
 *
 * Each Ship wraps a THREE.Group with:
 *   - physics-based movement (velocity + angular velocity + drag)
 *   - health + damage + sinking animation
 *   - wave bobbing via Ocean.getHeightAt()
 *   - wreck model spawned on death
 */
import * as THREE          from 'three';
import AssetLoader         from './AssetLoader.js';
import EventEmitter        from '../utils/EventEmitter.js';
import { lerp, clamp,
         randRange }       from '../utils/MathUtils.js';
import GameConfig          from '../config/GameConfig.js';
import ShipStats, { ShipClass, Faction } from '../config/ShipConfig.js';

// ─── SHIP STATES ──────────────────────────────────────────────────────────────
export const ShipState = {
  SAILING: 'SAILING',
  SINKING: 'SINKING',
  SUNK:    'SUNK',
};

// ──────────────────────────────────────────────────────────────────────────────
export class Ship {
  /**
   * @param {string}       id        — unique identifier
   * @param {string}       shipClass — from ShipClass enum
   * @param {string}       faction   — from Faction enum
   * @param {THREE.Scene}  scene
   */
  constructor(id, shipClass, faction, scene) {
    this.id        = id;
    this.shipClass = shipClass;
    this.faction   = faction;
    this.scene     = scene;

    // ── Copy base stats ─────────────────────────────────────────────────────
    const base = ShipStats[shipClass];
    this.speed       = base.speed;
    this.turnRate    = base.turnRate;
    this.maxHealth   = base.maxHealth;
    this.health      = base.maxHealth;
    this.armor       = base.armor;
    this.cannonPower = base.cannonPower;
    this.crew        = base.crew;
    this.modelKey    = base.modelKey;

    // ── Physics ─────────────────────────────────────────────────────────────
    this.velocity        = new THREE.Vector3();
    this.angularVelocity = 0;
    this.thrust          = 0;   // -1 to 1
    this.steering        = 0;   // -1 to 1

    // ── State ────────────────────────────────────────────────────────────────
    this.state       = ShipState.SAILING;
    this._sinkTimer  = 0;
    this._bobPhase   = randRange(0, Math.PI * 2);  // random offset for wave sync

    // ── Three.js group ───────────────────────────────────────────────────────
    this.group = new THREE.Group();
    this.group.name = `ship_${id}`;

    // Load model
    const model = AssetLoader.get(base.modelKey);
    model.scale.setScalar(base.scale ?? 1.0);
    this.group.add(model);
    this._model = model;

    // Add a pirate flag to player / pirate ships
    if (faction === Faction.PLAYER || faction === Faction.PIRATE) {
      const flag = AssetLoader.get('flag-pirate');
      flag.position.set(0, 4, 0);
      flag.scale.setScalar(0.8);
      this.group.add(flag);
    }

    scene.add(this.group);

    // Cannon fire cooldown tracker
    this.cannonCooldown = 0;

    // Particle arrays (damage smoke + bow spray)
    this._smokeParticles  = [];
    this._bowParticles    = [];
    this._damageSmokeTimer = 0;
    this._bowSplashTimer   = 0;

    // Drift state
    this.isDrifting = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Move ship to world position. */
  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
  }

  /** Rotate ship to face direction (radians, Y-axis). */
  setRotationY(rad) {
    this.group.rotation.y = rad;
  }

  /** Apply damage (reduced by armor). Returns actual damage dealt. */
  takeDamage(rawDamage) {
    if (this.state !== ShipState.SAILING) return 0;
    // Clamp _damageReduction to [0, 0.80] so stacking Iron Keel can't invert damage.
    const dr = Math.min(0.80, Math.max(0, this._damageReduction ?? 0));
    const reducedDamage = rawDamage * (1 - dr);
    const actual = Math.round(Math.max(1, reducedDamage - this.armor));
    this.health  = clamp(this.health - actual, 0, this.maxHealth);

    EventEmitter.emit('ship:hit', { ship: this, damage: actual });

    if (this.health <= 0) {
      this._beginSinking();
    }
    return actual;
  }

  /** Heal ship (e.g. from repairs). */
  heal(amount) {
    this.health = clamp(this.health + amount, 0, this.maxHealth);
  }

  get isAlive() { return this.state !== ShipState.SUNK; }
  get isSailing() { return this.state === ShipState.SAILING; }

  // ── Per-frame update ────────────────────────────────────────────────────────

  /**
   * @param {number} delta
   * @param {Ocean}  ocean — for wave height sampling
   * @param {number} [windAngle=0]
   * @param {number} [windStrength=1.0]
   */
  update(delta, ocean, windAngle = 0, windStrength = 1.0) {
    // Partner ghost ships are driven by network dead-reckoning — skip local physics
    if (this._isPartnerGhost) {
      // Just do wave bobbing so they look natural on the ocean surface
      if (ocean && this.state === ShipState.SAILING) {
        const px = this.group.position.x;
        const pz = this.group.position.z;
        const waveH = ocean.getHeightAt(px, pz);
        this.group.position.y = lerp(this.group.position.y, waveH + 1.0, 0.12);
        const dx = ocean.getHeightAt(px + 2, pz) - ocean.getHeightAt(px - 2, pz);
        const dz = ocean.getHeightAt(px, pz + 2) - ocean.getHeightAt(px, pz - 2);
        this.group.rotation.z = lerp(this.group.rotation.z, dx * 0.04, 0.08);
        this.group.rotation.x = lerp(this.group.rotation.x, dz * 0.04, 0.08);
      }
      this._tickSmoke(delta);
      this._tickBow(delta);
      return;
    }
    this.cannonCooldown = Math.max(0, this.cannonCooldown - delta);

    switch (this.state) {
      case ShipState.SAILING: this._updateSailing(delta, ocean, windAngle, windStrength); break;
      case ShipState.SINKING: this._updateSinking(delta);        break;
      case ShipState.SUNK:    /* nothing */                       break;
    }

    // Tick particle systems regardless of state so in-flight
    // smoke/spray finishes its animation after sinking begins
    this._tickSmoke(delta);
    this._tickBow(delta);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _updateSailing(delta, ocean, windAngle = 0, windStrength = 1.0) {
    // Apply thrust to velocity along forward direction
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.group.quaternion);

    // Drift physics multipliers
    const turnRateMult = this.isDrifting ? 1.6 : 1.0;
    const dragMult = this.isDrifting ? 0.45 : 1.0;
    const thrustMult = this.isDrifting ? 0.35 : 1.0;

    // Wind influence
    const alignment = Math.cos(this.group.rotation.y - windAngle);
    let windEffect = 1.0;
    if (alignment > 0) {
      windEffect = 1.0 + alignment * 0.35 * windStrength; // +35% tailwind boost
    } else {
      windEffect = 1.0 + alignment * 0.50 * windStrength; // -50% headwind penalty
    }

    // Apply Berserker speed boost
    const berserkerMult = this._berserkerActive ? 1.4 : 1.0;

    this.velocity.addScaledVector(forward, this.thrust * this.speed * delta * 4 * thrustMult * windEffect * berserkerMult);

    // Drag
    this.velocity.multiplyScalar(1 - 2.8 * dragMult * delta);

    // Clamp speed
    const maxV = this.speed * 1.05 * windEffect * berserkerMult;
    if (this.velocity.length() > maxV) {
      this.velocity.setLength(maxV);
    }

    // Angular velocity from steering
    this.angularVelocity += this.steering * this.turnRate * delta * 4 * turnRateMult;
    this.angularVelocity *= (1 - 4 * delta);  // angular drag

    // Integrate
    this.group.rotation.y += this.angularVelocity * delta;
    this.group.position.addScaledVector(this.velocity, delta);

    // ── Chain Shot slow debuff ────────────────────────────────────────────────
    if (this._chainSlowTimer && this._chainSlowTimer > 0) {
      this._chainSlowTimer -= delta;
      if (this._chainSlowTimer < 0) this._chainSlowTimer = 0;
      // Cap speed at 40% while slowed
      const maxSlowed = this.speed * 0.4;
      if (this.velocity.length() > maxSlowed) {
        this.velocity.setLength(maxSlowed);
      }
    }

    // ── Cursed Spectral slow debuff ──────────────────────────────────────────
    if (this._veynarSlowTimer && this._veynarSlowTimer > 0) {
      this._veynarSlowTimer -= delta;
      if (this._veynarSlowTimer < 0) this._veynarSlowTimer = 0;
      // Cap speed at 30% while slowed
      const maxSlowed = this.speed * 0.3;
      if (this.velocity.length() > maxSlowed) {
        this.velocity.setLength(maxSlowed);
      }
    }

    // ── Fire Shot burn DoT ────────────────────────────────────────────────────
    if (this._burnTimer && this._burnTimer > 0) {
      this._burnTimer -= delta;
      if (this._burnTimer < 0) { this._burnTimer = 0; this._burnDPS = 0; }
      const burnDamage = (this._burnDPS ?? 5) * delta;
      this.health = Math.max(0, this.health - burnDamage);
      if (this.health <= 0 && this.state === ShipState.SAILING) {
        this._beginSinking();
      }
    }

    // World bounds clamp — zero velocity perpendicular to wall to stop hugging
    const half = GameConfig.WORLD_SIZE / 2 - 20;
    if (this.group.position.x <= -half || this.group.position.x >= half) this.velocity.x = 0;
    if (this.group.position.z <= -half || this.group.position.z >= half) this.velocity.z = 0;
    this.group.position.x = clamp(this.group.position.x, -half, half);
    this.group.position.z = clamp(this.group.position.z, -half, half);

    // Wave bobbing — sit on ocean surface, tilt with wave gradient
    if (ocean) {
      const px = this.group.position.x;
      const pz = this.group.position.z;
      const waveH = ocean.getHeightAt(px, pz);

      // Target y = wave surface + hull-above-water offset (waves ±1.55 max, ships sit at ~y 1)
      this.group.position.y = lerp(this.group.position.y, waveH + 1.0, 0.12);

      // Sample gradient at ±2 units to get wave slope for realistic tilting
      const dx = ocean.getHeightAt(px + 2, pz) - ocean.getHeightAt(px - 2, pz);
      const dz = ocean.getHeightAt(px, pz + 2) - ocean.getHeightAt(px, pz - 2);
      this.group.rotation.z = lerp(this.group.rotation.z,  dx * 0.04, 0.08);
      this.group.rotation.x = lerp(this.group.rotation.x,
        dz * 0.04 - this.velocity.length() * 0.008, 0.08);
    }
  }

  _updateSinking(delta) {
    this._sinkTimer += delta;
    const t = this._sinkTimer / GameConfig.SINKING_DURATION;

    // ── Phase 1 (0-15%): Violent shake at the surface, stay afloat ─────────
    if (t < 0.15) {
      this._sinkShakeTimer = (this._sinkShakeTimer || 0) + delta;
      if (this._sinkShakeTimer > 0.04) {
        this._sinkShakeTimer = 0;
        const shakeAmt = 0.5 * (1 - t / 0.15);
        this.group.position.x = this._sinkBaseX + (Math.random() - 0.5) * shakeAmt;
        this.group.position.z = this._sinkBaseZ + (Math.random() - 0.5) * shakeAmt;
      }
      this.group.position.y = this._sinkStartY;

      // Heavy smoke burst during shake phase
      this._damageSmokeTimer += delta;
      if (this._damageSmokeTimer > 0.06) {
        this._damageSmokeTimer = 0;
        this._spawnSmoke();
      }

    // ── Phase 2 (15-70%): Roll to one side, begin sinking ──────────────────
    } else if (t < 0.70) {
      const sinkT = (t - 0.15) / 0.55;
      // Snap back to base position before sinking
      this.group.position.x = lerp(this.group.position.x, this._sinkBaseX, 0.15);
      this.group.position.z = lerp(this.group.position.z, this._sinkBaseZ, 0.15);
      this.group.position.y = lerp(this._sinkStartY, -3.0, sinkT * sinkT);

      // Roll and pitch increase
      const rollTarget = this._sinkRollDir * Math.PI * 0.65;
      this.group.rotation.z = lerp(this.group.rotation.z, rollTarget, delta * 1.2);
      this.group.rotation.x = lerp(this.group.rotation.x, -0.3, delta * 0.8);

      // Continuous bubbles/smoke while submerging
      this._damageSmokeTimer += delta;
      if (this._damageSmokeTimer > 0.15) {
        this._damageSmokeTimer = 0;
        this._spawnSmoke();
      }

    // ── Phase 3 (70-100%): Stern tips up, vanish under the waves ──────────
    } else {
      const sinkT = (t - 0.70) / 0.30;
      this.group.position.x = lerp(this.group.position.x, this._sinkBaseX, 0.1);
      this.group.position.z = lerp(this.group.position.z, this._sinkBaseZ, 0.1);
      this.group.position.y = lerp(-3.0, -14, sinkT * sinkT);

      const rollTarget = this._sinkRollDir * Math.PI * 0.9;
      this.group.rotation.z = lerp(this.group.rotation.z, rollTarget, delta * 2.0);
      this.group.rotation.x = lerp(this.group.rotation.x, 0.5, delta * 1.5);
    }

    if (this._sinkTimer >= GameConfig.SINKING_DURATION) {
      this._completeSink();
    }
  }

  // ── Particle helpers ──────────────────────────────────────────────────────

  /** Spawn one smoke puff above the ship. */
  _spawnSmoke() {
    const geo = new THREE.SphereGeometry(0.45 + Math.random() * 0.3, 5, 4);
    const mat = new THREE.MeshBasicMaterial({
      color:       0x555555 + Math.floor(Math.random() * 0x111111),
      transparent: true,
      opacity:     0.72,
      depthWrite:  false,
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Offset slightly from ship centre (random side)
    const ox = (Math.random() - 0.5) * 2.5;
    const oz = (Math.random() - 0.5) * 1.5;
    mesh.position.set(
      this.group.position.x + ox,
      this.group.position.y + 3.0 + Math.random() * 0.5,
      this.group.position.z + oz,
    );
    this.scene.add(mesh);

    this._smokeParticles.push({
      mesh,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.4,
        1.0 + Math.random() * 0.8,
        (Math.random() - 0.5) * 0.4,
      ),
      life:    0,
      maxLife: 1.4 + Math.random() * 1.0,
    });
  }

  /** Update / cull smoke particles. */
  _tickSmoke(delta) {
    // Spawn new smoke when damaged
    if (this.state === ShipState.SAILING && this.health < this.maxHealth * 0.5) {
      const rate = this.health < this.maxHealth * 0.25 ? 0.10 : 0.22;
      this._damageSmokeTimer += delta;
      if (this._damageSmokeTimer >= rate) {
        this._damageSmokeTimer = 0;
        this._spawnSmoke();
      }
    }

    for (let i = this._smokeParticles.length - 1; i >= 0; i--) {
      const p = this._smokeParticles[i];
      p.life += delta;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._smokeParticles.splice(i, 1);
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, delta);
      p.vel.multiplyScalar(1 - 0.5 * delta); // decelerate
      const s = 1 + t * 2.5;                 // grows as it rises
      p.mesh.scale.setScalar(s);
      p.mesh.material.opacity = 0.72 * (1 - t * t);
    }
  }

  /** Spawn one bow-spray droplet. */
  _spawnBowDroplet(bowPos, sideDir) {
    const geo = new THREE.SphereGeometry(0.18 + Math.random() * 0.12, 4, 3);
    const mat = new THREE.MeshBasicMaterial({
      color:       0xddf4ff,
      transparent: true,
      opacity:     0.75,
      depthWrite:  false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(bowPos);
    mesh.position.y += 0.3 + Math.random() * 0.4;
    this.scene.add(mesh);

    const spread = 1.2 + Math.random() * 0.8;
    const upward = 1.5 + Math.random() * 1.2;
    this._bowParticles.push({
      mesh,
      vel: new THREE.Vector3(
        sideDir.x * spread + (Math.random() - 0.5) * 0.4,
        upward,
        sideDir.z * spread + (Math.random() - 0.5) * 0.4,
      ),
      life:    0,
      maxLife: 0.6 + Math.random() * 0.4,
    });
  }

  /** Emit bow spray when moving fast, update all droplets. */
  _tickBow(delta) {
    const spd = this.velocity.length();
    if (this.state === ShipState.SAILING && spd > 1.5) {
      this._bowSplashTimer -= delta;
      if (this._bowSplashTimer <= 0) {
        this._bowSplashTimer = 0.07 + (1 - Math.min(spd / 4, 1)) * 0.08;

        // Bow position = ship position + forward * bowOffset
        const forward = new THREE.Vector3(0, 0, -1)
          .applyQuaternion(this.group.quaternion);
        const bLen = 3.5;
        const bowPos = this.group.position.clone()
          .addScaledVector(forward, bLen);

        // Right and left side vectors
        const right = new THREE.Vector3().crossVectors(
          forward, new THREE.Vector3(0, 1, 0)
        ).normalize();
        const left  = right.clone().negate();

        this._spawnBowDroplet(bowPos, right);
        this._spawnBowDroplet(bowPos, left);

        // Spawn extra spray from stern when drifting at speed
        if (this.isDrifting && spd > 3.0) {
          const sternPos = this.group.position.clone().addScaledVector(forward, -3.0);
          this._spawnBowDroplet(sternPos, right);
          this._spawnBowDroplet(sternPos, left);
        }
      }
    }

    for (let i = this._bowParticles.length - 1; i >= 0; i--) {
      const p = this._bowParticles[i];
      p.life += delta;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._bowParticles.splice(i, 1);
        continue;
      }
      p.vel.y -= 6 * delta; // gravity
      p.mesh.position.addScaledVector(p.vel, delta);
      p.mesh.material.opacity = 0.75 * (1 - t);
    }
  }

  _beginSinking() {
    this.state = ShipState.SINKING;
    this._sinkTimer    = 0;
    this._sinkStartY   = this.group.position.y;
    this._sinkBaseX    = this.group.position.x;
    this._sinkBaseZ    = this.group.position.z;
    this._sinkRollDir  = Math.random() < 0.5 ? 1 : -1;  // random roll direction
    this._sinkShakeTimer = 0;
    this.velocity.set(0, 0, 0);
    this.thrust   = 0;
    this.steering = 0;

    EventEmitter.emit('ship:destroyed', { ship: this });
  }

  _completeSink() {
    this.state = ShipState.SUNK;

    // Remove original model, place wreck
    this.scene.remove(this.group);

    // Clone wreck so each sunk ship gets its own independent mesh instance
    const wreck = AssetLoader.get('ship-wreck').clone();
    wreck.position.set(this._sinkBaseX, -0.5, this._sinkBaseZ);
    wreck.rotation.y = this.group.rotation.y + randRange(-0.5, 0.5);
    this.scene.add(wreck);

    // Auto-remove wreck after 60 s
    setTimeout(() => this.scene.remove(wreck), 60_000);

    EventEmitter.emit('ship:sunk', { ship: this });
  }

  /** Remove from scene immediately (used by pool / respawn). */
  dispose() {
    this.scene.remove(this.group);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
export class ShipSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {Ocean}       ocean
   */
  constructor(scene, ocean) {
    this._scene  = scene;
    this._ocean  = ocean;
    /** @type {Map<string, Ship>} */
    this._ships  = new Map();
    this._nextId = 1;
  }

  /** Create and track a new ship. Returns the Ship instance. */
  createShip(shipClass, faction, x = 0, z = 0) {
    const id   = `ship_${this._nextId++}`;
    const ship = new Ship(id, shipClass, faction, this._scene);
    ship.setPosition(x, 1.0, z);
    this._ships.set(id, ship);
    return ship;
  }

  /** Get a ship by id. */
  get(id) { return this._ships.get(id); }

  /** All currently tracked ships. */
  get all() { return Array.from(this._ships.values()); }

  /** Alive (non-sunk) ships. */
  get alive() { return this.all.filter(s => s.isAlive); }

  /** Enemy ships (non-player, non-sunk). */
  get enemies() { return this.alive.filter(s => s.faction !== Faction.PLAYER); }

  /** Remove sunk ships from the map after they're fully gone. */
  _cleanup() {
    for (const [id, ship] of this._ships) {
      if (ship.state === ShipState.SUNK) {
        this._ships.delete(id);
      }
    }
  }

  /**
   * @param {number} delta
   * @param {number} [windAngle=0]
   * @param {number} [windStrength=1.0]
   */
  update(delta, windAngle = 0, windStrength = 1.0) {
    for (const ship of this._ships.values()) {
      ship.update(delta, this._ocean, windAngle, windStrength);
    }
    this._resolveCollisions();
    if (this._islands) this._resolveIslandCollisions();
    // Deterministic cleanup: remove sunk ships every 5 s
    this._cleanupTimer = (this._cleanupTimer ?? 0) + delta;
    if (this._cleanupTimer >= 5.0) {
      this._cleanupTimer = 0;
      this._cleanup();
    }
  }

  /** Provide island data for collision checks. Call once after world generation. */
  setIslands(islands) {
    this._islands = islands;
  }

  /** Keep all sailing ships outside island collision circles (XZ plane). */
  _resolveIslandCollisions() {
    for (const ship of this.alive) {
      if (!ship.isSailing) continue;
      // Skip partner ghost ships — their position is driven by the network
      if (ship._isPartnerGhost) continue;
      const sx = ship.group.position.x;
      const sz = ship.group.position.z;

      for (const island of this._islands) {
        const ix = island.position.x;
        const iz = island.position.z;
        const dx = sx - ix;
        const dz = sz - iz;
        const dist2 = dx * dx + dz * dz;
        const r = island.collisionRadius;

        if (dist2 < r * r && dist2 > 0.0001) {
          const dist = Math.sqrt(dist2);
          // Push ship to the boundary
          const nx = dx / dist;
          const nz = dz / dist;
          ship.group.position.x = ix + nx * r;
          ship.group.position.z = iz + nz * r;

          // Dampen velocity — simulate hitting the shore, allow sliding
          const velDot = ship.velocity.x * nx + ship.velocity.z * nz;
          if (velDot < 0) {
            ship.velocity.x -= velDot * nx;
            ship.velocity.z -= velDot * nz;
          }
          ship.velocity.multiplyScalar(0.35);
        }
      }
    }
  }

  /** Push overlapping ships apart — simple sphere collision, radius 6 units each. */
  _resolveCollisions() {
    const ships = this.alive;
    const RADIUS = 6;
    const DIAMETER = RADIUS * 2;

    for (let i = 0; i < ships.length - 1; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        const a = ships[i];
        const b = ships[j];
        if (!a.isSailing || !b.isSailing) continue;
        // Skip partner ghost ships — their position is driven by the network
        if (a._isPartnerGhost || b._isPartnerGhost) continue;

        const dx   = a.group.position.x - b.group.position.x;
        const dz   = a.group.position.z - b.group.position.z;
        const dist2 = dx * dx + dz * dz;

        if (dist2 < DIAMETER * DIAMETER && dist2 > 0.0001) {
          const dist    = Math.sqrt(dist2);
          const overlap = DIAMETER - dist;
          const nx = dx / dist;
          const nz = dz / dist;

          // Separate the two ships equally
          const push = overlap * 0.5;
          a.group.position.x += nx * push;
          a.group.position.z += nz * push;
          b.group.position.x -= nx * push;
          b.group.position.z -= nz * push;

          // Dampen relative velocity along the collision normal
          const relVx = a.velocity.x - b.velocity.x;
          const relVz = a.velocity.z - b.velocity.z;
          const velAlong = relVx * nx + relVz * nz;
          if (velAlong > 0) {
            const impulse = velAlong * 0.45;
            a.velocity.x -= nx * impulse;
            a.velocity.z -= nz * impulse;
            b.velocity.x += nx * impulse;
            b.velocity.z += nz * impulse;
          }
        }
      }
    }
  }
}

export { Faction, ShipClass };
export default ShipSystem;
