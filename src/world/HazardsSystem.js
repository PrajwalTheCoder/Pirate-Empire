/**
 * HazardsSystem — scatters world hazards that make the ocean feel dangerous.
 *
 * Hazard types
 * ─────────────
 *  ☠  Shipwrecks        — ship-wreck model, tilted & half-sunk, optional mast
 *  ⚓  Abandoned boats   — boat-row-small (1-2 per cluster), bobbing gently
 *  🪨  Dangerous rocks   — rocks-a/b/c clusters rising out of the water,
 *                          some with white foam around their base
 *
 * Navigation impact
 *  All hazard meshes have a `collisionRadius` stored on their userData so that
 *  other systems (AI, future player collision feedback) can query them.
 *  The HazardsSystem exposes `getHazards()` returning an array of
 *  `{ mesh, collisionRadius, type, bobPhase }` objects — boats and wrecks bob
 *  on the wave surface each frame.
 */

import * as THREE   from 'three';
import AssetLoader  from '../systems/AssetLoader.js';
import GameConfig   from '../config/GameConfig.js';
import { randRange, randInt } from '../utils/MathUtils.js';

// ── Helper: pick a position far from islands and origin ────────────────────
function pickOpenPosition(half, islands, minIslandClear, existingPositions, minHazardGap) {
  const MAX_TRIES = 300;
  for (let t = 0; t < MAX_TRIES; t++) {
    const x = randRange(-half, half);
    const z = randRange(-half, half);

    // Keep clear of spawn point
    if (x * x + z * z < 100 * 100) continue;

    // Keep clear of islands
    const nearIsland = islands.some(isl => {
      const dx = isl.position.x - x;
      const dz = isl.position.z - z;
      return dx * dx + dz * dz < minIslandClear * minIslandClear;
    });
    if (nearIsland) continue;

    // Keep clear of other hazards
    const nearHazard = existingPositions.some(p => {
      const dx = p.x - x, dz = p.z - z;
      return dx * dx + dz * dz < minHazardGap * minHazardGap;
    });
    if (nearHazard) continue;

    return { x, z };
  }
  return null;
}

