/**
 * AISystem — enemy ship state machines.
 *
 * States:  PATROL → ALERT → CHASE → ATTACK → RETREAT → PATROL
 *                                                  ↗ RAID ↗
 *
 * Three AI personalities drive behaviour:
 *   NAVY     — standard patrol/alert/chase/attack cycle, retreats at low HP
 *   MERCHANT — only patrols (island-to-island), flees immediately on detection
 *   HUNTER   — aggressive boss; skips ALERT, extended ranges, fast fire rate
 *
 * Destroyed ships respawn after a delay (HUNTER waits 3× longer).
 */
import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';
import GameConfig   from '../config/GameConfig.js';
import { Faction, FactionShipClass, FactionPersonality, ShipStats } from '../config/ShipConfig.js';
import { randRange, dist2D, angleTo, wrapAngle } from '../utils/MathUtils.js';

// ─── AI States ─────────────────────────────────────────────────────────────────
const AIState = { PATROL: 0, ALERT: 1, CHASE: 2, ATTACK: 3, RETREAT: 4, RAID: 5 };

// ─── Per-personality tuning ────────────────────────────────────────────────────
const PersonalityConfig = {
  NAVY: {
    detectRange:  GameConfig.AI_DETECT_RANGE,
    chaseRange:   GameConfig.AI_CHASE_RANGE,
    attackRange:  GameConfig.AI_ATTACK_RANGE,
    loseRange:    GameConfig.AI_LOSE_RANGE,
    fireCooldown: GameConfig.AI_FIRE_COOLDOWN,
    islandBias:   0.85,   // strongly prefer patrolling near islands
    skipsAlert:   false,
    fleeOnly:     false,
  },
  MERCHANT: {
    detectRange:  GameConfig.AI_DETECT_RANGE,
    chaseRange:   GameConfig.AI_CHASE_RANGE,
    attackRange:  0,
    loseRange:    GameConfig.AI_LOSE_RANGE * 1.2,
    fireCooldown: Infinity,
    islandBias:   0.90,   // almost always routes between islands
    skipsAlert:   false,
    fleeOnly:     true,
  },
  HUNTER: {
    detectRange:  180,
    chaseRange:   150,
    attackRange:  50,
    loseRange:    256,
    fireCooldown: 2.0,
    islandBias:   0.60,   // patrols near islands too
    skipsAlert:   true,
    fleeOnly:     false,
  },
};

// ─── AI Agent ──────────────────────────────────────────────────────────────────
//
// ANGLE MATH NOTE
// ───────────────
// Three.js Y-rotation θ produces forward vector (-sinθ, 0, -cosθ).
// angleTo(a, b) = atan2(b.x-a.x, b.z-a.z) = φ.
// At rotation.y = φ the ship faces OPPOSITE to b (away from target).
// At rotation.y = φ + π the ship faces TOWARD b.
//
// Therefore: diff = wrapAngle(angleTo(a,b) + π − rotation.y)
//            → when diff=0 ship faces target, positive diff = turn left.
//
// Consequences for manual angle composition:
//   • "toward target"   = angleTo + π
//   • "away from target"= angleTo          (angleTo without +π)
//   • "broadside right" = angleTo + π + π/2
//   • "toward centre"   = atan2(pos.x, pos.z)   (NOT negated)
//
class AIAgent {
  /**
   * @param {Ship}      ship
   * @param {string}    personality
   * @param {object[]}  islands      plain {x,z} for waypoints
   * @param {object[]}  islandData   full IslandData objects for raiding
   * @param {AIAgent|null} leader    squadron leader (null = independent or leader itself)
   */
  constructor(ship, personality = 'NAVY', islands = [], islandData = [], leader = null) {
    this.ship          = ship;
    this.personality   = personality;
    this._cfg          = { ...PersonalityConfig[personality] ?? PersonalityConfig.NAVY };
    this._islands      = islands;
    this._islandData   = islandData;
    this.state         = AIState.PATROL;
    this._waypoint     = new THREE.Vector3();
    this._fireCooldown = randRange(0, this._cfg.fireCooldown === Infinity ? 0 : this._cfg.fireCooldown);
    this._raidTarget   = null;
    this._raidCheckTimer = randRange(5, 15);
    // Fleet formation: leader reference (null = no squadron / is the leader)
    this._leader         = leader;
    this._diplomaticBoost = false;
    this._nightAdjusted   = false;
    this._newWaypoint();
  }

  // Night-effect range multiplier, managed by AISystem
  static nightMultiplier = 1.0;

