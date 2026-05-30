/**
 * PerkSystem — Roguelite perk drops on enemy kill.
 *
 * When an enemy ship sinks:
 *   1. A glowing orb floats at the death position.
 *   2. Player sails within COLLECT_DIST to grab it.
 *   3. A flashy card popup shows the perk gained.
 *   4. The perk is applied immediately to the player ship / combat system.
 */
import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';
import { randRange } from '../utils/MathUtils.js';

// ─── PERK DEFINITIONS ─────────────────────────────────────────────────────────
export const PERKS = [
  {
    id:    'HULL_PLATING',
    icon:  '🛡️',
    name:  'Hull Plating',
    desc:  '+25 Max HP  •  +3 Armor',
    color: '#44aaff',
    rarity: 'common',
    apply(ship) {
      ship.maxHealth += 25;
      ship.health    += 25;
      ship.armor      = (ship.armor ?? 0) + 3;
    },
  },
  {
    id:    'CURSED_CANNONS',
    icon:  '💀',
    name:  'Cursed Cannons',
    desc:  '+30% Cannon Damage',
    color: '#ff4444',
    rarity: 'rare',
    apply(ship) {
      ship.cannonPower *= 1.30;
    },
  },
  {
    id:    'GHOST_SAILS',
    icon:  '👻',
    name:  'Ghost Sails',
    desc:  '+25% Ship Speed',
    color: '#aaddff',
    rarity: 'common',
    apply(ship) {
      ship.speed *= 1.25;
    },
  },
  {
    id:    'SEA_LEGS',
    icon:  '⚓',
    name:  'Sea Legs',
    desc:  '-20% Cannon Reload Time',
    color: '#ffcc44',
    rarity: 'common',
    apply(ship) {
      ship._fireCooldownMult = (ship._fireCooldownMult ?? 1.0) * 0.80;
    },
  },
  {
    id:    'INFERNO',
    icon:  '🔥',
    name:  'Inferno',
    desc:  'Fire Shot burns +6 DPS longer',
    color: '#ff6600',
    rarity: 'rare',
    apply(ship) {
      ship._infernoPerk = (ship._infernoPerk ?? 0) + 6;
    },
  },
  {
    id:    'CHAIN_MASTERY',
    icon:  '⛓️',
    name:  'Chain Mastery',
    desc:  'Chain Shot slows +2 extra seconds',
    color: '#55ccff',
    rarity: 'rare',
    apply(ship) {
      ship._chainMasteryPerk = (ship._chainMasteryPerk ?? 0) + 2;
    },
  },
  {
    id:    'IRON_KEEL',
    icon:  '⚙️',
    name:  'Iron Keel',
    desc:  '-20% Incoming Damage',
    color: '#888888',
    rarity: 'epic',
    apply(ship) {
      ship._damageReduction = (ship._damageReduction ?? 0) + 0.20;
    },
  },
  {
    id:    'PLUNDERERS_LUCK',
    icon:  '🪙',
    name:  "Plunderer's Luck",
    desc:  '+75 Gold immediately  •  +50% kill gold',
    color: '#ffd700',
    rarity: 'common',
    apply(ship) {
      ship._goldMult = (ship._goldMult ?? 1.0) * 1.50;
      // Bonus gold is emitted so EconomySystem picks it up
      EventEmitter.emit('perk:gold_bonus', { gold: 75 });
    },
  },
  {
    id:    'DEVILS_POWDER',
    icon:  '💣',
    name:  "Devil's Powder",
    desc:  '+2 Extra Cannonballs per Broadside',
    color: '#cc44ff',
    rarity: 'epic',
    apply(ship) {
      ship._extraBalls = (ship._extraBalls ?? 0) + 2;
    },
  },
  {
    id:    'BERSERKER',
    icon:  '🏴‍☠️',
    name:  'Berserker',
    desc:  'Below 30% HP: +40% Damage & Speed',
    color: '#ff2222',
    rarity: 'epic',
    apply(ship) {
      ship._berserkerPerk = true;
    },
  },
];

