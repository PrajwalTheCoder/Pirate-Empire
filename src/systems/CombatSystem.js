/**
 * CombatSystem — manages cannonball firing, movement, collision, and effects.
 *
 * Particle smoke is handled here as lightweight billboard quads.
 * Ammo types: ROUND (standard), CHAIN (speed debuff), FIRE (DoT burn).
 */
import * as THREE      from 'three';
import AssetLoader     from './AssetLoader.js';
import EventEmitter    from '../utils/EventEmitter.js';
import GameConfig      from '../config/GameConfig.js';
import { dist2D, randRange } from '../utils/MathUtils.js';

// ─── AMMO DEFINITIONS ──────────────────────────────────────────────────────────
export const AmmoType = Object.freeze({
  ROUND: 'ROUND',   // Standard — high damage
  CHAIN: 'CHAIN',   // Chain shot — slows enemy ship
  FIRE:  'FIRE',    // Fire shot — damage over time
  CURSED_SPECTRAL: 'CURSED_SPECTRAL', // Silas Veynar's cursed shots
});

const AMMO_CONFIG = {
  [AmmoType.ROUND]: {
    label:      '💣 Round',
    color:      0x222222,
    trailColor: 0xffaa33,
    damageMult: 1.0,
    speed:      1.0,
    ballScale:  1.0,
  },
  [AmmoType.CHAIN]: {
    label:      '⛓ Chain',
    color:      0x888899,
    trailColor: 0x99aaff,
    damageMult: 0.55,
    speed:      1.1,
    ballScale:  0.85,
  },
  [AmmoType.FIRE]: {
    label:      '🔥 Fire',
    color:      0xff5500,
    trailColor: 0xff8800,
    damageMult: 0.7,
    speed:      0.85,
    ballScale:  1.2,
  },
  [AmmoType.CURSED_SPECTRAL]: {
    label:      '💀 Cursed',
    color:      0x00ffcc,
    trailColor: 0x00d4aa,
    damageMult: 2.0,
    speed:      1.0,
    ballScale:  1.3,
  },
};

const AMMO_ORDER = [AmmoType.ROUND, AmmoType.CHAIN, AmmoType.FIRE];

// ─── MUZZLE FLASH ─────────────────────────────────────────────────────────────
class MuzzleFlash {
  static _geo = null;
  static _mat = null;

  constructor(scene, position) {
    if (!MuzzleFlash._geo) {
      MuzzleFlash._geo = new THREE.SphereGeometry(0.8, 6, 6);
      MuzzleFlash._mat = new THREE.MeshBasicMaterial({
        color: 0xffdd44,
        transparent: true,
        depthWrite: false,
      });
    }
    this.age      = 0;
    this.lifetime = 0.12;
    this.scene    = scene;
    this.mesh     = new THREE.Mesh(MuzzleFlash._geo, MuzzleFlash._mat.clone());
    this.mesh.position.copy(position);
    scene.add(this.mesh);
  }

  update(delta) {
    this.age += delta;
    const t = this.age / this.lifetime;
    this.mesh.scale.setScalar(1 + t * 3);
    this.mesh.material.opacity = 1 - t;
  }

  get dead() { return this.age >= this.lifetime; }
  dispose()  { this.scene.remove(this.mesh); }
}

// ─── WATER SPLASH ───────────────────────────────────────────────────────────
class WaterSplash {
  constructor(scene, position) {
    this.age      = 0;
    this.lifetime = 0.8;
    this.scene    = scene;
    this._drops   = [];

    // Spawn 5 small white streaks shooting upward
    const geo = new THREE.SphereGeometry(0.18, 4, 4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xddeeff, transparent: true, depthWrite: false });
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.position.copy(position);
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 5;
      mesh._vel = new THREE.Vector3(
        Math.cos(angle) * speed * 0.4,
        speed,
        Math.sin(angle) * speed * 0.4,
      );
      scene.add(mesh);
      this._drops.push(mesh);
    }
  }

  update(delta) {
    this.age += delta;
    const t = this.age / this.lifetime;
    for (const d of this._drops) {
      d._vel.y -= 18 * delta;   // gravity
      d.position.addScaledVector(d._vel, delta);
      d.material.opacity = Math.max(0, 1 - t);
    }
  }

  get dead() { return this.age >= this.lifetime; }
  dispose()  { this._drops.forEach(d => this.scene.remove(d)); }
}

