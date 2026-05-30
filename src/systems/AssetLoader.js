/**
 * AssetLoader — loads all GLB models and the shared colormap texture.
 * All models are stored in a Map and can be cloned by key.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import GameConfig from '../config/GameConfig.js';

// ── Asset manifest ────────────────────────────────────────────────────────────
// Key → filename (without .glb), relative to ASSET_BASE
const MODEL_MANIFEST = [
  // Ships
  'ship-pirate-small',
  'ship-pirate-medium',
  'ship-pirate-large',
  'ship-small',
  'ship-medium',
  'ship-large',
  'ship-ghost',
  'ship-wreck',
  // Combat
  'cannon',
  'cannon-ball',
  // Environment
  'palm-straight',
  'palm-bend',
  'palm-detailed-straight',
  'rocks-a',
  'rocks-b',
  'rocks-c',
  'rocks-sand-a',
  'patch-sand',
  'patch-grass',
  'grass-patch',
  // Loot / Props
  'chest',
  'crate',
  'crate-bottles',
  'barrel',
  'boat-row-small',
  // Structures
  'tower-complete-small',
  'tower-watch',
  'tower-base',
  'tower-roof',
  'structure',
  'structure-platform',
  'structure-platform-dock',
  'structure-roof',
  // Flags
  'flag-pirate',
  'flag-pirate-high',
];

class AssetLoader {
  constructor() {
    /** @type {Map<string, THREE.Group>} */
    this._models = new Map();

    /** @type {THREE.Texture|null} */
    this._colormap = null;

    this._gltfLoader = new GLTFLoader();
    this._texLoader  = new THREE.TextureLoader();
  }

  /**
   * Load all assets. Calls onProgress(loaded, total, name) on each asset load.
   * @param {Function} [onProgress]
   * @returns {Promise<void>}
   */
  async load(onProgress) {
    // 1. Load shared texture atlas first
    this._colormap = await this._loadTexture(GameConfig.TEXTURE_PATH);
    this._colormap.flipY = false;     // GLB UVs are already Y-flipped
    this._colormap.colorSpace = THREE.SRGBColorSpace;

    // 2. Load all GLB models
    const total = MODEL_MANIFEST.length;
    let loaded = 0;

    const promises = MODEL_MANIFEST.map(async (key) => {
      const url = `${GameConfig.ASSET_BASE}${key}.glb`;
      try {
        const gltf = await this._loadGLTF(url);
        const scene = gltf.scene;

        // Apply shared colormap to every mesh
        scene.traverse((node) => {
          if (node.isMesh) {
            // Replace material with one using shared atlas
            const mat = new THREE.MeshLambertMaterial({
              map: this._colormap,
            });
            node.material = mat;
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });

        this._models.set(key, scene);
      } catch (err) {
        console.warn(`[AssetLoader] Failed to load "${key}":`, err.message);
        // Insert a placeholder box so the game still runs
        const placeholder = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(2, 2, 4),
          new THREE.MeshLambertMaterial({ color: 0xff00ff })
        );
        placeholder.add(mesh);
        this._models.set(key, placeholder);
      }

      loaded++;
      if (onProgress) onProgress(loaded, total, key);
    });

    await Promise.all(promises);
  }

  /**
   * Return a deep clone of the model for a given key.
   * Always clone — never add the original to the scene.
   * @param {string} key
   * @returns {THREE.Group}
   */
  get(key) {
    const model = this._models.get(key);
    if (!model) {
      console.warn(`[AssetLoader] Model "${key}" not found, returning placeholder.`);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 4),
        new THREE.MeshLambertMaterial({ color: 0xff00ff })
      ));
      return g;
    }
    return model.clone(true);
  }

  /** Check whether a model key exists in the cache. */
  has(key) {
    return this._models.has(key);
  }

  /** The shared colormap texture (already applied to models). */
  get colormap() { return this._colormap; }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this._gltfLoader.load(url, resolve, undefined, reject);
    });
  }

  _loadTexture(url) {
    return new Promise((resolve, reject) => {
      this._texLoader.load(url, resolve, undefined, reject);
    });
  }
}

// Singleton — import and share the same loader everywhere
export default new AssetLoader();