const RARITY_WEIGHTS = { common: 50, rare: 30, epic: 20 };
const COLLECT_DIST   = 12;   // world units

// ─── PERK ORB ─────────────────────────────────────────────────────────────────
class PerkOrb {
  constructor(scene, position, perk) {
    this._scene  = scene;
    this._perk   = perk;
    this._age    = 0;
    this._dead   = false;
    this.perk    = perk;
    this.pos     = position.clone().setY(1.5);

    const colorHex = parseInt(perk.color.replace('#', ''), 16);

    // Core glow sphere
    const coreGeo = new THREE.SphereGeometry(0.55, 10, 10);
    const coreMat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.92, depthWrite: false,
    });
    this._core = new THREE.Mesh(coreGeo, coreMat);
    this._core.position.copy(this.pos);
    scene.add(this._core);

    // Outer aura ring (horizontal)
    const ringGeo = new THREE.RingGeometry(1.0, 1.6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.45,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this._ring = new THREE.Mesh(ringGeo, ringMat);
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.position.copy(this.pos).setY(0.2);
    scene.add(this._ring);

    // Vertical spin ring
    const vRingGeo = new THREE.RingGeometry(0.7, 1.0, 18);
    const vRingMat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.5,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this._vRing = new THREE.Mesh(vRingGeo, vRingMat);
    this._vRing.position.copy(this.pos);
    scene.add(this._vRing);

    // Rising particles
    this._particles = [];
    for (let i = 0; i < 6; i++) {
      const pGeo = new THREE.SphereGeometry(0.08, 4, 4);
      const pMat = new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: 0.8, depthWrite: false,
      });
      const pm = new THREE.Mesh(pGeo, pMat);
      pm.position.copy(this.pos).add(new THREE.Vector3(
        randRange(-0.8, 0.8), randRange(0, 1.5), randRange(-0.8, 0.8)
      ));
      pm._phase = (i / 6) * Math.PI * 2;
      pm._speed = 0.6 + Math.random() * 0.8;
      scene.add(pm);
      this._particles.push(pm);
    }
  }

  update(delta) {
    this._age += delta;
    const t = this._age;

    // Bob up and down
    const bobY = 1.5 + Math.sin(t * 2.2) * 0.35;
    this._core.position.y = bobY;
    this._vRing.position.y = bobY;

    // Pulse core opacity
    this._core.material.opacity = 0.75 + Math.sin(t * 3.5) * 0.2;

    // Spin rings
    this._ring.rotation.z  += delta * 0.6;
    this._vRing.rotation.y += delta * 1.2;
    this._vRing.rotation.x += delta * 0.4;

    // Pulse ring scale
    const rs = 1 + Math.sin(t * 2.0) * 0.12;
    this._ring.scale.setScalar(rs);

    // Animate rising particles
    for (const pm of this._particles) {
      pm._phase += delta * pm._speed * 2;
      const orbit = 0.9;
      pm.position.x = this.pos.x + Math.cos(pm._phase) * orbit;
      pm.position.z = this.pos.z + Math.sin(pm._phase) * orbit;
      pm.position.y = bobY + Math.sin(pm._phase * 1.7) * 0.5;
      pm.material.opacity = 0.5 + Math.sin(pm._phase * 2.1) * 0.35;
    }
  }

  /** Pulse + shrink on collect */
  collect() {
    this._dead = true;
    this._scene.remove(this._core);
    this._scene.remove(this._ring);
    this._scene.remove(this._vRing);
    for (const pm of this._particles) this._scene.remove(pm);
  }

  get dead() { return this._dead; }

  dispose() {
    this.collect();
  }
}