// ─── FIRE BURST ─────────────────────────────────────────────────────────────
/** Fiery particle burst spawned on Fire Shot impact */
class FireBurst {
  constructor(scene, position) {
    this._scene    = scene;
    this._age      = 0;
    this._lifetime = 2.2;
    this._parts    = [];

    // Core fireball
    const fbGeo = new THREE.SphereGeometry(0.9, 7, 7);
    const fbMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, depthWrite: false });
    const fb = new THREE.Mesh(fbGeo, fbMat);
    fb.position.copy(position).setY(position.y + 1);
    scene.add(fb);
    this._parts.push({ mesh: fb, vel: new THREE.Vector3(0, 3, 0), type: 'core', life: 0, maxLife: 0.55 });

    // Ember sparks
    const spkGeo = new THREE.SphereGeometry(0.12, 4, 4);
    for (let i = 0; i < 14; i++) {
      const spkMat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xff4400 : 0xffcc00,
        transparent: true, depthWrite: false,
      });
      const spk = new THREE.Mesh(spkGeo, spkMat);
      spk.position.copy(position).add(new THREE.Vector3(
        randRange(-0.5, 0.5), randRange(0.5, 2), randRange(-0.5, 0.5)
      ));
      const angle = (i / 14) * Math.PI * 2;
      const spd   = 4 + Math.random() * 7;
      scene.add(spk);
      this._parts.push({
        mesh: spk,
        vel: new THREE.Vector3(Math.cos(angle) * spd * 0.7, spd * 0.9, Math.sin(angle) * spd * 0.7),
        type: 'ember', life: 0, maxLife: 0.6 + Math.random() * 0.8,
      });
    }

    // Smoke columns
    const smkGeo = new THREE.SphereGeometry(0.8, 5, 5);
    for (let i = 0; i < 5; i++) {
      const smkMat = new THREE.MeshBasicMaterial({
        color: 0x441100, transparent: true, opacity: 0, depthWrite: false,
      });
      const smk = new THREE.Mesh(smkGeo, smkMat);
      smk.position.copy(position).add(new THREE.Vector3(randRange(-1.5, 1.5), 1, randRange(-1.5, 1.5)));
      scene.add(smk);
      this._parts.push({
        mesh: smk, vel: new THREE.Vector3(randRange(-0.5, 0.5), 2 + Math.random() * 3, randRange(-0.5, 0.5)),
        type: 'smoke', life: 0, maxLife: 1.5 + Math.random() * 0.7, delay: 0.15 + Math.random() * 0.25,
      });
    }
  }

  update(delta) {
    this._age += delta;
    for (let i = this._parts.length - 1; i >= 0; i--) {
      const p = this._parts[i];
      if (p.delay && this._age < p.delay) continue;
      p.life += delta;
      const t = Math.min(p.life / p.maxLife, 1);
      if (t >= 1) { this._scene.remove(p.mesh); this._parts.splice(i, 1); continue; }
      p.mesh.position.addScaledVector(p.vel, delta);
      if (p.type === 'core') {
        p.mesh.scale.setScalar(1 + t * 4);
        p.mesh.material.opacity = 1 - t * t;
      } else if (p.type === 'ember') {
        p.vel.y -= 14 * delta;
        p.mesh.material.opacity = 1 - t;
      } else if (p.type === 'smoke') {
        p.vel.multiplyScalar(1 - 0.5 * delta);
        p.mesh.scale.setScalar(1 + t * 5);
        p.mesh.material.opacity = t < 0.3 ? t / 0.3 * 0.7 : (1 - t) * 0.7;
      }
    }
  }

  get dead() { return this._age >= this._lifetime; }
  dispose() { for (const p of this._parts) this._scene.remove(p.mesh); this._parts.length = 0; }
}

// ─── CHAIN BURST ────────────────────────────────────────────────────────────
/** Metallic debris burst spawned on Chain Shot impact */
class ChainBurst {
  constructor(scene, position) {
    this._scene    = scene;
    this._age      = 0;
    this._lifetime = 1.6;
    this._parts    = [];

    // 2 chain link meshes spinning outward
    const linkGeo = new THREE.TorusGeometry(0.35, 0.08, 5, 10);
    for (let i = 0; i < 2; i++) {
      const linkMat = new THREE.MeshLambertMaterial({ color: 0x889aaa });
      const link = new THREE.Mesh(linkGeo, linkMat);
      link.position.copy(position).add(new THREE.Vector3(0, 0.8, 0));
      const angle = i * Math.PI;
      const spd = 5 + Math.random() * 5;
      scene.add(link);
      this._parts.push({
        mesh: link,
        vel: new THREE.Vector3(Math.cos(angle) * spd, 4, Math.sin(angle) * spd),
        rot: new THREE.Vector3(randRange(-6, 6), randRange(-6, 6), randRange(-6, 6)),
        type: 'link', life: 0, maxLife: 1.1,
      });
    }

    // Blue-white spark ring
    const spkGeo = new THREE.SphereGeometry(0.1, 4, 4);
    for (let i = 0; i < 10; i++) {
      const spkMat = new THREE.MeshBasicMaterial({ color: 0xaaddff, transparent: true, depthWrite: false });
      const spk = new THREE.Mesh(spkGeo, spkMat);
      spk.position.copy(position).add(new THREE.Vector3(0, 0.5, 0));
      const a = (i / 10) * Math.PI * 2;
      const spd = 6 + Math.random() * 6;
      scene.add(spk);
      this._parts.push({
        mesh: spk,
        vel: new THREE.Vector3(Math.cos(a) * spd, randRange(1, 5), Math.sin(a) * spd),
        type: 'spark', life: 0, maxLife: 0.4 + Math.random() * 0.5,
      });
    }

    // Expanding ring flash
    const ringGeo = new THREE.RingGeometry(0.3, 2.5, 18);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xaaccff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(position).setY(0.2);
    scene.add(ring);
    this._parts.push({ mesh: ring, vel: new THREE.Vector3(), type: 'ring', life: 0, maxLife: 0.5 });
  }

