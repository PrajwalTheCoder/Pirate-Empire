/**
 * BirdSystem — simple seagulls that circle islands.
 *
 * Each bird is a tiny V-shaped mesh that banks and bobs along an elliptical
 * orbit around its home island. No physics — pure parametric motion.
 */
import * as THREE from 'three';

// Build a simple V-shaped "gull" from two thin boxes
function makeBird() {
  const group = new THREE.Group();
  const mat   = new THREE.MeshLambertMaterial({ color: 0xf0f0f0 });

  // Left wing
  const wGeo = new THREE.BoxGeometry(1.2, 0.08, 0.3);
  const wL   = new THREE.Mesh(wGeo, mat);
  wL.position.set(-0.6, 0, 0);
  wL.rotation.z =  0.25;   // slight dihedral
  group.add(wL);

  // Right wing
  const wR = new THREE.Mesh(wGeo, mat);
  wR.position.set( 0.6, 0, 0);
  wR.rotation.z = -0.25;
  group.add(wR);

  // Body
  const bGeo = new THREE.BoxGeometry(0.2, 0.12, 0.6);
  group.add(new THREE.Mesh(bGeo, mat));

  return group;
}

class Bird {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} islandPos  XZ centre of the home island
   */
  constructor(scene, islandPos) {
    this._scene = scene;
    this._home  = islandPos.clone();
    this._home.y = 0;

    // Random orbit parameters
    this._radiusX  = 15 + Math.random() * 20;
    this._radiusZ  = 12 + Math.random() * 16;
    this._phase    = Math.random() * Math.PI * 2;
    this._speed    = 0.4 + Math.random() * 0.3;   // rad/s
    this._altitude = 8  + Math.random() * 10;
    this._bobAmp   = 0.6 + Math.random() * 0.8;
    this._bobFreq  = 1.5 + Math.random() * 1.0;
    this._time     = Math.random() * 100;

    // Wing flap timer
    this._flapPhase = Math.random() * Math.PI * 2;
    this._flapFreq  = 2.5 + Math.random() * 1.5;

    this.group = makeBird();
    this.group.scale.setScalar(0.55);
    scene.add(this.group);
  }

  update(delta) {
    this._time += delta;

    const angle = this._phase + this._time * this._speed;

    // Elliptical orbit in XZ
    const x = this._home.x + Math.cos(angle) * this._radiusX;
    const z = this._home.z + Math.sin(angle) * this._radiusZ;
    const y = this._altitude + Math.sin(this._time * this._bobFreq) * this._bobAmp;

    this.group.position.set(x, y, z);

    // Face direction of travel (tangent of ellipse)
    const tx = -Math.sin(angle) * this._radiusX;
    const tz =  Math.cos(angle) * this._radiusZ;
    this.group.rotation.y = Math.atan2(tx, tz);

    // Wing flap — rock the whole group on X
    const flapAngle = 0.18 * Math.sin(this._time * this._flapFreq * Math.PI * 2);
    this.group.rotation.z = flapAngle;

    // Gentle bank into turns
    this.group.rotation.x = 0.12 * Math.cos(angle + 0.5);
  }

  dispose() { this._scene.remove(this.group); }
}

// ── BirdSystem ──────────────────────────────────────────────────────────────

export class BirdSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/IslandGenerator.js').IslandData[]} islands
   */
  constructor(scene, islands) {
    this._birds = [];

    // Spawn 2–4 birds per island, but cap total at 48 for performance
    let total = 0;
    for (const island of islands) {
      if (total >= 48) break;
      const count = 2 + Math.floor(Math.random() * 3);   // 2, 3, or 4
      for (let i = 0; i < count; i++) {
        this._birds.push(new Bird(scene, island.position));
        total++;
      }
    }
  }

  /** @param {number} delta */
  update(delta) {
    for (const b of this._birds) b.update(delta);
  }
}

export default BirdSystem;