  // ── Waypoint selection ────────────────────────────────────────────────────
  _newWaypoint() {
    const half = GameConfig.WORLD_SIZE / 2 - 120; // keep 120 units clear of border

    if (this._islands.length > 0 && Math.random() < this._cfg.islandBias) {
      const isle  = this._islands[Math.floor(Math.random() * this._islands.length)];
      const angle = randRange(0, Math.PI * 2);
      const dist  = randRange(25, 60);
      this._waypoint.set(
        THREE.MathUtils.clamp(isle.x + Math.cos(angle) * dist, -half, half),
        0,
        THREE.MathUtils.clamp(isle.z + Math.sin(angle) * dist, -half, half),
      );
    } else {
      // Bias random waypoints toward the central 60% of the world
      this._waypoint.set(
        randRange(-half * 0.6, half * 0.6),
        0,
        randRange(-half * 0.6, half * 0.6),
      );
    }
  }

  // ── Main tick ─────────────────────────────────────────────────────────────
  update(delta, playerPos, combat) {
    if (!this.ship.isSailing) return;

    const ship  = this.ship;
    const pos   = ship.group.position;
    const d     = dist2D(pos, playerPos);
    const cfg   = this._cfg;
    const hpPct = ship.health / ship.maxHealth;

    const game = window.__game;
    const navyRep = game?.story?.getFactionReputation('ROYAL_NAVY') ?? 0;
    
    // Navy speed boost based on hostile reputation
    let repDetectMultiplier = 1.0;
    let repSpeedBoost = 1.0;
    const isNavyFaction = ship.faction === Faction.BRITISH || ship.faction === Faction.SPANISH;
    if (navyRep < -400 && isNavyFaction) {
      repDetectMultiplier = 1.4; // 40% wider detection range
      repSpeedBoost = 1.15;      // 15% speed boost
    }

    // Apply speed boost to ship
    const baseStats = ShipStats[ship.shipClass];
    if (baseStats) {
      ship.speed = baseStats.speed * repSpeedBoost;
    }

    // ── Border recovery — force waypoint toward centre and patrol ─────────
    const BORDER = GameConfig.WORLD_SIZE / 2 - 60;
    if (Math.abs(pos.x) > BORDER || Math.abs(pos.z) > BORDER) {
      this._waypoint.set(
        THREE.MathUtils.clamp(-pos.x * 0.4, -BORDER * 0.6, BORDER * 0.6),
        0,
        THREE.MathUtils.clamp(-pos.z * 0.4, -BORDER * 0.6, BORDER * 0.6),
      );
      if (this.state !== AIState.ATTACK && this.state !== AIState.CHASE) {
        this.state = AIState.PATROL;
      }
    }

    // ── State transitions ─────────────────────────────────────────────────
    // Effective detect range: halved at night (less visibility) + doubled when angered
    const DR = cfg.detectRange
      * AIAgent.nightMultiplier
      * (this._diplomaticBoost ? 2.0 : 1.0)
      * repDetectMultiplier;

    // Black Fleet Alliance: non-ghost vessels flee, ghost vessels are passive
    if (game && game._joinedBlackFleet) {
      if (ship.faction === 'GHOST_FLEET') {
        this.state = AIState.PATROL;
      } else if (ship.faction !== Faction.PLAYER && d < 90) {
        this.state = AIState.RETREAT;
      }
    }

    // Wingman formation: mirror leader when it engages
    if (this._leader) {
      const ls = this._leader.state;
      if ((ls === AIState.CHASE || ls === AIState.ATTACK) && this.state === AIState.PATROL) {
        this.state = AIState.CHASE;
      }
    }

    switch (this.state) {

      case AIState.PATROL:
        if (cfg.fleeOnly) {
          if (d < DR) { this.state = AIState.RETREAT; break; }
        } else if (cfg.skipsAlert) {
          if (d < DR) { this.state = AIState.CHASE;   break; }
        } else {
          if (d < DR) { this.state = AIState.ALERT;   break; }
        }
        // Periodically set course to raid a player-owned island
        if (!cfg.fleeOnly) {
          this._raidCheckTimer -= delta;
          if (this._raidCheckTimer <= 0) {
            this._raidCheckTimer = randRange(15, 30);
            const target = this._pickRaidTarget();
            if (target) { this._raidTarget = target; this.state = AIState.RAID; }
          }
        }
        break;

      case AIState.ALERT:
        if (d < cfg.chaseRange)                       { this.state = AIState.CHASE;   break; }
        if (d > cfg.loseRange)                        { this.state = AIState.PATROL;  break; }
        if (hpPct < GameConfig.AI_RETREAT_HEALTH_PCT) { this.state = AIState.RETREAT; break; }
        break;

      case AIState.CHASE:
        if (d < cfg.attackRange)                      { this.state = AIState.ATTACK;  break; }
        if (d > cfg.loseRange)                        { this.state = AIState.PATROL;  break; }
        if (hpPct < GameConfig.AI_RETREAT_HEALTH_PCT) { this.state = AIState.RETREAT; break; }
        break;

      case AIState.ATTACK:
        if (d > cfg.attackRange * 1.6)                { this.state = AIState.CHASE;   break; }
        if (d > cfg.loseRange)                        { this.state = AIState.PATROL;  break; }
        if (hpPct < GameConfig.AI_RETREAT_HEALTH_PCT) { this.state = AIState.RETREAT; break; }
        break;

      case AIState.RETREAT:
        if (d > cfg.loseRange * 1.2) {
          this.state = AIState.PATROL;
          this._newWaypoint();
        }
        break;

      case AIState.RAID:
        if (hpPct < GameConfig.AI_RETREAT_HEALTH_PCT) {
          this._raidTarget = null;
          this.state = AIState.RETREAT;
          break;
        }
        if (d < cfg.detectRange) {
          this._raidTarget = null;
          this.state = cfg.skipsAlert ? AIState.CHASE : AIState.ALERT;
          break;
        }
        if (!this._raidTarget || this._raidTarget.owner !== 'PLAYER') {
          this._raidTarget = null;
          this._raidCheckTimer = randRange(15, 30);
          this._newWaypoint();
          this.state = AIState.PATROL;
        }
        break;
    }

    // ── Behaviour ─────────────────────────────────────────────────────────
    switch (this.state) {
      case AIState.PATROL:  this._doPatrol(delta);                    break;
      case AIState.ALERT:   this._doAlert(delta, playerPos);          break;
      case AIState.CHASE:   this._doChase(delta, playerPos);          break;
      case AIState.ATTACK:  this._doAttack(delta, playerPos, combat); break;
      case AIState.RETREAT: this._doRetreat(delta, playerPos);        break;
      case AIState.RAID:    this._doRaid(delta, combat);              break;
    }
  }