// ─── PERK UI ──────────────────────────────────────────────────────────────────
function showPerkCard(perk) {
  // Remove any existing card first
  document.getElementById('perk-card-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'perk-card-overlay';

  const rarityClass = `perk-rarity-${perk.rarity}`;

  overlay.innerHTML = `
    <div class="perk-card ${rarityClass}">
      <div class="perk-card-header">PERK UNLOCKED!</div>
      <div class="perk-icon">${perk.icon}</div>
      <div class="perk-name">${perk.name}</div>
      <div class="perk-desc">${perk.desc}</div>
      <div class="perk-rarity-badge">${perk.rarity.toUpperCase()}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Auto-remove after 3.5s
  setTimeout(() => overlay.remove(), 3500);
}

// ─── PERK SYSTEM ──────────────────────────────────────────────────────────────
export class PerkSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ShipSystem.js').Ship} playerShip   — ref, updated by game
   * @param {import('../systems/EconomySystem.js').default} economy
   */
  constructor(scene, playerShip, economy) {
    this._scene      = scene;
    this._economy    = economy;
    this._orbs       = [];

    // Active perks on the player (id → count)
    this._activePerkIds = new Map();

    // Player ref (may change on ship upgrade)
    this.playerShip = playerShip;

    // Listen for enemy sinks to drop orbs
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== 'PLAYER') {
        this._trySpawnOrb(ship.group.position.clone());
      }
    });

    // Perk gold bonus → economy
    EventEmitter.on('perk:gold_bonus', ({ gold }) => {
      this._economy.add('gold', gold);
    });

    // Build perk HUD bar
    this._buildPerkBar();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Call each frame. */
  update(delta) {
    const ship = this.playerShip;
    if (!ship?.isAlive) return;

    // Apply berserker passive each tick
    if (ship._berserkerPerk && ship.health < ship.maxHealth * 0.3) {
      ship._berserkerActive = true;
    } else {
      ship._berserkerActive = false;
    }

    for (let i = this._orbs.length - 1; i >= 0; i--) {
      const orb = this._orbs[i];
      orb.update(delta);

      if (orb.dead) {
        this._orbs.splice(i, 1);
        continue;
      }

      // Check collection distance from player ship
      if (ship.isSailing) {
        const dx = ship.group.position.x - orb.pos.x;
        const dz = ship.group.position.z - orb.pos.z;
        if (dx * dx + dz * dz < COLLECT_DIST * COLLECT_DIST) {
          this._collectOrb(orb, ship);
          this._orbs.splice(i, 1);
        }
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Pick a weighted-random perk. */
  _pickPerk() {
    const pool = [];
    for (const perk of PERKS) {
      const w = RARITY_WEIGHTS[perk.rarity] ?? 10;
      for (let i = 0; i < w; i++) pool.push(perk);
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Spawn a perk orb at the given world position (60% drop chance). */
  _trySpawnOrb(position) {
    if (Math.random() > 0.60) return;   // 60% drop chance per kill
    const perk = this._pickPerk();
    const orb  = new PerkOrb(this._scene, position, perk);
    this._orbs.push(orb);
  }

  /** Apply a perk to the player ship. */
  _collectOrb(orb, ship) {
    orb.collect();
    const perk = orb.perk;

    // Apply stat effect
    perk.apply(ship);

    // Track active perks
    const count = (this._activePerkIds.get(perk.id) ?? 0) + 1;
    this._activePerkIds.set(perk.id, count);

    // Show fancy card
    showPerkCard(perk);

    // Toast
    EventEmitter.emit('perk:collected', { perk });

    // Update perk bar
    this._refreshPerkBar();
  }

  _buildPerkBar() {
    let bar = document.getElementById('perk-bar');
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'perk-bar';
    bar.innerHTML = '<div class="perk-bar-title">PERKS</div><div class="perk-bar-slots" id="perk-bar-slots"></div>';
    document.body.appendChild(bar);
  }

  _refreshPerkBar() {
    const slots = document.getElementById('perk-bar-slots');
    if (!slots) return;
    slots.innerHTML = '';
    for (const [id, count] of this._activePerkIds) {
      const perk = PERKS.find(p => p.id === id);
      if (!perk) continue;
      const el = document.createElement('div');
      el.className = `perk-pip perk-rarity-${perk.rarity}`;
      el.title = `${perk.name}: ${perk.desc}`;
      el.innerHTML = `<span class="perk-pip-icon">${perk.icon}</span>${count > 1 ? `<span class="perk-pip-count">×${count}</span>` : ''}`;
      slots.appendChild(el);
    }
  }
}

export default PerkSystem;
