/**
 * BuildSystem — island base building.
 *
 * Catalog of buildings with costs and effects.
 * Player selects an island then chooses a building type.
 */
import AssetLoader  from './AssetLoader.js';
import EventEmitter from '../utils/EventEmitter.js';
import GameConfig   from '../config/GameConfig.js';

export const BuildingType = {
  WATCH_TOWER:    'WATCH_TOWER',
  DEFENSE_CANNON: 'DEFENSE_CANNON',
  SHIPYARD:       'SHIPYARD',
  TREASURE_VAULT: 'TREASURE_VAULT',
};

export const BuildCatalog = [
  {
    id:       BuildingType.WATCH_TOWER,
    label:    '🗼 Watch Tower',
    desc:     'Reveals nearby enemy ships.',
    cost:     GameConfig.BUILD_COSTS.WATCH_TOWER,
    modelKey: 'tower-complete-small',
    scale:    0.9,
    effect:   { type: 'VISION', radius: 80 },
  },
  {
    id:       BuildingType.DEFENSE_CANNON,
    label:    '💣 Defense Cannon',
    desc:     'Fires at approaching enemies.',
    cost:     GameConfig.BUILD_COSTS.DEFENSE_CANNON,
    modelKey: 'cannon',
    scale:    1.2,
    effect:   { type: 'DEFENSE', damage: 20, range: 40 },
  },
  {
    id:       BuildingType.SHIPYARD,
    label:    '⚓ Shipyard',
    desc:     'Allows recruiting new ships.',
    cost:     GameConfig.BUILD_COSTS.SHIPYARD,
    modelKey: 'structure-platform-dock',
    scale:    1.0,
    effect:   { type: 'RECRUIT' },
  },
  {
    id:       BuildingType.TREASURE_VAULT,
    label:    '💰 Treasure Vault',
    desc:     'Doubles passive gold income.',
    cost:     GameConfig.BUILD_COSTS.TREASURE_VAULT,
    modelKey: 'structure',
    scale:    1.0,
    effect:   { type: 'INCOME_MULT', multiplier: 2 },
  },
];

export class BuildSystem {
  /**
   * @param {IslandSystem}  islandSystem
   * @param {EconomySystem} economy
   */
  constructor(islandSystem, economy) {
    this._islands = islandSystem;
    this._economy = economy;
  }

  /**
   * Attempt to build on the target island.
   * @param {number} islandId
   * @param {string} buildingType
   * @returns {boolean} success
   */
  build(islandId, buildingType) {
    const island = this._islands.getIsland(islandId);
    if (!island) return false;
    if (!island.captured || island.owner !== 'PLAYER') return false;
    if (island.buildings.includes(buildingType)) return false;  // already built

    const entry = BuildCatalog.find(b => b.id === buildingType);
    if (!entry) return false;

    if (!this._economy.spend(entry.cost)) return false;

    // Place model at next available build slot
    if (island.nextBuildSlot < island.buildSlots.length) {
      const slotLocal = island.buildSlots[island.nextBuildSlot];
      island.nextBuildSlot++;

      const model = AssetLoader.get(entry.modelKey);
      model.position.copy(slotLocal);
      if (entry.scale) model.scale.setScalar(entry.scale);
      // Rotate building to face outward from the island center (local origin 0,0,0)
      model.rotation.y = Math.atan2(slotLocal.x, slotLocal.z);
      island.group.add(model);
      if (buildingType === 'DEFENSE_CANNON') island.defenseCannonMesh = model;
    }

    island.buildings.push(buildingType);

    // Apply effect
    this._applyEffect(island, entry.effect);

    EventEmitter.emit('build:completed', { island, building: buildingType });
    return true;
  }

  _applyEffect(island, effect) {
    if (!effect) return;
    switch (effect.type) {
      case 'INCOME_MULT':
        // Handled in IslandSystem / EconomySystem — stored on island
        island._incomeMultiplier = (island._incomeMultiplier || 1) * effect.multiplier;
        break;
      // Other effects can be implemented here
    }
  }

  /** Can the player afford and build this on the given island? */
  canBuild(islandId, buildingType) {
    const island = this._islands.getIsland(islandId);
    if (!island || !island.captured) return false;
    if (island.buildings.includes(buildingType)) return false;

    const entry = BuildCatalog.find(b => b.id === buildingType);
    if (!entry) return false;

    return this._economy.canAfford(entry.cost);
  }
}

export default BuildSystem;