export class HazardsSystem {
  /**
   * @param {THREE.Scene}  scene
   * @param {IslandData[]} islands
   */
  constructor(scene, islands) {
    this._scene   = scene;
    this._islands = islands;
    this._time    = 0;

    /**
     * @type {Array<{
     *   mesh: THREE.Object3D,
     *   type: 'wreck'|'boat'|'rock',
     *   collisionRadius: number,
     *   bobPhase: number,
     *   bobAmp: number,
     *   baseY: number,
     * }>}
     */
    this._hazards = [];

    this._scatter();
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** @returns {typeof this._hazards} */
  getHazards() { return this._hazards; }

  /** @param {number} delta */
  update(delta) {
    this._time += delta;
    const t = this._time;

    for (const h of this._hazards) {
      if (h.type === 'rock') continue; // rocks don't bob

      // Bob on ocean surface — simple sine approximating wave height at pos
      const wx = h.mesh.position.x;
      const wz = h.mesh.position.z;
      const wave =
        Math.sin(wx * 0.05 + t * 1.2 + h.bobPhase) * 0.6 +
        Math.cos(wz * 0.04 + t * 0.9 + h.bobPhase) * 0.5 +
        Math.sin((wx + wz) * 0.03 + t * 0.7) * 0.3;
      h.mesh.position.y = h.baseY + wave * h.bobAmp;

      // Gentle roll on the waves
      h.mesh.rotation.z = Math.sin(t * 0.6 + h.bobPhase) * 0.04;
      h.mesh.rotation.x = Math.cos(t * 0.5 + h.bobPhase) * 0.03;
    }
  }

  // ── Private: scatter all hazards on construction ──────────────────────────

  _scatter() {
    const half          = GameConfig.WORLD_SIZE / 2 - 60;
    const placed        = [];   // { x, z } registry to avoid overlap

    this._scatterWrecks(half, placed);
    this._scatterBoats(half, placed);
    this._scatterRocks(half, placed);
  }

  // ── Shipwrecks ─────────────────────────────────────────────────────────────

  _scatterWrecks(half, placed) {
    const count = 8;
    for (let i = 0; i < count; i++) {
      const pos = pickOpenPosition(half, this._islands, 80, placed, 55);
      if (!pos) continue;
      placed.push(pos);

      const group = new THREE.Group();
      group.position.set(pos.x, 0, pos.z);
      group.rotation.y = randRange(0, Math.PI * 2);

      // Main wreck hull — half-submerged
      const hull = AssetLoader.get('ship-wreck');
      const hullScale = randRange(0.8, 1.3);
      hull.scale.setScalar(hullScale);
      // Tilt dramatically as if sinking
      hull.rotation.z = randRange(0.2, 0.55);    // list to one side
      hull.rotation.x = randRange(-0.12, 0.12);  // bow-up or stern-up
      hull.position.y = -0.6 * hullScale;        // partially sunk
      group.add(hull);

      // Broken mast stump 50% of the time
      if (Math.random() > 0.5) {
        const mast = this._makeMastStump();
        mast.position.set(
          randRange(-0.8, 0.8) * hullScale,
          0.5 * hullScale,
          randRange(-1.5, 0.5) * hullScale,
        );
        mast.rotation.z = hull.rotation.z + randRange(-0.3, 0.3);
        group.add(mast);
      }

      // Scattered debris around the wreck
      const debrisCount = randInt(2, 5);
      for (let d = 0; d < debrisCount; d++) {
        const debModel = randRange(0, 1) > 0.5
          ? AssetLoader.get('barrel')
          : AssetLoader.get('crate');
        debModel.scale.setScalar(randRange(0.5, 0.9));
        debModel.position.set(
          randRange(-6, 6) * hullScale,
          randRange(-0.3, 0.1),
          randRange(-6, 6) * hullScale,
        );
        debModel.rotation.y = randRange(0, Math.PI * 2);
        debModel.rotation.z = randRange(-0.4, 0.4);
        group.add(debModel);
      }

      // Foam ring at waterline
      const foam = this._makeWaterFoam(2.5 * hullScale);
      group.add(foam);

      this._scene.add(group);
      this._hazards.push({
        mesh: group,
        type: 'wreck',
        collisionRadius: 8 * hullScale,
        bobPhase: Math.random() * Math.PI * 2,
        bobAmp: 0.25,
        baseY: 0,
      });
    }
  }

  // ── Abandoned rowing boats ──────────────────────────────────────────────────

  _scatterBoats(half, placed) {
    // Spawn in clusters of 1-2 boats close together
    const clusterCount = 10;
    for (let c = 0; c < clusterCount; c++) {
      const pos = pickOpenPosition(half, this._islands, 65, placed, 40);
      if (!pos) continue;
      placed.push(pos);

      const boatsInCluster = randInt(1, 3);
      for (let b = 0; b < boatsInCluster; b++) {
        const boat = AssetLoader.get('boat-row-small');
        const sc   = randRange(0.7, 1.1);
        boat.scale.setScalar(sc);

        const bx = pos.x + randRange(-8, 8);
        const bz = pos.z + randRange(-8, 8);
        boat.position.set(bx, 0, bz);
        boat.rotation.y = randRange(0, Math.PI * 2);

        // Some boats are overturned
        if (Math.random() > 0.65) {
          boat.rotation.z = Math.PI + randRange(-0.2, 0.2);
          boat.position.y = -0.15;
        }

        // Occasional oar floating beside
        if (Math.random() > 0.6) {
          const oar = this._makeOar();
          oar.position.set(
            bx + randRange(-2, 2),
            0.05,
            bz + randRange(-1, 1),
          );
          oar.rotation.y = randRange(0, Math.PI * 2);
          this._scene.add(oar);
        }

        this._scene.add(boat);
        this._hazards.push({
          mesh: boat,
          type: 'boat',
          collisionRadius: 3.5 * sc,
          bobPhase: Math.random() * Math.PI * 2,
          bobAmp: 0.45,
          baseY: 0,
        });
      }
    }
  }

  // ── Dangerous rocks ────────────────────────────────────────────────────────

  _scatterRocks(half, placed) {
    const groupCount = 18;
    const rockModels = ['rocks-a', 'rocks-b', 'rocks-c', 'rocks-sand-a'];

    for (let g = 0; g < groupCount; g++) {
      const pos = pickOpenPosition(half, this._islands, 55, placed, 35);
      if (!pos) continue;
      placed.push(pos);

      const rockGroup = new THREE.Group();
      rockGroup.position.set(pos.x, 0, pos.z);
      rockGroup.rotation.y = randRange(0, Math.PI * 2);

      // 2-5 rocks in a cluster, varying height (how far they jut above water)
      const rockCountInGroup = randInt(2, 5);
      let maxRadius = 0;

      for (let r = 0; r < rockCountInGroup; r++) {
        const key  = rockModels[Math.floor(Math.random() * rockModels.length)];
        const rock = AssetLoader.get(key);
        const sc   = randRange(0.6, 1.8);
        rock.scale.setScalar(sc);

        const angle  = randRange(0, Math.PI * 2);
        const radius = randRange(0, 5);
        const rx     = Math.cos(angle) * radius;
        const rz     = Math.sin(angle) * radius;

        // Vertical offset — some rocks barely peek above water, some tower up
        const yOffset = randRange(-0.4, 0.8) * sc;
        rock.position.set(rx, yOffset, rz);
        rock.rotation.y = randRange(0, Math.PI * 2);
        rockGroup.add(rock);

        maxRadius = Math.max(maxRadius, radius + sc * 2);
      }

      // White foam ring at base of rock formation
      if (Math.random() > 0.35) {
        const foam = this._makeWaterFoam(maxRadius * 0.9 + 1.5);
        rockGroup.add(foam);
      }

      this._scene.add(rockGroup);
      this._hazards.push({
        mesh: rockGroup,
        type: 'rock',
        collisionRadius: maxRadius + 2,
        bobPhase: 0,
        bobAmp: 0,
        baseY: 0,
      });
    }
  }

  // ── Helper meshes ──────────────────────────────────────────────────────────

  /** A broken mast stump made from a cylinder. */
  _makeMastStump() {
    const geo  = new THREE.CylinderGeometry(0.12, 0.18, randRange(1.5, 3.5), 6);
    const mat  = new THREE.MeshLambertMaterial({ color: 0x6b3a1f });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
  }

  /** A very thin box representing a floating oar. */
  _makeOar() {
    const geo  = new THREE.BoxGeometry(0.08, 0.06, 1.8);
    const mat  = new THREE.MeshLambertMaterial({ color: 0x8b5e3c });
    return new THREE.Mesh(geo, mat);
  }

  /**
   * A flat animated foam ring sitting at y≈0 — communicates "rocks/hazard here".
   * @param {number} radius
   */
  _makeWaterFoam(radius) {
    const geo = new THREE.RingGeometry(radius * 0.6, radius, 28);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xddeeff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.05;
    return mesh;
  }
}

export default HazardsSystem;