  // ── Behaviours ────────────────────────────────────────────────────────────
  _doPatrol(delta) {
    const ship = this.ship;
    ship.thrust = GameConfig.AI_PATROL_SPEED_FACTOR;

    if (this._leader) {
      // Wingman: stay near the leader rather than roaming independently
      this._steerToward(this._leader.ship.group.position, delta, 0.7);
      if (dist2D(ship.group.position, this._leader.ship.group.position) < 18) {
        ship.thrust = 0.2; // hold formation
      }
    } else {
      this._steerToward(this._waypoint, delta, 0.8);
      if (dist2D(ship.group.position, this._waypoint) < 20) {
        this._newWaypoint();
      }
    }
  }

  _doAlert(delta, playerPos) {
    this.ship.thrust = GameConfig.AI_PATROL_SPEED_FACTOR;
    this._steerToward(playerPos, delta, 0.8);
  }

  _doChase(delta, playerPos) {
    this.ship.thrust = GameConfig.AI_CHASE_SPEED_FACTOR;
    this._steerToward(playerPos, delta, 1.0);
  }

  _doAttack(delta, playerPos, combat) {
    const ship = this.ship;
    // "toward player" = angleTo + π  (see angle-math note at top of class)
    // broadside       = toward player + π/2
    const toward    = angleTo(ship.group.position, playerPos) + Math.PI;
    const broadside = toward + Math.PI / 2;
    const diff      = wrapAngle(broadside - ship.group.rotation.y);
    ship.steering   = Math.sign(diff) * Math.min(1, Math.abs(diff) * 2.5);
    ship.thrust     = GameConfig.AI_PATROL_SPEED_FACTOR * 0.7;

    this._fireCooldown -= delta;
    if (this._fireCooldown <= 0) {
      this._fireCooldown = this._cfg.fireCooldown + randRange(-0.5, 0.5);
      combat.fireCannons(ship);
    }
  }

