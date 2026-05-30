/**
 * ShipConfig — defines every ship class and its base stats.
 */

/** Faction identifiers */
export const Faction = {
  PLAYER:        'PLAYER',
  BRITISH:       'BRITISH',
  SPANISH:       'SPANISH',
  DUTCH:         'DUTCH',
  PIRATE:        'PIRATE',
  MERCHANT:      'MERCHANT',       // civilian cargo ships — flees, huge loot
  PIRATE_HUNTER: 'PIRATE_HUNTER',  // boss-class aggressive pursuer
};

/** Ship class identifiers */
export const ShipClass = {
  PIRATE_SMALL:  'PIRATE_SMALL',
  PIRATE_MEDIUM: 'PIRATE_MEDIUM',
  PIRATE_LARGE:  'PIRATE_LARGE',
  SMALL:         'SMALL',
  MEDIUM:        'MEDIUM',
  LARGE:         'LARGE',
  GHOST:         'GHOST',
  WRECK:         'WRECK',
  MERCHANT:      'MERCHANT',
  PIRATE_HUNTER: 'PIRATE_HUNTER',
};

/**
 * Base stats for each ship class.
 * speed       — units per second at full throttle
 * turnRate    — radians per second
 * maxHealth   — hit points
 * armor       — flat damage reduction per hit (0–15)
 * cannonPower — base damage per cannonball
 * crew        — starting crew count
 * modelKey    — GLB asset key used by AssetLoader
 * scale       — uniform scale applied to the loaded model
 */
export const ShipStats = {
  [ShipClass.PIRATE_SMALL]: {
    speed: 24,
    turnRate: 1.8,
    maxHealth: 80,
    armor: 2,
    cannonPower: 18,
    crew: 12,
    modelKey: 'ship-pirate-small',
    scale: 1.0,
    color: 0x8b2222,
  },
  [ShipClass.PIRATE_MEDIUM]: {
    speed: 18,
    turnRate: 1.3,
    maxHealth: 150,
    armor: 5,
    cannonPower: 28,
    crew: 30,
    modelKey: 'ship-pirate-medium',
    scale: 1.0,
    color: 0x8b2222,
  },
  [ShipClass.PIRATE_LARGE]: {
    speed: 12,
    turnRate: 0.9,
    maxHealth: 280,
    armor: 10,
    cannonPower: 45,
    crew: 60,
    modelKey: 'ship-pirate-large',
    scale: 1.0,
    color: 0x8b2222,
  },
  [ShipClass.SMALL]: {
    speed: 22,
    turnRate: 1.6,
    maxHealth: 50,
    armor: 0,
    cannonPower: 15,
    crew: 10,
    modelKey: 'ship-small',
    scale: 1.0,
    color: 0x2244aa,
  },
  [ShipClass.MEDIUM]: {
    speed: 16,
    turnRate: 1.2,
    maxHealth: 50,
    armor: 0,
    cannonPower: 25,
    crew: 25,
    modelKey: 'ship-medium',
    scale: 1.0,
    color: 0x2244aa,
  },
  [ShipClass.LARGE]: {
    speed: 10,
    turnRate: 0.8,
    maxHealth: 55,
    armor: 0,
    cannonPower: 40,
    crew: 55,
    modelKey: 'ship-large',
    scale: 1.0,
    color: 0xcc8820,
  },
  [ShipClass.GHOST]: {
    speed: 20,
    turnRate: 1.5,
    maxHealth: 80,
    armor: 0,
    cannonPower: 50,
    crew: 0,
    modelKey: 'ship-ghost',
    scale: 1.1,
    color: 0x60e0c0,
    isBoss: true,
  },

  // ── Civilian merchant — slow, unarmed, flees the player ───────────────────
  [ShipClass.MERCHANT]: {
    speed: 11,
    turnRate: 0.8,
    maxHealth: 45,
    armor: 0,
    cannonPower: 0,   // no weapons
    crew: 22,
    modelKey: 'ship-large',
    scale: 0.95,
    color: 0x997744,
  },

  // ── Pirate Hunter — fast, aggressive, high damage, boss-tier ─────────────
  [ShipClass.PIRATE_HUNTER]: {
    speed: 26,
    turnRate: 1.9,
    maxHealth: 70,
    armor: 2,
    cannonPower: 32,
    crew: 18,
    modelKey: 'ship-pirate-medium',
    scale: 1.05,
    color: 0x111111,
    isBoss: true,
  },
};

/** Map faction → ship class used at spawn */
export const FactionShipClass = {
  [Faction.BRITISH]:      ShipClass.MEDIUM,
  [Faction.SPANISH]:      ShipClass.LARGE,
  [Faction.DUTCH]:        ShipClass.SMALL,
  [Faction.PIRATE]:       ShipClass.PIRATE_SMALL,
  [Faction.MERCHANT]:     ShipClass.MERCHANT,
  [Faction.PIRATE_HUNTER]:ShipClass.PIRATE_HUNTER,
};

/**
 * AI personality per faction — drives behaviour in AISystem.
 *   NAVY     — standard patrol/alert/chase/attack/retreat
 *   MERCHANT — flees immediately, never fires, big loot reward
 *   HUNTER   — skip ALERT, extended detection, faster fire, alternates broadsides
 */
export const FactionPersonality = {
  [Faction.BRITISH]:      'NAVY',
  [Faction.SPANISH]:      'NAVY',
  [Faction.DUTCH]:        'NAVY',
  [Faction.PIRATE]:       'NAVY',
  [Faction.MERCHANT]:     'MERCHANT',
  [Faction.PIRATE_HUNTER]:'HUNTER',
};

export default ShipStats;
