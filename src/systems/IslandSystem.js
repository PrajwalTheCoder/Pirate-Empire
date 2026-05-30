/**
 * IslandSystem — manages island data, capture logic, passive income,
 * and island-cannon defence fire against nearby enemy ships.
 */
import * as THREE     from 'three';
import EventEmitter  from '../utils/EventEmitter.js';
import GameConfig    from '../config/GameConfig.js';
import { dist2D }    from '../utils/MathUtils.js';

const CANNON_RANGE    = 75;   // world units — how far the island gun can reach
const CANNON_COOLDOWN = 4.0;  // seconds between shots
const CANNON_POWER    = 22;   // base damage per shot

export class IslandSystem {
  /**
   * @param {import('../world/IslandGenerator.js').IslandData[]} islands
   * @param {EconomySystem} economy
   * @param {InputSystem}   input
   * @param {ShipSystem}    [ships]   — needed for cannon targeting
   * @param {CombatSystem}  [combat]  — needed for cannon firing
   */
  constructor(islands, economy, input, ships = null, combat = null) {
    this._islands  = islands;
    this._economy  = economy;
    this._input    = input;
    this._ships    = ships;
    this._combat   = combat;

    /** Currently near-capturable island id, or null */
    this._nearIslandId = null;

    // Expose islands for other systems
    this.islands = islands;
  }

  /** @param {THREE.Vector3} playerPos */
  update(delta, playerPos) {
    // Island cannon defence
    if (this._ships && this._combat) {
      this._updateCannons(delta);
    }
    this._nearIslandId = null;
    let hasCapturableNearby = false;

    for (const island of this._islands) {
      // Passive income tick
      if (island.captured && island.owner === 'PLAYER') {
        island.passiveTimer += delta;
        if (island.passiveTimer >= GameConfig.PASSIVE_GOLD_INTERVAL) {
          island.passiveTimer = 0;
          const mult = island._incomeMultiplier ?? 1;
          this._economy.awardPassiveGold(Math.round(GameConfig.PASSIVE_GOLD_PER_ISLAND * mult));
        }

        // Slowly regenerate island HP when not at max (2 HP/s)
        if (island.hp < island.maxHp) {
          island.hp = Math.min(island.maxHp, island.hp + 2 * delta);
        }
      }

      // Capture proximity check — also tracks already-captured islands for the build UI
      const d = dist2D(playerPos, island.position);
      if (d < GameConfig.ISLAND_CAPTURE_RADIUS) {
        this._nearIslandId = island.id;
        // Always broadcast which island is nearby (used by build UI)
        EventEmitter.emit('island:nearby', { island });
        // Only prompt to capture if not yet owned by player
        if (!island.captured || island.owner !== 'PLAYER') {
          hasCapturableNearby = true;
          EventEmitter.emit('island:capturable', { island });
        }
      }
    }

    // No island at all nearby — clear build target too
    if (this._nearIslandId === null) {
      EventEmitter.emit('island:nearby', { island: null });
    }

    // Hide capture prompt if no enemy/neutral island is nearby
    if (!hasCapturableNearby) {
      EventEmitter.emit('island:outofrange', {});
    }

    // Handle E-key capture
    if (this._nearIslandId !== null && this._input.justPressed('KeyE')) {
      this._captureIsland(this._nearIslandId);
    }
  }

  _updateCannons(delta) {
    const aliveShips = this._ships.alive;
    const cannonWorldPos = new THREE.Vector3();

    for (const island of this._islands) {
      if (!island.captured || island.owner !== 'PLAYER') continue;
      const activeCannon = island.cannonMesh || island.defenseCannonMesh;
      if (!activeCannon) continue;

      island.cannonCooldown -= delta;

      // Find nearest enemy ship in range
      activeCannon.getWorldPosition(cannonWorldPos);
      let nearestShip = null;
      let nearestDist = CANNON_RANGE;

      for (const ship of aliveShips) {
        if (ship.faction === 'PLAYER') continue;
        const d = dist2D(cannonWorldPos, ship.group.position);
        if (d < nearestDist) { nearestDist = d; nearestShip = ship; }
      }

      if (!nearestShip) continue;

      // Rotate cannon barrel to face the target (local Y rotation)
      const tx = nearestShip.group.position.x - cannonWorldPos.x;
      const tz = nearestShip.group.position.z - cannonWorldPos.z;
      island.cannonMesh.rotation.y = Math.atan2(tx, tz);

      // Fire on cooldown
      if (island.cannonCooldown <= 0) {
        island.cannonCooldown = CANNON_COOLDOWN;
        this._combat.fireIslandCannon(
          cannonWorldPos.clone(),
          nearestShip.group.position.clone(),
          CANNON_POWER,
        );
      }
    }
  }

  _captureIsland(id) {
    const island = this._islands.find(i => i.id === id);
    if (!island) return;

    island.captured = true;
    island.owner    = 'PLAYER';
    island.passiveTimer = 0;
    island.hp = island.maxHp ?? 100;  // full HP when newly captured

    EventEmitter.emit('island:captured', { island });
  }

  get capturedCount() {
    return this._islands.filter(i => i.captured && i.owner === 'PLAYER').length;
  }

  getIsland(id) { return this._islands.find(i => i.id === id); }
}

export default IslandSystem;