  _doRetreat(delta, playerPos) {
    const ship       = this.ship;
    const pos        = ship.group.position;
    const BORDER     = GameConfig.WORLD_SIZE / 2 - 80;
    const nearBorder = Math.abs(pos.x) > BORDER || Math.abs(pos.z) > BORDER;

    // Near border → face toward centre.  atan2(pos.x, pos.z) gives the correct
    // rotation.y at which forward = (-sinθ, 0, -cosθ) points toward origin.
    // Away from player → angleTo without +π gives "facing away" (see class note).
    const targetAngle = nearBorder
      ? Math.atan2(pos.x, pos.z)
      : angleTo(pos, playerPos);

    const diff    = wrapAngle(targetAngle - ship.group.rotation.y);
    ship.steering = Math.sign(diff) * Math.min(1, Math.abs(diff) * 2.5);
    ship.thrust   = 1.0;
  }

  _doRaid(delta, combat) {
    if (!this._raidTarget) return;
    const ship       = this.ship;
    const islePos    = this._raidTarget.position;
    const d          = dist2D(ship.group.position, islePos);
    const bombRadius = (this._raidTarget.collisionRadius ?? 30) + this._cfg.attackRange;

    if (d > bombRadius) {
      // Sail straight at the island
      ship.thrust = GameConfig.AI_CHASE_SPEED_FACTOR;
      this._steerToward(islePos, delta, 1.0);
    } else {
      // Within range — broadside and fire (same formula as _doAttack)
      const toward    = angleTo(ship.group.position, islePos) + Math.PI;
      const broadside = toward + Math.PI / 2;
      const diff      = wrapAngle(broadside - ship.group.rotation.y);
      ship.steering   = Math.sign(diff) * Math.min(1, Math.abs(diff) * 2.5);
      ship.thrust     = GameConfig.AI_PATROL_SPEED_FACTOR * 0.4;

      this._fireCooldown -= delta;
      if (this._fireCooldown <= 0) {
        this._fireCooldown = this._cfg.fireCooldown + randRange(-0.5, 0.5);
        combat.fireCannons(ship);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  /**
   * Steer the ship to face toward `target`.
   * The crucial +Math.PI corrects for the angleTo/forward-vector convention
   * mismatch: angleTo gives the angle at which the ship faces AWAY from target;
   * adding π makes diff=0 when the ship faces TOWARD target.
   */
  _steerToward(target, _delta, factor) {
    const ship = this.ship;
    const diff = wrapAngle(angleTo(ship.group.position, target) + Math.PI - ship.group.rotation.y);
    ship.steering = Math.sign(diff) * Math.min(1, Math.abs(diff) * factor * 3);
  }

  /** Returns nearest player-owned island, or null. */
  _pickRaidTarget() {
    if (!this._islandData.length) return null;
    const pos = this.ship.group.position;
    let best = null, bestDist = Infinity;
    for (const isle of this._islandData) {
      if (!isle.captured || isle.owner !== 'PLAYER') continue;
      const d = dist2D(pos, isle.position);
      if (d < bestDist) { bestDist = d; best = isle; }
    }
    return best;
  }
}

// ─── AI SYSTEM ─────────────────────────────────────────────────────────────────
export class AISystem {
  /**
   * @param {ShipSystem}      shipSystem
   * @param {CombatSystem}    combatSystem
   * @param {object[]}        islands      — island data objects with .x/.z position
   */
  constructor(shipSystem, combatSystem, islands = []) {
    this._shipSystem   = shipSystem;
    this._combatSystem = combatSystem;
    this._islands = islands;
    this._islandPositions = islands.map(isl => ({
      x: isl.x ?? isl.position?.x ?? 0,
      z: isl.z ?? isl.position?.z ?? 0,
    }));
    /** @type {AIAgent[]} */
    this._agents       = [];
    this._respawnQueue = [];
    /** @type {Object.<string,number>} faction → seconds remaining angry */
    this._angeredFactions = {};

    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== Faction.PLAYER) {
        this._scheduleRespawn(ship.faction);
        this._agents = this._agents.filter(a => a.ship !== ship);
      }
      // Sinking a Merchant angers the Dutch faction for 3 minutes
      if (ship.faction === Faction.MERCHANT) {
        this._angeredFactions[Faction.DUTCH] = 180;
        EventEmitter.emit('faction:angered', { faction: Faction.DUTCH, duration: 180 });
      }
    });

    // Night — detection range decreases, aggression increases
    EventEmitter.on('sky:night', () => {
      AIAgent.nightMultiplier = 0.60;
      // Fire 20 % faster at night
      for (const a of this._agents) {
        if (!a._nightAdjusted) {
          a._cfg.fireCooldown *= 0.80;
          a._nightAdjusted = true;
        }
      }
    });
    EventEmitter.on('sky:day', () => {
      AIAgent.nightMultiplier = 1.0;
      for (const a of this._agents) {
        if (a._nightAdjusted) {
          // Restore base fire cooldown
          const base = PersonalityConfig[a.personality] ?? PersonalityConfig.NAVY;
          a._cfg.fireCooldown = base.fireCooldown;
          a._nightAdjusted = false;
        }
      }
    });
  }

