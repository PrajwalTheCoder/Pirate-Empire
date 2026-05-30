/**
 * WakeSystem — spawns foam/wake sprites and bioluminescent bubble glows
 * behind moving ships.
 *
 * Option C upgrade:
 *   - Foam wake patches spread and fade as before
 *   - New BioGlowPatch: small cyan/teal emissive dots that flicker and fade,
 *     simulating ocean bioluminescence churned up by the hull
 */
import * as THREE from 'three';
import { randRange } from '../utils/MathUtils.js';

// ─── Foam Wake Patch ───────────────────────────────────────────────────────────
const _foamGeo = new THREE.PlaneGeometry(1, 1);
_foamGeo.rotateX(-Math.PI / 2);

class WakePatch {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} position
   */
  constructor(scene, position) {
    this.scene    = scene;
    this.age      = 0;
    this.lifetime = 2.5;

    const mat = new THREE.MeshBasicMaterial({
      color:       0xd0eeff,
      transparent: true,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(_foamGeo, mat);
    this.mesh.position.copy(position);
    this.mesh.position.y += 0.05;
    this.mesh.rotation.y = Math.random() * Math.PI;
    scene.add(this.mesh);
  }

  update(delta) {
    this.age += delta;
    const t = this.age / this.lifetime;
    const scale = 3 + t * 10;
    this.mesh.scale.set(scale, 1, scale * 0.4);
    this.mesh.material.opacity = Math.max(0, (1 - t) * 0.55);
  }

  get dead() { return this.age >= this.lifetime; }
  dispose()  { this.scene.remove(this.mesh); }
}

// ─── Bio-Glow Patch (Option C) ─────────────────────────────────────────────────
/**
 * A small cluster of bioluminescent emissive spheres that glow cyan/teal,
 * flickering and drifting behind the hull before fading out.
 * Only spawned at moderate-to-high ship speeds to look natural.
 */
class BioGlowPatch {
  constructor(scene, position, isPlayer = false, colorOverride = null) {
    this.scene    = scene;
    this.age      = 0;
    this.lifetime = 1.8 + Math.random() * 0.8;
    this._drops   = [];

    const count     = isPlayer ? 5 : 3;
    const baseColor = colorOverride !== null ? colorOverride : (isPlayer ? 0x00ffcc : 0x00ccaa);

    for (let i = 0; i < count; i++) {
      const size = 0.06 + Math.random() * 0.10;
      const geo  = new THREE.SphereGeometry(size, 4, 4);
      const mat  = new THREE.MeshBasicMaterial({
        color:       baseColor,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position).add(new THREE.Vector3(
        randRange(-1.2, 1.2),
        0.04,
        randRange(-0.6, 0.6),
      ));
      scene.add(mesh);

      // Store individual phase offset for flicker
      this._drops.push({
        mesh,
        phase:   Math.random() * Math.PI * 2,
        speed:   4 + Math.random() * 3,
        driftX:  randRange(-0.15, 0.15),
        driftZ:  randRange(-0.08, 0.08),
        peakOp:  isPlayer ? 0.65 : 0.42,
      });
    }
  }

  update(delta) {
    this.age += delta;
    const tLife = this.age / this.lifetime;

    for (const d of this._drops) {
      d.phase += d.speed * delta;

      // Envelope: ramp up fast (0-15%), hold, then fade out
      let env;
      if (tLife < 0.15) {
        env = tLife / 0.15;
      } else {
        env = 1 - ((tLife - 0.15) / 0.85);
      }

      // Flicker via sin wave modulated by envelope
      const flicker = 0.5 + 0.5 * Math.sin(d.phase);
      d.mesh.material.opacity = Math.max(0, d.peakOp * env * flicker);

      // Gentle drift / spread outward
      d.mesh.position.x += d.driftX * delta;
      d.mesh.position.z += d.driftZ * delta;
    }
  }

  get dead() { return this.age >= this.lifetime; }
  dispose()  { for (const d of this._drops) this.scene.remove(d.mesh); }
}

// ─── Bow Spray Droplet (Option C — enhanced) ───────────────────────────────────
/**
 * Extra bow-spray particle spawned at the very tip of the bow so there's always
 * a visible splash at the ship's nose when sailing fast. WakeSystem creates these
 * when speed is high enough, independent of the ShipSystem's internal spray.
 */
class BowSpray {
  constructor(scene, position, right) {
    this.scene    = scene;
    this.age      = 0;
    this.lifetime = 0.55 + Math.random() * 0.35;
    this._drops   = [];

    for (let i = 0; i < 4; i++) {
      const geo = new THREE.SphereGeometry(0.09 + Math.random() * 0.08, 4, 3);
      const mat = new THREE.MeshBasicMaterial({
        color:       0xddf4ff,
        transparent: true,
        opacity:     0.8,
        depthWrite:  false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position).add(new THREE.Vector3(
        randRange(-0.4, 0.4), 0.3, randRange(-0.2, 0.2)
      ));
      // Spray left or right from bow
      const side = (i % 2 === 0 ? 1 : -1);
      const spd  = 1.5 + Math.random() * 2.5;
      scene.add(mesh);
      this._drops.push({
        mesh,
        vel: new THREE.Vector3(
          right.x * side * spd + randRange(-0.4, 0.4),
          1.2 + Math.random() * 1.2,
          right.z * side * spd + randRange(-0.4, 0.4),
        ),
      });
    }
  }

  update(delta) {
    this.age += delta;
    const t = this.age / this.lifetime;
    for (const d of this._drops) {
      d.vel.y -= 8 * delta;
      d.mesh.position.addScaledVector(d.vel, delta);
      d.mesh.material.opacity = Math.max(0, 0.8 * (1 - t));
    }
  }

  get dead() { return this.age >= this.lifetime; }
  dispose()  { for (const d of this._drops) this.scene.remove(d.mesh); }
}

// ── WakeSystem ──────────────────────────────────────────────────────────────────

export class WakeSystem {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this._scene   = scene;
    /** @type {WakePatch[]} */
    this._patches   = [];
    /** @type {BioGlowPatch[]} */
    this._bioGlows  = [];
    /** @type {BowSpray[]} */
    this._bowSprays = [];

    // Per-ship last-spawn position
    this._posCache = new Map();
  }

  /**
   * Call each frame for every moving ship.
   * @param {import('./ShipSystem.js').Ship} ship
   * @param {number} delta
   */
  notifyShip(ship, delta) {
    const speed = ship.velocity.length();
    if (speed < 0.3) return;

    const pos     = ship.group.position;
    const lastPos = this._posCache.get(ship.id);

    if (lastPos) {
      const dx = pos.x - lastPos.x;
      const dz = pos.z - lastPos.z;
      if (dx * dx + dz * dz < 3.5) return;  // only spawn every ~1.9 units
    }
    this._posCache.set(ship.id, pos.clone());

    const isPlayer = ship.faction === 'PLAYER';

    // Stern position (behind the ship)
    const back = new THREE.Vector3(0, 0, 2).applyQuaternion(ship.group.quaternion);
    const sternPos = pos.clone().add(back).setY(pos.y + 0.05);

    // ── Foam wake patch ───────────────────────────────────────────────────────
    this._patches.push(new WakePatch(this._scene, sternPos));

    // ── Bio-glow patch (Option C) ─────────────────────────────────────────────
    // Only above speed threshold so it looks natural (no glow at low drift)
    if (speed > 1.2) {
      let colorOverride = null;
      if (ship.faction === 'GHOST_FLEET' || ship.group.name?.toLowerCase().includes('ghost') || ship.group.name?.toLowerCase().includes('veynar')) {
        colorOverride = 0x00ff77; // Spectral Emerald Green
      } else if (isPlayer && window.__game?._joinedBlackFleet) {
        colorOverride = 0xff1111; // Blood Moon Crimson Red
      }
      this._bioGlows.push(new BioGlowPatch(this._scene, sternPos.clone(), isPlayer, colorOverride));
    }

    // ── Bow spray (Option C enhanced) — only fast ships ──────────────────────
    if (speed > 3.0 && isPlayer) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.group.quaternion);
      const right   = new THREE.Vector3(1, 0,  0).applyQuaternion(ship.group.quaternion);
      const bowPos  = pos.clone().addScaledVector(forward, 4.5).setY(pos.y + 0.5);
      this._bowSprays.push(new BowSpray(this._scene, bowPos, right));
    }
  }

  /** @param {number} delta */
  update(delta) {
    for (let i = this._patches.length - 1; i >= 0; i--) {
      this._patches[i].update(delta);
      if (this._patches[i].dead) {
        this._patches[i].dispose();
        this._patches.splice(i, 1);
      }
    }

    for (let i = this._bioGlows.length - 1; i >= 0; i--) {
      this._bioGlows[i].update(delta);
      if (this._bioGlows[i].dead) {
        this._bioGlows[i].dispose();
        this._bioGlows.splice(i, 1);
      }
    }

    for (let i = this._bowSprays.length - 1; i >= 0; i--) {
      this._bowSprays[i].update(delta);
      if (this._bowSprays[i].dead) {
        this._bowSprays[i].dispose();
        this._bowSprays.splice(i, 1);
      }
    }
  }
}

export default WakeSystem;