  update(delta) {
    this._age += delta;
    for (let i = this._parts.length - 1; i >= 0; i--) {
      const p = this._parts[i];
      p.life += delta;
      const t = Math.min(p.life / p.maxLife, 1);
      if (t >= 1) { this._scene.remove(p.mesh); this._parts.splice(i, 1); continue; }
      if (p.type === 'link') {
        p.vel.y -= 12 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
        p.mesh.rotation.x += p.rot.x * delta;
        p.mesh.rotation.y += p.rot.y * delta;
      } else if (p.type === 'spark') {
        p.vel.y -= 10 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
        p.mesh.material.opacity = 1 - t;
      } else if (p.type === 'ring') {
        p.mesh.scale.setScalar(1 + t * 6);
        p.mesh.material.opacity = (1 - t) * 0.9;
      }
    }
  }

  get dead() { return this._age >= this._lifetime; }
  dispose() { for (const p of this._parts) this._scene.remove(p.mesh); this._parts.length = 0; }
}

// ─── DEATH EXPLOSION ───────────────────────────────────────────────────────────
class DeathExplosion {
  constructor(scene, position) {
    this._scene    = scene;
    this._age      = 0;
    this._lifetime = 3.0;
    this._parts    = [];

    // Central fireball — big expanding sphere
    const fbGeo = new THREE.SphereGeometry(1.5, 8, 8);
    const fbMat = new THREE.MeshBasicMaterial({
      color: 0xff8800, transparent: true, depthWrite: false,
    });
    const fireball = new THREE.Mesh(fbGeo, fbMat);
    fireball.position.copy(position);
    fireball.position.y += 2;
    scene.add(fireball);
    this._parts.push({ mesh: fireball, vel: new THREE.Vector3(0, 4, 0),
      type: 'fireball', life: 0, maxLife: 0.7 });

    // Inner brighter core
    const coreGeo = new THREE.SphereGeometry(0.8, 6, 6);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffff80, transparent: true, depthWrite: false,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.copy(position);
    core.position.y += 2.5;
    scene.add(core);
    this._parts.push({ mesh: core, vel: new THREE.Vector3(0, 3, 0),
      type: 'fireball', life: 0, maxLife: 0.4 });

    // Flying debris chunks (wood splinters)
    const debGeo = new THREE.BoxGeometry(0.4, 0.15, 0.9);
    for (let i = 0; i < 12; i++) {
      const debMat = new THREE.MeshLambertMaterial({
        color: 0x6b3a1f + Math.floor(Math.random() * 0x111111),
      });
      const deb = new THREE.Mesh(debGeo, debMat);
      deb.position.copy(position);
      deb.position.y += 1.5 + Math.random() * 1.5;
      const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.5;
      const spd   = 6 + Math.random() * 10;
      scene.add(deb);
      this._parts.push({
        mesh: deb,
        vel:  new THREE.Vector3(Math.cos(angle) * spd, 4 + Math.random() * 8, Math.sin(angle) * spd),
        rot:  new THREE.Vector3((Math.random()-0.5)*8, (Math.random()-0.5)*8, (Math.random()-0.5)*8),
        type: 'debris', life: 0, maxLife: 1.5 + Math.random() * 0.8,
      });
    }

    // Smoke puffs (large dark clouds)
    const smokGeo = new THREE.SphereGeometry(1.2, 6, 5);
    for (let i = 0; i < 7; i++) {
      const smokMat = new THREE.MeshBasicMaterial({
        color: 0x333333, transparent: true, opacity: 0, depthWrite: false,
      });
      const smk = new THREE.Mesh(smokGeo, smokMat);
      const offX = (Math.random() - 0.5) * 5;
      const offZ = (Math.random() - 0.5) * 5;
      smk.position.set(position.x + offX, position.y + 1 + Math.random() * 2, position.z + offZ);
      scene.add(smk);
      this._parts.push({
        mesh: smk,
        vel:  new THREE.Vector3((Math.random()-0.5) * 1.5, 2 + Math.random() * 3, (Math.random()-0.5) * 1.5),
        type: 'smoke', life: 0, maxLife: 2.5 + Math.random() * 0.5,
        delay: Math.random() * 0.3,
      });
    }

    // Splash ring at waterline
    const ringGeo = new THREE.RingGeometry(0.5, 4, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x88ccff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(position.x, position.y + 0.3, position.z);
    scene.add(ring);
    this._parts.push({ mesh: ring, vel: new THREE.Vector3(0, 0, 0),
      type: 'ring', life: 0, maxLife: 0.9 });
  }

  update(delta) {
    this._age += delta;

    for (let i = this._parts.length - 1; i >= 0; i--) {
      const p = this._parts[i];

      // Delay-start for smoke
      if (p.delay && this._age < p.delay) continue;

      p.life += delta;
      const t = Math.min(p.life / p.maxLife, 1);

      if (t >= 1) {
        this._scene.remove(p.mesh);
        this._parts.splice(i, 1);
        continue;
      }

      if (p.type === 'fireball') {
        p.mesh.position.addScaledVector(p.vel, delta);
        p.vel.multiplyScalar(1 - 3 * delta);
        const s = 1 + t * 5;
        p.mesh.scale.setScalar(s);
        p.mesh.material.opacity = 1 - t * t;

      } else if (p.type === 'debris') {
        p.vel.y -= 12 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
        p.mesh.rotation.x += p.rot.x * delta;
        p.mesh.rotation.y += p.rot.y * delta;
        p.mesh.rotation.z += p.rot.z * delta;

      } else if (p.type === 'smoke') {
        p.mesh.position.addScaledVector(p.vel, delta);
        p.vel.multiplyScalar(1 - 0.8 * delta);
        const s = 1 + t * 4;
        p.mesh.scale.setScalar(s);
        // Smoke fades in then out
        p.mesh.material.opacity = t < 0.25
          ? t / 0.25 * 0.6          // fade in
          : (1 - t) * 0.6;          // fade out

      } else if (p.type === 'ring') {
        const s = 1 + t * 8;
        p.mesh.scale.setScalar(s);
        p.mesh.material.opacity = (1 - t) * 0.8;
      }
    }
  }

  get dead() { return this._age >= this._lifetime; }

  dispose() {
    for (const p of this._parts) this._scene.remove(p.mesh);
    this._parts.length = 0;
  }
}

// ─── CANNONBALL ────────────────────────────────────────────────────────────────
class Cannonball {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} position  — spawn position
   * @param {THREE.Vector3} velocity  — world-space velocity
   * @param {Ship}          owner
   * @param {string}        ammoType  — AmmoType enum value
   */
  constructor(scene, position, velocity, owner, ammoType = AmmoType.ROUND) {
    this.owner    = owner;
    this.ammoType = ammoType;
    this.lifetime = GameConfig.CANNONBALL_LIFETIME;
    this.velocity = velocity.clone();
    this.scene    = scene;

    const cfg  = AMMO_CONFIG[ammoType];
    const geo  = new THREE.SphereGeometry(0.25 * cfg.ballScale, 6, 6);
    const mat  = new THREE.MeshLambertMaterial({ color: cfg.color });
    this.mesh  = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = false;
    this.mesh.position.copy(position);
    scene.add(this.mesh);

    // Pre-allocate trail particle pool — avoid per-frame geometry/material creation
    const TRAIL_POOL_SIZE = 8;
    this._trail  = [];
    this._trailHead = 0;  // ring-buffer head index
    this._trailTimer = 0;
    this._trailColor = cfg.trailColor;
    const colorHex = parseInt(String(cfg.trailColor ?? '#ff6600').replace('#', ''), 16);
    const trailGeo = new THREE.SphereGeometry(0.12, 4, 4);  // shared geometry
    for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
      const tMat = new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: 0, depthWrite: false,
      });
      const t = new THREE.Mesh(trailGeo, tMat);
      t._age    = 999;  // start expired so they're invisible
      t._maxAge = 0.35;
      scene.add(t);
      this._trail.push(t);
    }
  }

  /** @param {number} delta */
  update(delta) {
    this.lifetime -= delta;
    // Gravity (chain shot has slightly less gravity — stabilised bar)
    const gravMult = this.ammoType === AmmoType.CHAIN ? 2.8 : 4;
    this.velocity.y -= gravMult * delta;
    this.mesh.position.addScaledVector(this.velocity, delta);

    // Emit trail particles for fire / chain shots using pool ring-buffer
    if (this.ammoType !== AmmoType.ROUND) {
      this._trailTimer -= delta;
      if (this._trailTimer <= 0) {
        this._trailTimer = 0.04;
        // Recycle the oldest slot in the ring buffer
        const t = this._trail[this._trailHead];
        this._trailHead = (this._trailHead + 1) % this._trail.length;
        t.position.copy(this.mesh.position);
        t._age = 0;
        t.scale.setScalar(1);
        t.material.opacity = 0.85;
      }
    }

    // Age trail pool
    for (const t of this._trail) {
      if (t._age >= t._maxAge) continue;
      t._age += delta;
      t.material.opacity = Math.max(0, 0.85 * (1 - t._age / t._maxAge));
      t.scale.setScalar(1 + t._age * 3);
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    // Return pooled trail particles to invisible state instead of removing them
    for (const t of this._trail) {
      t._age = 999;
      t.material.opacity = 0;
      this.scene.remove(t);
    }
    this._trail.length = 0;
  }
}