  /** Register an existing ship in the AI system. */
  registerShip(ship, personality = 'NAVY') {
    const agent = new AIAgent(ship, personality, this._islandPositions, this._islands);
    this._agents.push(agent);
    return agent;
  }


  /** Spawn initial enemy ships — called once after world init. */
  spawnInitialEnemies() {
    const spawnCounts = {
      [Faction.BRITISH]:       3,
      [Faction.SPANISH]:       2,
      [Faction.DUTCH]:         2,
      [Faction.MERCHANT]:      4,
      [Faction.PIRATE_HUNTER]: 1,
    };

    for (const [faction, count] of Object.entries(spawnCounts)) {
      for (let i = 0; i < count; i++) {
        this._spawnEnemy(faction);
      }
    }

    // Organise NAVY-personality ships into 2-ship squadrons (1 leader + wingman)
    this._assignSquadrons();
  }

  /**
   * Groups NAVY agents into squadrons: every 2nd NAVY ship becomes a wingman
   * that follows the previous one (the leader) into combat.
   */
  _assignSquadrons() {
    const navy = this._agents.filter(a => a.personality === 'NAVY');
    for (let i = 1; i < navy.length; i += 2) {
      navy[i]._leader = navy[i - 1];   // every odd ship follows the even one
    }
  }

  _spawnEnemy(faction) {
    const cls         = FactionShipClass[faction];
    const personality = FactionPersonality[faction] ?? 'NAVY';
    const half        = GameConfig.WORLD_SIZE / 2 - 80;
    const x           = randRange(-half, half);
    const z           = randRange(-half, half);

    const ship  = this._shipSystem.createShip(cls, faction, x, z);
    const agent = new AIAgent(ship, personality, this._islandPositions, this._islands);
    this._agents.push(agent);
    return ship;
  }

  _scheduleRespawn(faction) {
    // Pirate Hunter is a rare boss — takes 3× longer
    const delay = faction === Faction.PIRATE_HUNTER
      ? GameConfig.AI_RESPAWN_DELAY * 3
      : GameConfig.AI_RESPAWN_DELAY;
    this._respawnQueue.push({ faction, timer: delay });
  }

  /** @param {number} delta */
  update(delta, playerPos) {
    if (!playerPos) return;

    // ── Tick angered-faction timers ────────────────────────────────────────────
    for (const [f, t] of Object.entries(this._angeredFactions)) {
      this._angeredFactions[f] = t - delta;
      if (this._angeredFactions[f] <= 0) {
        delete this._angeredFactions[f];
        EventEmitter.emit('faction:pacified', { faction: f });
      }
    }
    // Apply diplomatic boost to Dutch agents
    const dutchAngry = !!this._angeredFactions[Faction.DUTCH];
    for (const a of this._agents) {
      if (a.ship.faction === Faction.DUTCH) a._diplomaticBoost = dutchAngry;
    }
    this._difficultyTimer = (this._difficultyTimer || 0) + delta;
    if (this._difficultyTimer >= 120) {
      this._difficultyTimer -= 120;
      this._difficultyLevel = (this._difficultyLevel || 0) + 1;
      // Spawn one extra enemy from a random existing faction
      const factions = [...new Set(this._agents.map(a => a._faction))].filter(Boolean);
      if (factions.length > 0) {
        const f = factions[Math.floor(Math.random() * factions.length)];
        this._spawnEnemy(f);
      }
      // Each agent fires 5 % faster (cap reduction at 60 % of original)
      for (const agent of this._agents) {
        if (agent._cfg) {
          agent._cfg.fireCooldown = Math.max(
            agent._cfg.fireCooldown * 0.4,
            agent._cfg.fireCooldown * 0.95,
          );
        }
      }
    }

    for (const agent of this._agents) {
      agent.update(delta, playerPos, this._combatSystem);
    }

    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      this._respawnQueue[i].timer -= delta;
      if (this._respawnQueue[i].timer <= 0) {
        this._spawnEnemy(this._respawnQueue[i].faction);
        this._respawnQueue.splice(i, 1);
      }
    }
  }

  get agentCount() { return this._agents.length; }
}

export default AISystem;
