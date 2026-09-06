/**
 * GameConfig — all global game constants.
 * Adjust here to tune gameplay without touching system code.
 */
export const GameConfig = {

  // ── World ─────────────────────────────────────────────
  WORLD_SIZE: 2000,         // ocean plane side length
  ISLAND_COUNT: 18,         // total islands to generate
  ENEMY_COUNT: 10,          // starting enemy ships
  SPAWN_MARGIN: 80,         // keep entities this far from world edge

  // ── Camera ────────────────────────────────────────────
  CAMERA_OFFSET_X: 0,
  CAMERA_OFFSET_Y: 25,      // height above ship
  CAMERA_OFFSET_Z: 40,      // distance behind ship — naval game angle
  CAMERA_LAG: 0.06,         // lerp factor for smooth follow

  // ── Player ────────────────────────────────────────────
  PLAYER_START_GOLD: 250,
  PLAYER_START_CREW: 20,
  PLAYER_START_WOOD: 50,

  // ── Economy ───────────────────────────────────────────
  PASSIVE_GOLD_PER_ISLAND: 50,   // gold per tick
  PASSIVE_GOLD_INTERVAL: 60,     // seconds between ticks
  LOOT_MIN: 30,
  LOOT_MAX: 120,
  CHEST_LOOT_MIN: 50,
  CHEST_LOOT_MAX: 200,

  // ── Islands ───────────────────────────────────────────
  ISLAND_MIN_DISTANCE: 120,    // minimum gap between islands
  ISLAND_CAPTURE_RADIUS: 30,   // how close player must be to capture
  FORTIFIED_ISLAND_COUNT: 5,   // islands that start with defences

  // ── Combat ────────────────────────────────────────────
  CANNONBALL_SPEED: 60,
  CANNONBALL_LIFETIME: 4,       // seconds
  CANNON_FIRE_COOLDOWN: 2.5,    // player cannon recharge (seconds)
  SHIP_COLLISION_RADIUS: 5,     // bounding sphere for cannonball hits
  SINKING_DURATION: 6,          // seconds a ship takes to sink

  // ── AI ────────────────────────────────────────────────
  AI_PATROL_SPEED_FACTOR: 0.55,  // fraction of max speed while patrolling
  AI_CHASE_SPEED_FACTOR: 0.85,
  AI_DETECT_RANGE: 220,
  AI_CHASE_RANGE: 180,
  AI_ATTACK_RANGE: 60,
  AI_LOSE_RANGE: 300,
  AI_FIRE_COOLDOWN: 3.8,         // enemy cannon reload (seconds, rebalanced for fairer combat)
  AI_AIM_SPREAD: 0.18,           // angular inaccuracy for enemy broadsides (radians, ~10°)
  AI_CANNONBALL_SPEED_FACTOR: 0.88, // enemy cannonballs are slightly more dodgable
  AI_RESPAWN_DELAY: 30,
  AI_RETREAT_HEALTH_PCT: 0.20,   // retreat when HP drops below this fraction
  // ── Building costs ────────────────────────────────────
  BUILD_COSTS: {
    WATCH_TOWER:  { gold: 500 },
    DEFENSE_CANNON: { gold: 800 },
    SHIPYARD:     { gold: 1500 },
    TREASURE_VAULT: { gold: 2000 },
  },

  // ── Upgrade costs / bonuses ───────────────────────────
  UPGRADES: [
    { id: 'speed_1',  label: '⛵ Speed I',      stat: 'speed',       bonus: 0.15, cost: { gold: 300 } },
    { id: 'speed_2',  label: '⛵ Speed II',     stat: 'speed',       bonus: 0.20, cost: { gold: 700 }, requires: 'speed_1' },
    { id: 'hull_1',   label: '🛡 Hull I',       stat: 'maxHealth',   bonus: 0.20, cost: { gold: 400 } },
    { id: 'hull_2',   label: '🛡 Hull II',      stat: 'maxHealth',   bonus: 0.25, cost: { gold: 900 }, requires: 'hull_1' },
    { id: 'cannon_1', label: '💣 Cannons I',    stat: 'cannonPower', bonus: 0.20, cost: { gold: 500 } },
    { id: 'cannon_2', label: '💣 Cannons II',   stat: 'cannonPower', bonus: 0.25, cost: { gold: 1100 }, requires: 'cannon_1' },
    { id: 'rate_1',   label: '🔥 Fire Rate I',  stat: 'fireRate',    bonus: 0.25, cost: { gold: 600 } },
    { id: 'ship_medium', label: '🚢 Brigantine',  stat: 'shipClass', shipClass: 'PIRATE_MEDIUM', cost: { gold: 2000 }, requires: 'hull_1' },
    { id: 'ship_large',  label: '⛵ Galleon',      stat: 'shipClass', shipClass: 'PIRATE_LARGE',  cost: { gold: 5000 }, requires: 'ship_medium' },
  ],

  // ── Loot values per faction ship ─────────────────────────
  // gold: random range.  crew/wood: max random bonus resources awarded.
  FACTION_LOOT: {
    BRITISH:      { min: 60,  max: 140, crew: 3, wood: 5  },
    SPANISH:      { min: 80,  max: 180, crew: 5, wood: 8  },
    DUTCH:        { min: 40,  max: 100, crew: 2, wood: 10 },
    PIRATE:       { min: 50,  max: 120, crew: 2, wood: 3  },
    MERCHANT:     { min: 150, max: 280, crew: 8, wood: 18 },  // rich cargo ship
    PIRATE_HUNTER:{ min: 200, max: 450, crew: 5, wood: 5  },  // boss reward
  },

  // ── Asset base path ──────────────────────────────────
  ASSET_BASE: 'kenney_pirate-kit/Models/GLB format/',
  TEXTURE_PATH: 'kenney_pirate-kit/Models/GLB format/Textures/colormap.png',
};

export default GameConfig;
