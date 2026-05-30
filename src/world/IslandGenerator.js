/**
 * IslandGenerator — procedurally places islands across the world.
 *
 * Each island is a GROUP containing:
 *   - patch-sand base
 *   - palm trees (InstancedMesh per palm type)
 *   - rocks
 *   - chest or crate prop
 *   - optional fortification (tower + cannon + flag)
 */
import * as THREE    from 'three';
import AssetLoader   from '../systems/AssetLoader.js';
import GameConfig    from '../config/GameConfig.js';
import { randRange, randInt, randChoice, dist2D } from '../utils/MathUtils.js';

export class IslandGenerator {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this._scene   = scene;
    /** @type {IslandData[]} */
    this.islands  = [];
  }

  /**
   * Generate all islands.
   * @returns {IslandData[]}
   */
  generate() {
    const count         = GameConfig.ISLAND_COUNT;
    const fortifiedCount = GameConfig.FORTIFIED_ISLAND_COUNT;
    const half          = GameConfig.WORLD_SIZE / 2 - 100;
    const minDist       = GameConfig.ISLAND_MIN_DISTANCE;

    const positions = [];

    // Poisson-disk-like placement: reject if too close to existing island or center spawn point
    let attempts = 0;
    while (positions.length < count && attempts < 2000) {
      attempts++;
      const x = randRange(-half, half);
      const z = randRange(-half, half);
      
      // Prevent spawning islands in the center starting area (within 100 units of 0,0)
      if (x * x + z * z < 100 * 100) continue;

      const tooClose = positions.some(p => {
        const dx = p.x - x, dz = p.z - z;
        return Math.sqrt(dx * dx + dz * dz) < minDist;
      });
      if (!tooClose) positions.push({ x, z });
    }

    // Shuffle and mark the first N as fortified
    positions.sort(() => Math.random() - 0.5);

    positions.forEach((pos, i) => {
      const fortified = i < fortifiedCount;
      const island    = this._buildIsland(i, pos.x, pos.z, fortified);
      this.islands.push(island);
    });

    return this.islands;
  }

  // ── Island construction ────────────────────────────────────────────────────

  _buildIsland(id, x, z, fortified) {
    const group = new THREE.Group();
    group.name  = `island_${id}`;
    group.position.set(x, 3, z);  // raise above sea level so waves never submerge islands

    // ── Sand base ────────────────────────────────────────────────────────────
    const sandScale = randRange(1.5, 3.0);
    // The Kenney patch-sand model surface sits at ~0.5 * sandScale in local space.
    // Every prop placed on the island must use this as its Y baseline so nothing
    // sinks into the sand.
    const sy = sandScale * 0.5;

    const sand = AssetLoader.get('patch-sand');
    sand.scale.setScalar(sandScale);
    group.add(sand);

    // Optionally add a grass patch on top
    if (Math.random() > 0.4) {
      const grass = AssetLoader.get('patch-grass');
      grass.scale.setScalar(sandScale * 0.7);
      grass.position.set(
        randRange(-2, 2),
        sy,
        randRange(-2, 2),
      );
      group.add(grass);
    }

    // ── Palm trees ───────────────────────────────────────────────────────────
    const palmCount = randInt(2, 5);
    const palmTypes = ['palm-straight', 'palm-bend', 'palm-detailed-straight'];

    for (let i = 0; i < palmCount; i++) {
      const palm = AssetLoader.get(randChoice(palmTypes));
      const angle = randRange(0, Math.PI * 2);
      const radius = randRange(3, 6) * sandScale * 0.5;
      palm.position.set(
        Math.cos(angle) * radius,
        sy,
        Math.sin(angle) * radius,
      );
      palm.rotation.y = randRange(0, Math.PI * 2);
      palm.scale.setScalar(randRange(0.8, 1.3));
      group.add(palm);
    }

    // ── Rocks ────────────────────────────────────────────────────────────────
    const rockCount = randInt(1, 4);
    const rockTypes = ['rocks-a', 'rocks-b', 'rocks-c', 'rocks-sand-a'];

    for (let i = 0; i < rockCount; i++) {
      const rock  = AssetLoader.get(randChoice(rockTypes));
      const angle = randRange(0, Math.PI * 2);
      const radius = randRange(2, 7) * sandScale * 0.4;
      rock.position.set(
        Math.cos(angle) * radius,
        sy,
        Math.sin(angle) * radius,
      );
      rock.rotation.y = randRange(0, Math.PI * 2);
      rock.scale.setScalar(randRange(0.6, 1.1));
      group.add(rock);
    }

    // ── Loot prop (chest or crate) ────────────────────────────────────────────
    const lootKey = Math.random() > 0.4 ? 'chest' : 'crate';
    const loot    = AssetLoader.get(lootKey);
    loot.position.set(randRange(-2, 2), sy, randRange(-2, 2));
    loot.rotation.y = randRange(0, Math.PI * 2);
    group.add(loot);

    // ── Barrel decoration ────────────────────────────────────────────────────
    if (Math.random() > 0.5) {
      const barrel = AssetLoader.get('barrel');
      barrel.position.set(randRange(-3, 3), sy, randRange(-3, 3));
      barrel.rotation.y = randRange(0, Math.PI * 2);
      group.add(barrel);
    }

    // ── Fortification ────────────────────────────────────────────────────────
    /** @type {string[]} */
    const buildings = [];
    let cannonMesh = null;

    if (fortified) {
      // Watch tower
      const tower = AssetLoader.get('tower-complete-small');
      tower.position.set(0, sy, -sandScale * 2.5);
      tower.scale.setScalar(0.9);
      group.add(tower);
      buildings.push('WATCH_TOWER');

      // Pirate flag on tower
      const flag = AssetLoader.get('flag-pirate-high');
      flag.position.set(0, sy + 5, -sandScale * 2.5);
      flag.scale.setScalar(0.8);
      group.add(flag);

      // Cannon
      const cannon = AssetLoader.get('cannon');
      cannon.position.set(sandScale * 1.5, sy, 0);
      cannon.rotation.y = -Math.PI / 2;
      group.add(cannon);
      buildings.push('DEFENSE_CANNON');
      cannonMesh = cannon;
    }

    this._scene.add(group);

    /** @type {IslandData} */
    const data = {
      id,
      position: new THREE.Vector3(x, 0, z),
      collisionRadius: sandScale * 5,
      group,
      sandScale,
      surfaceY: sy,
      fortified,
      captured: false,
      owner: fortified ? 'PIRATES' : null,
      buildings,
      passiveTimer: 0,
      cannonMesh,       // THREE.Object3D | null
      cannonCooldown: 0,
      hp: 100,
      maxHp: 100,
      // Build slots: placed at island edge (sandScale-proportional radius),
      // y = sy so buildings sit on the sand surface.
      buildSlots: [
        new THREE.Vector3( sandScale * 2.2, sy,              0),   // East
        new THREE.Vector3(-sandScale * 2.2, sy,              0),   // West
        new THREE.Vector3(              0,  sy,  sandScale * 2.2),  // South
        new THREE.Vector3(              0,  sy, -sandScale * 3.0),  // North
        new THREE.Vector3( sandScale * 1.7, sy,  sandScale * 1.7),  // SE
        new THREE.Vector3(-sandScale * 1.7, sy, -sandScale * 1.7),  // NW
      ],
      nextBuildSlot: fortified ? 2 : 0,
    };

    return data;
  }
}

/**
 * @typedef {Object} IslandData
 * @property {number}         id
 * @property {THREE.Vector3}  position
 * @property {number}         collisionRadius
 * @property {THREE.Group}    group
 * @property {boolean}        fortified
 * @property {boolean}        captured
 * @property {string|null}    owner
 * @property {string[]}       buildings
 * @property {number}         passiveTimer
 * @property {THREE.Vector3[]} buildSlots
 * @property {number}         nextBuildSlot
 */

export default IslandGenerator;
