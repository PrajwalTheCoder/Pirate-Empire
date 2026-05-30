/**
 * EconomySystem — manages player resources and emits change events.
 */
import EventEmitter from '../utils/EventEmitter.js';
import GameConfig   from '../config/GameConfig.js';
import { clamp, randRange } from '../utils/MathUtils.js';

export class EconomySystem {
  constructor() {
    this.resources = {
      gold: GameConfig.PLAYER_START_GOLD,
      crew: GameConfig.PLAYER_START_CREW,
      wood: GameConfig.PLAYER_START_WOOD,
    };

    // Upgrades purchased — tracks stat multipliers
    this._upgrades = {};

    // Listen to game events
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== 'PLAYER') {
        const table = GameConfig.FACTION_LOOT[ship.faction] || { min: 40, max: 100 };
        const goldMult = window.__game?.playerShip?._goldMult ?? 1.0;
        const gold  = Math.round(randRange(table.min, table.max) * goldMult);
        const crew  = table.crew ? Math.round(randRange(1, table.crew)) : 0;
        const wood  = table.wood ? Math.round(randRange(1, table.wood)) : 0;
        this.add('gold', gold);
        if (crew > 0) this.add('crew', crew);
        if (wood > 0) this.add('wood', wood);
        EventEmitter.emit('loot:collected', { gold, crew, wood, source: 'ship' });
      }
    });

    EventEmitter.on('chest:collected', ({ amount }) => {
      this.add('gold', amount);
    });
  }

  /** Add an amount to a resource. */
  add(resource, amount) {
    if (!(resource in this.resources)) return;
    this.resources[resource] = Math.max(0, this.resources[resource] + amount);
    EventEmitter.emit('economy:changed', { ...this.resources });
  }

  /** Spend resources. Returns false (and does NOT deduct) if insufficient. */
  spend(costs) {
    if (!this.canAfford(costs)) return false;
    for (const [res, amt] of Object.entries(costs)) {
      this.resources[res] -= amt;
    }
    EventEmitter.emit('economy:changed', { ...this.resources });
    return true;
  }

  /** Check if player can afford a cost object { gold: N, wood: M, ... } */
  canAfford(costs) {
    for (const [res, amt] of Object.entries(costs)) {
      if ((this.resources[res] ?? 0) < amt) return false;
    }
    return true;
  }

  /** Purchase an upgrade by id. Returns true on success. */
  purchaseUpgrade(upgradeId) {
    const upg = GameConfig.UPGRADES.find(u => u.id === upgradeId);
    if (!upg) return false;
    if (this._upgrades[upgradeId]) return false; // already owned
    if (upg.requires && !this._upgrades[upg.requires]) return false;
    if (!this.spend(upg.cost)) return false;

    this._upgrades[upgradeId] = true;
    EventEmitter.emit('upgrade:purchased', { upgrade: upg });
    return true;
  }

  hasUpgrade(id) { return !!this._upgrades[id]; }

  get gold() { return this.resources.gold; }
  get crew() { return this.resources.crew; }
  get wood() { return this.resources.wood; }

  /** Called by IslandSystem to award passive income. */
  awardPassiveGold(amount) {
    this.add('gold', amount);
    EventEmitter.emit('loot:collected', { gold: amount, source: 'island' });
  }

  update(_delta) { /* passive income is ticked by IslandSystem */ }
}

export default EconomySystem;
