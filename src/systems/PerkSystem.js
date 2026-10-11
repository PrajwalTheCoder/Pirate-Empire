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
      // Floor at 0.20 so fire rate can't be reduced to near-zero
      ship._fireCooldownMult = Math.max(0.20, (ship._fireCooldownMult ?? 1.0) * 0.80);
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
    desc:  '-20% Incoming Damage (max 80%)',
    color: '#888888',
    rarity: 'epic',
    apply(ship) {
      // Hard cap at 0.80 — prevents negative damage (healing exploit)
      ship._damageReduction = Math.min(0.80, (ship._damageReduction ?? 0) + 0.20);
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
    this.perkPoints = 1; // Start with 1 perk point

    // Player ref (may change on ship upgrade)
    this.playerShip = playerShip;

    // Listen for enemy sinks to drop orbs and award perk points
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== 'PLAYER') {
        this.perkPoints += 1;
        this._trySpawnOrb(ship.group.position.clone());
        this._refreshPerkUI();
      }
    });

    // Perk gold bonus → economy
    EventEmitter.on('perk:gold_bonus', ({ gold }) => {
      this._economy.add('gold', gold);
    });

    // Build compact corner card UI
    this._buildPerkUI();
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

  /**
   * Authoritatively unlock / activate a perk on the player's ship.
   * @param {string} perkId
   * @returns {boolean}
   */
  unlockPerk(perkId) {
    const perk = PERKS.find(p => p.id === perkId);
    if (!perk || !this.playerShip) return false;

    // Check if already active
    if (this._activePerkIds.has(perkId)) return false;

    // Cost: 1 perk point, or 250 gold
    if (this.perkPoints > 0) {
      this.perkPoints -= 1;
    } else if (this._economy && this._economy.canAfford({ gold: 250 })) {
      this._economy.spend({ gold: 250 });
    } else {
      window.__game?.hud?.toast('❌ Need 1 Perk Point or 250 Gold!', 'danger');
      return false;
    }

    // Apply stat effects directly to the player ship
    perk.apply(this.playerShip);
    this._activePerkIds.set(perkId, 1);

    // Toast & sound feedback
    window.__game?.hud?.toast(`⚔️ Activated Perk: ${perk.name}!`, 'success');
    EventEmitter.emit('perk:collected', { perk });

    this._refreshPerkUI();
    return true;
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
    if (Math.random() > 0.60) return;
    const perk = this._pickPerk();
    const orb  = new PerkOrb(this._scene, position, perk);
    this._orbs.push(orb);
  }

  /** Apply a perk collected from a floating orb. */
  _collectOrb(orb, ship) {
    orb.collect();
    const perk = orb.perk;

    perk.apply(ship);
    const count = (this._activePerkIds.get(perk.id) ?? 0) + 1;
    this._activePerkIds.set(perk.id, count);

    window.__game?.hud?.toast(`✨ Plundered Perk: ${perk.name}!`, 'gold');
    EventEmitter.emit('perk:collected', { perk });

    this._refreshPerkUI();
  }

  _buildPerkUI() {
    let card = document.getElementById('perk-corner-card');
    if (card) return;

    card = document.createElement('div');
    card.id = 'perk-corner-card';
    card.innerHTML = `
      <button id="perk-toggle-btn" class="perk-toggle-btn" title="Toggle Captain Perks">
        📜 Perks <span class="perk-pts-badge" id="perk-pts-badge">★ ${this.perkPoints}</span>
      </button>
      <div id="perk-corner-panel" class="perk-corner-panel hidden">
        <div class="perk-panel-header">
          <div class="perk-header-title">☠️ CAPTAIN PERKS</div>
          <div class="perk-header-pts" id="perk-header-pts">Points: ★ ${this.perkPoints}</div>
          <button class="perk-close-btn" id="perk-close-btn">✕</button>
        </div>
        <div class="perk-panel-list" id="perk-panel-list"></div>
      </div>
    `;
    document.body.appendChild(card);

    const toggleBtn = document.getElementById('perk-toggle-btn');
    const panel = document.getElementById('perk-corner-panel');
    const closeBtn = document.getElementById('perk-close-btn');

    toggleBtn?.addEventListener('click', () => {
      panel?.classList.toggle('hidden');
      this._refreshPerkUI();
    });

    closeBtn?.addEventListener('click', () => {
      panel?.classList.add('hidden');
    });

    // Delegate perk activation clicks
    panel?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-perk-id]');
      if (!btn) return;
      const pid = btn.dataset.perkId;
      this.unlockPerk(pid);
    });

    this._refreshPerkUI();
  }

  _refreshPerkUI() {
    const ptsBadge = document.getElementById('perk-pts-badge');
    const headerPts = document.getElementById('perk-header-pts');
    if (ptsBadge) ptsBadge.textContent = `★ ${this.perkPoints}`;
    if (headerPts) headerPts.textContent = `Points: ★ ${this.perkPoints}`;

    const list = document.getElementById('perk-panel-list');
    if (!list) return;

    const gold = this._economy?.gold ?? 0;

    list.innerHTML = PERKS.map(p => {
      const isActive = this._activePerkIds.has(p.id);
      const canAffordPoints = this.perkPoints > 0;
      const canAffordGold = gold >= 250;

      let btnLabel = '';
      let btnCls = 'perk-buy-btn';
      let disabled = false;

      if (isActive) {
        btnLabel = 'Active';
        btnCls += ' active-btn';
        disabled = true;
      } else if (canAffordPoints) {
        btnLabel = '★ 1 Pt';
        btnCls += ' point-btn';
      } else if (canAffordGold) {
        btnLabel = '🪙 250g';
        btnCls += ' gold-btn';
      } else {
        btnLabel = '🔒 Locked';
        btnCls += ' locked-btn';
        disabled = true;
      }

      return `
        <div class="perk-row perk-rarity-${p.rarity} ${isActive ? 'is-active' : ''}">
          <div class="perk-row-left">
            <span class="perk-row-icon">${p.icon}</span>
            <div class="perk-row-text">
              <div class="perk-row-name">${p.name}</div>
              <div class="perk-row-desc">${p.desc}</div>
            </div>
          </div>
          <button class="${btnCls}" data-perk-id="${p.id}" ${disabled ? 'disabled' : ''}>
            ${btnLabel}
          </button>
        </div>
      `;
    }).join('');
  }
}

export default PerkSystem;