// ─── SMOKE PARTICLE ────────────────────────────────────────────────────────────
class SmokeParticle {
  static _geo = null;
  static _mat = null;

  constructor(scene, position) {
    if (!SmokeParticle._geo) {
      SmokeParticle._geo = new THREE.PlaneGeometry(1.5, 1.5);
      SmokeParticle._mat = new THREE.MeshBasicMaterial({
        color: 0xaaaaaa,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    this.lifetime = 1.5;
    this.age      = 0;
    this.scene    = scene;

    this.mesh = new THREE.Mesh(
      SmokeParticle._geo,
      SmokeParticle._mat.clone(),  // clone so opacity is independent
    );
    this.mesh.position.copy(position);
    this.mesh.position.y += 1.5;
    this._vel = new THREE.Vector3(
      randRange(-1.5, 1.5),
      randRange(2, 5),
      randRange(-1.5, 1.5),
    );
    scene.add(this.mesh);
  }

  update(delta) {
    this.age += delta;
    this.mesh.position.addScaledVector(this._vel, delta);
    this.mesh.scale.setScalar(1 + this.age * 2);
    this.mesh.material.opacity = Math.max(0, 1 - this.age / this.lifetime);
    // Billboard toward camera — handled globally if needed; skip for perf
  }

  get dead() { return this.age >= this.lifetime; }

  dispose() { this.scene.remove(this.mesh); }
}

// ─── COMBAT SYSTEM ─────────────────────────────────────────────────────────────
export class CombatSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {ShipSystem}  shipSystem
   */
  constructor(scene, shipSystem) {
    this._scene      = scene;
    this._shipSystem = shipSystem;
    this._islands    = null;

    /** Current player ammo selection */
    this.currentAmmo = AmmoType.ROUND;

    /** @type {Cannonball[]} */
    this._balls   = [];
    /** @type {SmokeParticle[]} */
    this._smoke   = [];
    /** @type {MuzzleFlash[]} */
    this._flashes = [];
    /** @type {WaterSplash[]} */
    this._splashes = [];
    /** @type {DeathExplosion[]} */
    this._explosions = [];
    /** @type {FireBurst[]|ChainBurst[]} */
    this._impactFX = [];

    // Aiming Arcs
    this._aimLinePort = this._createAimLine(0xff3333);
    this._aimLineStarboard = this._createAimLine(0xff3333);
    this._scene.add(this._aimLinePort);
    this._scene.add(this._aimLineStarboard);

    // Target landing circles on the water
    this._targetRingPort = this._createTargetRing(0xff3333);
    this._targetRingStarboard = this._createTargetRing(0xff3333);
    this._scene.add(this._targetRingPort);
    this._scene.add(this._targetRingStarboard);

    // Build ammo selector UI widget
    this._buildAmmoUI();

    /**
     * Optional callback for co-op client mode.
     * When set, called as onPlayerHitEnemy(ship, baseDamage) when the player's
     * cannonball hits an enemy ship. If the callback returns true, local
     * damage application is suppressed (damage is routed to host instead).
     * @type {((ship: object, damage: number) => boolean) | null}
     */
    this.onPlayerHitEnemy = null;
  }

  // ── Ammo UI ────────────────────────────────────────────────────────────────
  _buildAmmoUI() {
    // Create the ammo selector if it doesn't exist yet
    let container = document.getElementById('ammo-selector');
    if (container) return;
    container = document.createElement('div');
    container.id = 'ammo-selector';
    container.innerHTML = `
      <div class="ammo-title">AMMO</div>
      <div class="ammo-slots">
        <div class="ammo-slot active" id="ammo-slot-ROUND" data-ammo="ROUND">
          <span class="ammo-icon">💣</span>
          <span class="ammo-name">ROUND</span>
          <span class="ammo-key">1</span>
        </div>
        <div class="ammo-slot" id="ammo-slot-CHAIN" data-ammo="CHAIN">
          <span class="ammo-icon">⛓</span>
          <span class="ammo-name">CHAIN</span>
          <span class="ammo-key">2</span>
        </div>
        <div class="ammo-slot" id="ammo-slot-FIRE" data-ammo="FIRE">
          <span class="ammo-icon">🔥</span>
          <span class="ammo-name">FIRE</span>
          <span class="ammo-key">3</span>
        </div>
      </div>
    `;
    document.body.appendChild(container);
  }

  /**
   * Cycle to next ammo type or set a specific ammo.
   * @param {string|null} type  — if null, cycle forward
   */
  setAmmo(type = null) {
    if (type) {
      this.currentAmmo = type;
    } else {
      const idx = AMMO_ORDER.indexOf(this.currentAmmo);
      this.currentAmmo = AMMO_ORDER[(idx + 1) % AMMO_ORDER.length];
    }
    this._refreshAmmoUI();
  }

  _refreshAmmoUI() {
    for (const t of AMMO_ORDER) {
      const slot = document.getElementById(`ammo-slot-${t}`);
      if (slot) slot.classList.toggle('active', t === this.currentAmmo);
    }
    // Flash the active slot
    const active = document.getElementById(`ammo-slot-${this.currentAmmo}`);
    if (active) {
      active.classList.add('ammo-flash');
      setTimeout(() => active.classList.remove('ammo-flash'), 300);
    }
  }

  /** Register island data so cannonballs can damage player-owned islands. */
  setIslands(islands) { this._islands = islands; }

  /**
   * Fire a broadside from a ship (two cannonballs — port and starboard).
   * @param {Ship}    ship
   * @param {boolean} [portSide=false] — if true, fire to the left only
   * @param {string}  [ammoOverride]   — force a specific ammo type (for AI)
   */
  fireCannons(ship, portSide = false, ammoOverride = null) {
    if (!ship.isSailing) return;
    if (ship.cannonCooldown > 0) return;

    // Player uses selected ammo; enemies always use ROUND
    let ammo = (ship.faction === 'PLAYER')
      ? this.currentAmmo
      : (ammoOverride ?? AmmoType.ROUND);

    if (ship.group?.name === "Silas Veynar's Dread") {
      ammo = AmmoType.CURSED_SPECTRAL;
    }
    const cfg  = AMMO_CONFIG[ammo];

    ship.cannonCooldown = GameConfig.CANNON_FIRE_COOLDOWN *
      (ship.faction === 'PLAYER' ? (ship._fireCooldownMult ?? 1.0) : 1.2);

    const right = new THREE.Vector3(1, 0,  0).applyQuaternion(ship.group.quaternion);
    const base  = ship.group.position.clone();
    base.y     += 1.2;

    const speed = GameConfig.CANNONBALL_SPEED * cfg.speed;

    const extraCount = ship._extraBalls ?? 0;
    const sideExtra = Math.floor(extraCount / 2); // e.g. 1 on each side for +2 extra balls

    // Port (left) cannonballs
    if (!portSide) {
      const totalBalls = 1 + sideExtra;
      const spread = 0.25;
      const angles = [];
      if (totalBalls === 1) {
        angles.push(0);
      } else {
        for (let j = 0; j < totalBalls; j++) {
          angles.push(-spread / 2 + (spread / (totalBalls - 1)) * j);
        }
      }

      for (const angle of angles) {
        const dir = right.clone().multiplyScalar(-1).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        const posL = base.clone().addScaledVector(right, -2.5);
        const velL = dir.multiplyScalar(speed).addScaledVector(ship.velocity, 0.5);
        this._spawn(posL, velL, ship, ammo);
      }
    }

    // Starboard (right) cannonballs
    {
      const totalBalls = 1 + sideExtra;
      const spread = 0.25;
      const angles = [];
      if (totalBalls === 1) {
        angles.push(0);
      } else {
        for (let j = 0; j < totalBalls; j++) {
          angles.push(-spread / 2 + (spread / (totalBalls - 1)) * j);
        }
      }

      for (const angle of angles) {
        const dir = right.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        const posR = base.clone().addScaledVector(right, 2.5);
        const velR = dir.multiplyScalar(speed).addScaledVector(ship.velocity, 0.5);
        this._spawn(posR, velR, ship, ammo);
      }
    }

    // Muzzle smoke — color-tinted for fire shot / cursed spectral shot
    if (ammo === AmmoType.FIRE) {
      this._spawnColorSmoke(base, 4, 0xff4400);
    } else if (ammo === AmmoType.CURSED_SPECTRAL) {
      this._spawnColorSmoke(base, 6, 0x00ffcc);
    } else {
      this._spawnSmoke(base, 6);
    }

    // Muzzle flash on each cannon
    const flashL = base.clone().addScaledVector(right, -2.5);
    const flashR = base.clone().addScaledVector(right,  2.5);
    this._flashes.push(new MuzzleFlash(this._scene, flashL));
    if (!portSide) this._flashes.push(new MuzzleFlash(this._scene, flashR));

    EventEmitter.emit('combat:fired', { ship, ammo });
  }

  /**
   * Fire a single aimed cannonball from a captured island cannon.
   * Uses a fake owner flagged with isIsland so the collision loop
   * won't hurt the player ship.
   * @param {THREE.Vector3} fromPos
   * @param {THREE.Vector3} toPos
   * @param {number}        power
   */
  fireIslandCannon(fromPos, toPos, power) {
    const dir = new THREE.Vector3()
      .subVectors(toPos, fromPos)
      .setY(0)
      .normalize();
    const startPos = fromPos.clone().setY(2.5);
    const vel = dir.multiplyScalar(GameConfig.CANNONBALL_SPEED * 0.85);
    const fakeOwner = { faction: 'PLAYER', cannonPower: power, isIsland: true };
    this._spawn(startPos, vel, fakeOwner);
    this._spawnSmoke(startPos, 4);
    this._flashes.push(new MuzzleFlash(this._scene, startPos.clone()));
  }

  /** Spawn a dramatic death explosion at a world position. */
  spawnDeathExplosion(position) {
    this._explosions.push(new DeathExplosion(this._scene, position));
  }

  _spawn(position, velocity, owner, ammoType) {
    this._balls.push(new Cannonball(this._scene, position, velocity, owner, ammoType));
  }

  _spawnSmoke(position, count) {
    for (let i = 0; i < count; i++) {
      this._smoke.push(new SmokeParticle(this._scene, position.clone()));
    }
  }

  _spawnColorSmoke(position, count, color) {
    for (let i = 0; i < count; i++) {
      const p = new SmokeParticle(this._scene, position.clone());
      p.mesh.material.color.setHex(color);
      this._smoke.push(p);
    }
  }

  /** @param {number} delta */
  update(delta) {
    // Update and cull cannonballs
    for (let i = this._balls.length - 1; i >= 0; i--) {
      const ball = this._balls[i];
      ball.update(delta);

      if (ball.lifetime <= 0 || ball.mesh.position.y < -10) {
        // Cannonball expired in water — spawn a splash
        if (ball.mesh.position.y < 2)
          this._splashes.push(new WaterSplash(this._scene, ball.mesh.position.clone()));
        ball.dispose();
        this._balls.splice(i, 1);
        continue;
      }

      // Collision vs all ships (not owner)
      for (const ship of this._shipSystem.alive) {
        if (ship === ball.owner) continue;
        // Island cannon balls must not hurt the player
        if (ball.owner.isIsland && ship.faction === 'PLAYER') continue;
        // Same faction — skip friendly fire
        if (ship.faction !== 'PLAYER' && ball.owner.faction !== 'PLAYER' &&
            ship.faction === ball.owner.faction) continue;

        const dist = ball.mesh.position.distanceTo(ship.group.position);
        if (dist < GameConfig.SHIP_COLLISION_RADIUS) {
          // Ammo-specific damage multiplier
          const cfg = AMMO_CONFIG[ball.ammoType ?? AmmoType.ROUND];
          const berserkerMult = ball.owner._berserkerActive ? 1.4 : 1.0;
          const baseDamage = (ball.owner.cannonPower + randRange(-5, 5)) * cfg.damageMult * berserkerMult;

          // Co-op client: route player hits on enemies to the host for authoritative damage
          const isClientPlayerHit = this.onPlayerHitEnemy
            && ball.owner.faction === 'PLAYER'
            && ship.faction !== 'PLAYER';
          if (isClientPlayerHit) {
            // Let the callback suppress local damage (returns true = handled by network)
            this.onPlayerHitEnemy(ship, baseDamage);
          } else {
            ship.takeDamage(baseDamage);
          }
          EventEmitter.emit('ship:hit', { ship, damage: baseDamage });

          // Knockback impulse — push ship away from impact point
          if (ship.isSailing) {
            const impulseDir = new THREE.Vector3()
              .subVectors(ship.group.position, ball.mesh.position)
              .setY(0).normalize();
            const knockback = ball.ammoType === AmmoType.CHAIN ? 8.5 : 4.5;
            ship.velocity.addScaledVector(impulseDir, knockback);
          }

          // Chain Shot — apply speed debuff to target
          if (ball.ammoType === AmmoType.CHAIN && ship.isSailing) {
            const extraSlowTime = ball.owner._chainMasteryPerk ?? 0;
            ship._chainSlowTimer = (ship._chainSlowTimer ?? 0) + 3.5 + extraSlowTime;
            ship._chainSlowTimer = Math.min(ship._chainSlowTimer, 6 + extraSlowTime);
            // Actual slow applied in ShipSystem update via ship._chainSlowTimer
          }

          // Cursed Spectral Shot — apply slow debuff to player/target
          if (ball.ammoType === AmmoType.CURSED_SPECTRAL && ship.isSailing) {
            ship._veynarSlowTimer = 4.0;
          }

          // Fire Shot — apply burn DoT to target
          if (ball.ammoType === AmmoType.FIRE && ship.isSailing) {
            const infernoDps = ball.owner._infernoPerk ?? 0;
            const extraDuration = infernoDps > 0 ? 3.0 : 0.0;
            ship._burnTimer  = (ship._burnTimer ?? 0) + 4.0 + extraDuration;
            ship._burnTimer  = Math.min(ship._burnTimer, 8 + extraDuration * 2);
            ship._burnDPS    = (ship._burnDPS ?? 0) + 4 + infernoDps;
            ship._burnDPS    = Math.min(ship._burnDPS, 12 + infernoDps);
          }

          // Impact effects based on ammo type
          if (ball.ammoType === AmmoType.FIRE) {
            this._impactFX.push(new FireBurst(this._scene, ball.mesh.position.clone()));
          } else if (ball.ammoType === AmmoType.CHAIN) {
            this._impactFX.push(new ChainBurst(this._scene, ball.mesh.position.clone()));
          } else if (ball.ammoType === AmmoType.CURSED_SPECTRAL) {
            this._spawnColorSmoke(ball.mesh.position, 6, 0x00ffcc);
            this._splashes.push(new WaterSplash(this._scene, ball.mesh.position.clone()));
          } else {
            this._spawnSmoke(ball.mesh.position, 4);
            this._splashes.push(new WaterSplash(this._scene, ball.mesh.position.clone()));
          }

          ball.dispose();
          this._balls.splice(i, 1);
          break;
        }
      }

      // Collision vs player-owned islands (enemy shots only)
      if (!ball._hitIsland && this._islands && ball.mesh.position.y < 9
          && ball.owner.faction !== 'PLAYER' && !ball.owner.isIsland) {
        for (const island of this._islands) {
          if (!island.captured || island.owner !== 'PLAYER') continue;
          if (dist2D(ball.mesh.position, island.position) < island.collisionRadius) {
            const dmg = (ball.owner.cannonPower ?? 20) + randRange(-4, 4);
            island.hp = Math.max(0, island.hp - dmg);

            // Alert toast at most once every 8 s per island
            const now = performance.now();
            if (!island._lastAlertMs || now - island._lastAlertMs > 8000) {
              island._lastAlertMs = now;
              EventEmitter.emit('island:under_attack', { island });
            }

            this._spawnSmoke(ball.mesh.position, 3);
            this._splashes.push(new WaterSplash(this._scene, ball.mesh.position.clone()));

            if (island.hp <= 0) {
              island.hp       = island.maxHp ?? 100;
              island.captured = false;
              island.owner    = null;
              this.spawnDeathExplosion(island.position.clone().setY(3));
              EventEmitter.emit('island:lost', { island });
            }

            ball.dispose();
            this._balls.splice(i, 1);
            break;
          }
        }
      }
    }

    // Update smoke particles
    for (let i = this._smoke.length - 1; i >= 0; i--) {
      this._smoke[i].update(delta);
      if (this._smoke[i].dead) {
        this._smoke[i].dispose();
        this._smoke.splice(i, 1);
      }
    }

    // Update muzzle flashes
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      this._flashes[i].update(delta);
      if (this._flashes[i].dead) {
        this._flashes[i].dispose();
        this._flashes.splice(i, 1);
      }
    }

    // Update water splashes
    for (let i = this._splashes.length - 1; i >= 0; i--) {
      this._splashes[i].update(delta);
      if (this._splashes[i].dead) {
        this._splashes[i].dispose();
        this._splashes.splice(i, 1);
      }
    }

    // Update death explosions
    for (let i = this._explosions.length - 1; i >= 0; i--) {
      this._explosions[i].update(delta);
      if (this._explosions[i].dead) {
        this._explosions[i].dispose();
        this._explosions.splice(i, 1);
      }
    }

    // Update impact FX (fire bursts, chain bursts)
    for (let i = this._impactFX.length - 1; i >= 0; i--) {
      this._impactFX[i].update(delta);
      if (this._impactFX[i].dead) {
        this._impactFX[i].dispose();
        this._impactFX.splice(i, 1);
      }
    }
  }

  _createAimLine(color) {
    const maxPoints = 25;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(maxPoints * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineDashedMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      dashSize: 0.8,
      gapSize: 0.4,
      scale: 1.0,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.visible = false;
    return line;
  }

  _createTargetRing(color) {
    const geometry = new THREE.RingGeometry(1.2, 1.8, 16);
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    return mesh;
  }

  updateAimingLines(ship, isAiming = false) {
    if (!isAiming || !ship || !ship.isAlive || !ship.isSailing) {
      if (this._aimLinePort) this._aimLinePort.visible = false;
      if (this._aimLineStarboard) this._aimLineStarboard.visible = false;
      if (this._targetRingPort) this._targetRingPort.visible = false;
      if (this._targetRingStarboard) this._targetRingStarboard.visible = false;
      return;
    }

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.group.quaternion);
    const base = ship.group.position.clone();
    base.y += 1.2;
    const cfg = AMMO_CONFIG[this.currentAmmo] ?? AMMO_CONFIG[AmmoType.ROUND];
    const speed = GameConfig.CANNONBALL_SPEED * cfg.speed;

    // Launch coordinates
    const posL = base.clone().addScaledVector(right, -2.5);
    const velL = right.clone().multiplyScalar(-speed).addScaledVector(ship.velocity, 0.5);

    const posR = base.clone().addScaledVector(right, 2.5);
    const velR = right.clone().multiplyScalar(speed).addScaledVector(ship.velocity, 0.5);

    const maxPoints = 25;
    const dt = 0.08;
    const gravityY = this.currentAmmo === AmmoType.CHAIN ? -2.8 : -4; // matches gravity in Cannonball update

    // Trace Port Line
    const pointsL = [];
    let impactL = null;
    const tempPosL = posL.clone();
    const tempVelL = velL.clone();
    for (let i = 0; i < maxPoints; i++) {
      pointsL.push(tempPosL.x, tempPosL.y, tempPosL.z);
      tempVelL.y += gravityY * dt;
      tempPosL.addScaledVector(tempVelL, dt);
      if (tempPosL.y < 0.1) {
        impactL = tempPosL.clone();
        for (let j = i + 1; j < maxPoints; j++) {
          pointsL.push(tempPosL.x, tempPosL.y, tempPosL.z);
        }
        break;
      }
    }
    if (!impactL) impactL = tempPosL.clone();

    // Trace Starboard Line
    const pointsR = [];
    let impactR = null;
    const tempPosR = posR.clone();
    const tempVelR = velR.clone();
    for (let i = 0; i < maxPoints; i++) {
      pointsR.push(tempPosR.x, tempPosR.y, tempPosR.z);
      tempVelR.y += gravityY * dt;
      tempPosR.addScaledVector(tempVelR, dt);
      if (tempPosR.y < 0.1) {
        impactR = tempPosR.clone();
        for (let j = i + 1; j < maxPoints; j++) {
          pointsR.push(tempPosR.x, tempPosR.y, tempPosR.z);
        }
        break;
      }
    }
    if (!impactR) impactR = tempPosR.clone();

    // Update geometry buffers
    if (this._aimLinePort) {
      const posAttr = this._aimLinePort.geometry.attributes.position;
      for (let i = 0; i < maxPoints; i++) {
        posAttr.setXYZ(i, pointsL[i * 3], pointsL[i * 3 + 1], pointsL[i * 3 + 2]);
      }
      posAttr.needsUpdate = true;
      this._aimLinePort.computeLineDistances();
      this._aimLinePort.visible = true;
    }

    if (this._aimLineStarboard) {
      const posAttr = this._aimLineStarboard.geometry.attributes.position;
      for (let i = 0; i < maxPoints; i++) {
        posAttr.setXYZ(i, pointsR[i * 3], pointsR[i * 3 + 1], pointsR[i * 3 + 2]);
      }
      posAttr.needsUpdate = true;
      this._aimLineStarboard.computeLineDistances();
      this._aimLineStarboard.visible = true;
    }

    // Update target rings positions on the water with simple pulsing animation
    const scale = 1.0 + Math.sin(performance.now() * 0.008) * 0.15;

    if (this._targetRingPort) {
      this._targetRingPort.position.set(impactL.x, 0.15, impactL.z);
      this._targetRingPort.scale.setScalar(scale);
      this._targetRingPort.visible = true;
    }

    if (this._targetRingStarboard) {
      this._targetRingStarboard.position.set(impactR.x, 0.15, impactR.z);
      this._targetRingStarboard.scale.setScalar(scale);
      this._targetRingStarboard.visible = true;
    }

    // Update colors based on cooldown and ammo type
    const isReady = ship.cannonCooldown <= 0;
    const ammoColors = {
      [AmmoType.ROUND]: { ready: 0x22ff55, loading: 0xff3333 },
      [AmmoType.CHAIN]: { ready: 0x44ccff, loading: 0x2266aa },
      [AmmoType.FIRE]:  { ready: 0xff8800, loading: 0xaa3300 },
    };
    const palette = ammoColors[this.currentAmmo] ?? ammoColors[AmmoType.ROUND];
    const color = isReady ? palette.ready : palette.loading;
    this._aimLinePort.material.color.setHex(color);
    this._aimLineStarboard.material.color.setHex(color);
    if (this._targetRingPort) this._targetRingPort.material.color.setHex(color);
    if (this._targetRingStarboard) this._targetRingStarboard.material.color.setHex(color);
  }
}


export default CombatSystem;
