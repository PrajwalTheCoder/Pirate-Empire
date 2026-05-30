/**
 * LootSystem — floating collectible objects (barrels, crates) on the ocean.
 *
 * Loot bobs on the waves and is collected by sailing close to it.
 * On collection the player receives a random reward of gold / wood / crew.
 */
import * as THREE from 'three';
import AssetLoader from './AssetLoader.js';
import EventEmitter from '../utils/EventEmitter.js';

// Reward tables
const REWARDS = [
  { gold: 80,  wood: 0,  crew: 0 },
  { gold: 0,   wood: 60, crew: 0 },
  { gold: 40,  wood: 30, crew: 0 },
  { gold: 0,   wood: 0,  crew: 2 },
  { gold: 120, wood: 0,  crew: 1 },
  { gold: 60,  wood: 60, crew: 0 },
];

const LOOT_MODELS  = ['barrel', 'crate', 'crate-bottles', 'chest'];
const COLLECT_DIST = 10;   // units
const LOOT_COUNT   = 22;
const RESPAWN_DELAY = 18;  // seconds before a new loot piece spawns

class LootPiece {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} pos
   * @param {string} modelKey
   * @param {number} rewardIdx
   */
  constructor(scene, pos, modelKey, rewardIdx) {
    this._scene     = scene;
    this.reward     = REWARDS[rewardIdx];
    this.collected  = false;
    this._bobOffset = Math.random() * Math.PI * 2;
    this._time      = 0;

    // Clone model
    const src = AssetLoader.get(modelKey);
    if (src) {
      this.group = src;
      this.group.scale.setScalar(1.0);
      // Ensure shadows
      this.group.traverse(c => { if (c.isMesh) { c.castShadow = true; } });
    } else {
      // Fallback cube
      this.group = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1.5, 1.5),
        new THREE.MeshLambertMaterial({ color: 0x8B4513 })
      );
    }
    this.group.position.copy(pos);
    scene.add(this.group);

    // Gold glow ring below the loot — pulsing disc so it's easy to spot
    const ringGeo = new THREE.RingGeometry(1.2, 2.2, 20);
    this._ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color:       0xffd700,
      transparent: true,
      opacity:     0.55,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    }));
    this._ring.rotation.x = -Math.PI / 2;
    scene.add(this._ring);

    // Gentle random spin direction
    this._spinSpeed = (Math.random() - 0.5) * 0.4;
  }

  /**
   * @param {number} delta
   * @param {import('../world/Ocean.js').Ocean} ocean
   */
  update(delta, ocean) {
    if (this.collected) return;
    this._time += delta;

    const x = this.group.position.x;
    const z = this.group.position.z;
    const wh = ocean.getHeightAt(x, z);

    this.group.position.y = wh + 1.0;
    // Gentle rocking
    this.group.rotation.z = Math.sin(this._time * 0.8 + this._bobOffset) * 0.15;
    this.group.rotation.x = Math.cos(this._time * 0.6 + this._bobOffset) * 0.10;
    this.group.rotation.y += this._spinSpeed * delta;

    // Pulse the glow ring at water level
    const pulse = 0.35 + 0.20 * Math.sin(this._time * 3.0);
    this._ring.material.opacity = pulse;
    const rs = 1.0 + 0.15 * Math.sin(this._time * 2.5);
    this._ring.scale.setScalar(rs);
    this._ring.position.set(x, wh + 0.15, z);
  }

  dispose() {
    this._scene.remove(this.group);
    this._scene.remove(this._ring);
    this._ring.geometry.dispose();
    this._ring.material.dispose();
  }
}

// ── LootSystem ──────────────────────────────────────────────────────────────

export class LootSystem {
  /**
   * @param {THREE.Scene}  scene
   * @param {object[]}     islands   island data array
   * @param {object}       economy   EconomySystem instance
   * @param {import('../world/Ocean.js').Ocean} ocean
   * @param {number}       worldSize half-extent of the world
   */
  constructor(scene, islands, economy, ocean, worldSize = 1400) {
    this._scene     = scene;
    this._islands   = islands;
    this._economy   = economy;
    this._ocean     = ocean;
    this._worldSize = worldSize;
    this._pieces    = [];
    this._respawnTimer = 0;

    // Spawn initial batch
    for (let i = 0; i < LOOT_COUNT; i++) {
      this._spawnOne();
    }
  }

  _randomPos() {
    const half  = this._worldSize;
    const tries = 30;
    for (let i = 0; i < tries; i++) {
      const x = (Math.random() - 0.5) * half * 2;
      const z = (Math.random() - 0.5) * half * 2;

      // Keep away from island centres
      let tooClose = false;
      for (const island of this._islands) {
        const dx = x - island.position.x;
        const dz = z - island.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < 40) { tooClose = true; break; }
      }
      if (!tooClose) return new THREE.Vector3(x, 0, z);
    }
    // Fallback — just use random position
    return new THREE.Vector3(
      (Math.random() - 0.5) * half * 1.6,
      0,
      (Math.random() - 0.5) * half * 1.6
    );
  }

  _spawnOne() {
    const pos      = this._randomPos();
    const model    = LOOT_MODELS[Math.floor(Math.random() * LOOT_MODELS.length)];
    const rewardI  = Math.floor(Math.random() * REWARDS.length);
    this._pieces.push(new LootPiece(this._scene, pos, model, rewardI));
  }

  /**
   * @param {number}       delta
   * @param {THREE.Vector3} playerPos
   */
  update(delta, playerPos) {
    let aliveCount = 0;

    for (const p of this._pieces) {
      if (p.collected) continue;

      p.update(delta, this._ocean);

      // Check collection
      const dx = playerPos.x - p.group.position.x;
      const dz = playerPos.z - p.group.position.z;
      if (Math.sqrt(dx * dx + dz * dz) < COLLECT_DIST) {
        p.collected = true;
        p.dispose();

        // Grant reward
        const r = p.reward;
        if (r.gold)  this._economy.add('gold', r.gold);
        if (r.wood)  this._economy.add('wood', r.wood);
        if (r.crew)  this._economy.add('crew', r.crew);

        // Toast notification
        EventEmitter.emit('loot:collected', r);
        continue;
      }

      aliveCount++;
    }

    // Remove fully spent entries
    if (this._pieces.some(p => p.collected)) {
      this._pieces = this._pieces.filter(p => !p.collected);
    }

    // Respawn if below target
    if (aliveCount < LOOT_COUNT) {
      this._respawnTimer += delta;
      if (this._respawnTimer >= RESPAWN_DELAY) {
        this._respawnTimer = 0;
        this._spawnOne();
      }
    }
  }
}

export default LootSystem;
