/**
 * WorldEventSystem — Living ocean simulation.
 *
 * Runs a weighted-random event engine that fires world events every 30–90s.
 * In co-op, the HOST broadcasts events to the CLIENT via MultiplayerSystem.
 *
 * Events:
 *   MERCHANT_CONVOY     — slow merchants cross the map (attackable for loot)
 *   NAVY_PATROL         — navy ships patrol between islands
 *   GHOST_FLEET         — spectral ships emerge after nightfall
 *   LEGENDARY_CAPTAIN   — named boss spawns with Nemesis memory
 *   TREASURE_CONVOY     — heavily-guarded treasure ships
 *   STORM_SURGE         — intensifies current storm or triggers one
 *   PIRATE_AMBUSH       — pirates attack a merchant
 *   SEA_MONSTER_WARNING — kraken tentacle warning (visual + danger zone)
 *   ISLAND_RAID         — AI attacks a player island
 *   BOUNTY_HUNTER       — pursuer targets player if reputation > 500
 */

import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';
import { randRange } from '../utils/MathUtils.js';
import { Faction, ShipClass } from '../config/ShipConfig.js';

// ── Event pool ────────────────────────────────────────────────────────────────
const EVENT_POOL = [
  { type: 'MERCHANT_CONVOY',    weight: 20, minRep: 0   },
  { type: 'NAVY_PATROL',        weight: 18, minRep: 0   },
  { type: 'PIRATE_AMBUSH',      weight: 15, minRep: 0   },
  { type: 'GHOST_FLEET',        weight: 8,  minRep: 0   },
  { type: 'LEGENDARY_CAPTAIN',  weight: 6,  minRep: 200 },
  { type: 'TREASURE_CONVOY',    weight: 8,  minRep: 0   },
  { type: 'STORM_SURGE',        weight: 10, minRep: 0   },
  { type: 'SEA_MONSTER_WARNING',weight: 5,  minRep: 0   },
  { type: 'BOUNTY_HUNTER',      weight: 6,  minRep: 500 },
  { type: 'ISLAND_RAID',        weight: 5,  minRep: 100 },
];

// ── Legendary captain roster ──────────────────────────────────────────────────
export const LEGENDARY_CAPTAINS = [
  {
    id:       'ironjaw',
    name:     'Ironjaw McGee',
    title:    'The Iron Pirate',
    shipClass: ShipClass.PIRATE_LARGE,
    faction:   Faction.PIRATE,
    hpMult:   1.8,
    speedMult:1.2,
    dialogues: [
      "I remember you, sailor. Your hull won't survive this time.",
      "You sank me before? IMPRESSIVE. No one does it twice.",
      "Every defeat makes me STRONGER. Come, face the Iron Pirate!",
    ],
    angerLevel: 0,
    timesDefeated: 0,
  },
  {
    id:       'pale_duchess',
    name:     'The Pale Duchess',
    title:    'Ghost of the Seven Seas',
    shipClass: ShipClass.GHOST,
    faction:   Faction.PIRATE,
    hpMult:   1.5,
    speedMult: 1.3,
    dialogues: [
      "You dare sail into MY mist?",
      "I have sunk a thousand ships. Yours will be a thousand and one.",
      "The dead do not forgive, sailor...",
    ],
    angerLevel: 0,
    timesDefeated: 0,
  },
  {
    id:        'el_tiburon',
    name:      'El Tiburón',
    title:     'The Spanish Shark',
    shipClass: ShipClass.LARGE,
    faction:   Faction.SPANISH,
    hpMult:   2.0,
    speedMult: 1.4,
    dialogues: [
      "¡Ahora mueres, pirata!",
      "The Spanish Navy does not forget its enemies.",
      "You escaped me once. The ocean is not so large.",
    ],
    angerLevel: 0,
    timesDefeated: 0,
  },
];

// ── Nemesis memory (persisted across sessions in localStorage) ─────────────────
function loadNemesisMemory() {
  try {
    const raw = localStorage.getItem('pe_nemesis_memory');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveNemesisMemory(memory) {
  try {
    localStorage.setItem('pe_nemesis_memory', JSON.stringify(memory));
  } catch {}
}

// ── WorldEventSystem class ─────────────────────────────────────────────────────
export class WorldEventSystem {
  /**
   * @param {import('./ShipSystem.js').ShipSystem} ships
   * @param {import('./AISystem.js').AISystem} ai
   * @param {import('../main.js').Game} game     — for world state access
   */
  constructor(ships, ai, game) {
    this.ships = ships;
    this.ai    = ai;
    this.game  = game;

    this._eventTimer = 30 + Math.random() * 30;  // first event 30-60s in
    this._gameTime   = 0;   // total elapsed seconds

    this._playerReputation = 0;  // grows with kills and captures

    // Active special ships spawned by events
    this._legendaryShip  = null;
    this._ghostFleet     = [];
    this._convoyShips    = [];
    this._kraken         = null;   // tentacle object
    this._krakenTimer    = 0;

    // Nemesis memory loaded from localStorage
    this._nemesisMemory = loadNemesisMemory();
    this._applyNemesisMemory();

    // Listen for kill events to track reputation
    EventEmitter.on('ship:destroyed', (data) => this._onShipDestroyed(data));

    // For minimap dot rendering
    this.specialMarkers = [];  // { x, z, color, label }
  }

  // ── Main tick ──────────────────────────────────────────────────────────────

  /**
   * @param {number} delta
   * @param {THREE.Vector3|null} playerPos
   */
  update(delta, playerPos) {
    this._gameTime    += delta;
    this._eventTimer  -= delta;
    this._krakenTimer -= delta;

    // Trigger next world event
    // In co-op mode the CLIENT never spawns ships independently — the HOST broadcasts
    // all AI state via the AI sync packets. Only tick the event timer on the host/standalone.
    const isCoopClient = this.game?.isCoop && this.game?.mp?.isClient;
    if (this._eventTimer <= 0) {
      this._eventTimer = 30 + Math.random() * 60;   // next: 30–90s
      if (!isCoopClient) {
        this._triggerRandomEvent(playerPos);
      }
    }

    // Kraken tentacle pulse
    if (this._kraken && this._krakenTimer <= 0) {
      this._updateKraken(delta);
    }

    // Update ghost fleet (cyan glow pulsing)
    for (const ghost of this._ghostFleet) {
      if (ghost.group) {
        const t = this._gameTime * 2;
        ghost.group.traverse(child => {
          if (child.isMesh && child.material?.emissive) {
            child.material.emissiveIntensity = 0.4 + Math.sin(t) * 0.3;
          }
        });
      }
    }
  }

  // ── Event dispatch ──────────────────────────────────────────────────────────

  _triggerRandomEvent(playerPos) {
    const available = EVENT_POOL.filter(e => e.minRep <= this._playerReputation);
    const totalWeight = available.reduce((s, e) => s + e.weight, 0);
    let roll = Math.random() * totalWeight;
    let chosen = null;
    for (const e of available) {
      roll -= e.weight;
      if (roll <= 0) { chosen = e; break; }
    }
    if (!chosen) chosen = available[0];

    console.log(`[WorldEvent] Triggering: ${chosen.type}`);
    this._broadcastWorldLog(`📻 [World] ${this._getEventMessage(chosen.type)}`);
    this._executeEvent(chosen.type, playerPos);
    EventEmitter.emit('world:event', { type: chosen.type });
  }

  _executeEvent(type, playerPos) {
    const px = playerPos?.x ?? 0;
    const pz = playerPos?.z ?? 0;

    switch (type) {
      case 'MERCHANT_CONVOY':    this._spawnMerchantConvoy(px, pz);    break;
      case 'NAVY_PATROL':        this._spawnNavyPatrol(px, pz);        break;
      case 'PIRATE_AMBUSH':      this._spawnPirateAmbush(px, pz);      break;
      case 'GHOST_FLEET':        this._spawnGhostFleet(px, pz);        break;
      case 'LEGENDARY_CAPTAIN':  this._spawnLegendaryCaptain(px, pz);  break;
      case 'TREASURE_CONVOY':    this._spawnTreasureConvoy(px, pz);    break;
      case 'STORM_SURGE':        this._triggerStormSurge();            break;
      case 'SEA_MONSTER_WARNING':this._spawnSeaMonsterWarning(px, pz); break;
      case 'BOUNTY_HUNTER':      this._spawnBountyHunter(playerPos);   break;
      case 'ISLAND_RAID':        this._triggerIslandRaid(px, pz);      break;
    }
  }

  // ── Individual event implementations ───────────────────────────────────────

  _spawnMerchantConvoy(px, pz) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 300 + Math.random() * 100;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    // Spawn 3 merchants + 2 navy escorts
    for (let i = 0; i < 3; i++) {
      const ship = this.ships.createShip(ShipClass.MERCHANT, Faction.MERCHANT, sx + i * 15, sz + i * 10);
      if (ship) {
        this._convoyShips.push(ship);
        if (this.ai) this.ai.registerShip(ship, 'MERCHANT');
      }
    }
    for (let i = 0; i < 2; i++) {
      const escort = this.ships.createShip(ShipClass.MEDIUM, Faction.BRITISH, sx + 30 + i * 15, sz);
      if (escort) {
        this._convoyShips.push(escort);
        if (this.ai) this.ai.registerShip(escort, 'NAVY');
      }
    }

    this.specialMarkers.push({ id: 'convoy_' + Date.now(), x: sx, z: sz, color: '#ffcc44', label: '🚢 Convoy' });
    const markerId = this.specialMarkers[this.specialMarkers.length - 1].id;
    setTimeout(() => this.specialMarkers = this.specialMarkers.filter(m => m.id !== markerId), 60000);
  }

  _spawnNavyPatrol(px, pz) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 200 + Math.random() * 150;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    for (let i = 0; i < 3; i++) {
      const ship = this.ships.createShip(ShipClass.MEDIUM, Faction.BRITISH, sx + i * 20, sz);
      if (ship && this.ai) this.ai.registerShip(ship, 'NAVY');
    }
  }

  _spawnPirateAmbush(px, pz) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 180 + Math.random() * 100;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    // Pirates attack a merchant
    const merchant = this.ships.createShip(ShipClass.MERCHANT, Faction.MERCHANT, sx, sz);
    if (merchant && this.ai) this.ai.registerShip(merchant, 'MERCHANT');
    for (let i = 0; i < 2; i++) {
      const pirate = this.ships.createShip(ShipClass.PIRATE_SMALL, Faction.PIRATE, sx + 30 + i * 15, sz + 15);
      if (pirate && this.ai) this.ai.registerShip(pirate, 'NAVY');
    }
  }

  _spawnGhostFleet(px, pz) {
    // Only spawn ghost fleet at night (after 2 min game time)
    const isNight = this._gameTime > 120;
    if (!isNight) return;  // ghosts don't walk in daylight
    if (this._ghostFleet.length > 0) return; // only one ghost fleet active at a time

    const angle = Math.random() * Math.PI * 2;
    const dist  = 250;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    this._ghostFleet = [];
    for (let i = 0; i < 3; i++) {
      const ship = this.ships.createShip(ShipClass.GHOST, Faction.PIRATE, sx + i * 25, sz + i * 10);
      if (ship) {
        // Apply ghost material — cyan emissive glow
        ship.group.traverse(child => {
          if (child.isMesh && child.material) {
            child.material = child.material.clone();
            child.material.emissive    = new THREE.Color(0x00ffcc);
            child.material.emissiveIntensity = 0.5;
            child.material.transparent = true;
            child.material.opacity     = 0.75;
          }
        });
        ship._isGhost = true;
        this._ghostFleet.push(ship);
        if (this.ai) this.ai.registerShip(ship, 'HUNTER');
      }
    }

    // Ghost fleet auto-despawns after 3 minutes
    setTimeout(() => {
      for (const g of this._ghostFleet) {
        if (g.isAlive) g.takeDamage(9999);
      }
      this._ghostFleet = [];
    }, 180_000);

    this.specialMarkers.push({ id: 'ghost_' + Date.now(), x: sx, z: sz, color: '#00ffcc', label: '👻 Ghost Fleet' });
    const ghostMarkerId = this.specialMarkers[this.specialMarkers.length - 1].id;
    setTimeout(() => this.specialMarkers = this.specialMarkers.filter(m => m.id !== ghostMarkerId), 30000);
  }

  _spawnLegendaryCaptain(px, pz) {
    // Pick a captain who hasn't spawned recently
    const cap = LEGENDARY_CAPTAINS[Math.floor(Math.random() * LEGENDARY_CAPTAINS.length)];
    const mem = this._nemesisMemory[cap.id] || { timesDefeated: 0, angerLevel: 0 };

    // Anger level increases with each defeat — makes them stronger
    const angerBoost = 1 + mem.angerLevel * 0.15;

    const angle = Math.random() * Math.PI * 2;
    const dist  = 350;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    const ship = this.ships.createShip(cap.shipClass, cap.faction, sx, sz);
    if (!ship) return;

    // Apply anger-boosted stats
    ship.maxHealth = Math.round(ship.maxHealth * cap.hpMult * angerBoost);
    ship.health    = ship.maxHealth;
    ship.speed     = ship.speed * cap.speedMult * Math.min(angerBoost, 1.5);
    ship._legendaryId   = cap.id;
    ship._legendaryName = cap.name;
    ship._legendaryMem  = mem;

    if (this.ai) {
      const personality = cap.faction === Faction.PIRATE_HUNTER ? 'HUNTER' : 'NAVY';
      this.ai.registerShip(ship, personality);
    }

    // Make visually distinct — gold trim
    ship.group.traverse(child => {
      if (child.isMesh && child.material) {
        child.material = child.material.clone();
        child.material.emissive = new THREE.Color(0xffaa00);
        child.material.emissiveIntensity = 0.3;
      }
    });

    // Show their dialogue
    const dialogue = cap.dialogues[Math.min(mem.timesDefeated, cap.dialogues.length - 1)];
    setTimeout(() => {
      EventEmitter.emit('world:legendary_dialogue', {
        name: cap.name,
        title: cap.title,
        text: dialogue,
        angerLevel: mem.angerLevel,
      });
    }, 2000);

    this._legendaryShip = ship;
    const legendMarkerId = 'legendary_' + Date.now();
    this.specialMarkers.push({ id: legendMarkerId, x: sx, z: sz, color: '#ffaa00', label: `💀 ${cap.name}` });
    setTimeout(() => this.specialMarkers = this.specialMarkers.filter(m => m.id !== legendMarkerId), 60000);

    // Listen for when this captain is destroyed — use once() to avoid stacking listeners
    EventEmitter.once('ship:destroyed', (data) => {
      if (data.ship === ship) {
        mem.timesDefeated++;
        mem.angerLevel = Math.min(10, mem.angerLevel + 1);
        this._nemesisMemory[cap.id] = mem;
        saveNemesisMemory(this._nemesisMemory);
        EventEmitter.emit('world:legendary_defeated', { cap, mem });
        this._legendaryShip = null;
      }
    });
  }

  _spawnTreasureConvoy(px, pz) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 280;
    const sx = px + Math.cos(angle) * dist;
    const sz = pz + Math.sin(angle) * dist;

    // One rich merchant + 3 escorts
    const treasure = this.ships.createShip(ShipClass.MERCHANT, Faction.MERCHANT, sx, sz);
    if (treasure) {
      treasure._isTreasure  = true;
      treasure._treasureGold = 500 + Math.floor(Math.random() * 300);
      if (this.ai) this.ai.registerShip(treasure, 'MERCHANT');
    }
    for (let i = 0; i < 3; i++) {
      const escort = this.ships.createShip(ShipClass.LARGE, Faction.BRITISH, sx + 30 + i * 20, sz + 20);
      if (escort && this.ai) this.ai.registerShip(escort, 'NAVY');
    }

    const treasureMarkerId = 'treasure_' + Date.now();
    this.specialMarkers.push({ id: treasureMarkerId, x: sx, z: sz, color: '#ffd700', label: '💰 Treasure!' });
    setTimeout(() => this.specialMarkers = this.specialMarkers.filter(m => m.id !== treasureMarkerId), 90000);
  }

  _triggerStormSurge() {
    EventEmitter.emit('world:storm_surge');
    // Tell game to intensify the storm
    if (this.game._stormActive) {
      this.game._stormDuration = Math.max(this.game._stormDuration, 40);
    } else {
      this.game._stormTimer    = 0;   // trigger storm immediately
      this.game._stormActive   = true;
      this.game._stormDuration = 45;
    }
  }

  _spawnSeaMonsterWarning(px, pz) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 150 + Math.random() * 100;
    const kx = px + Math.cos(angle) * dist;
    const kz = pz + Math.sin(angle) * dist;

    // Spawn visual tentacle effect — a large dark cylinder rising from the ocean
    const geometry = new THREE.CylinderGeometry(3, 6, 30, 8);
    const material = new THREE.MeshPhongMaterial({
      color:     0x1a0a2e,
      emissive:  new THREE.Color(0x200050),
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.85,
    });

    const tentacles = [];
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      const a2   = (i / 4) * Math.PI * 2;
      mesh.position.set(kx + Math.cos(a2) * 20, -15, kz + Math.sin(a2) * 20);
      mesh.rotation.z = (Math.random() - 0.5) * 0.5;
      this.game.scene.add(mesh);
      tentacles.push(mesh);
    }

    this._kraken = { tentacles, x: kx, z: kz, riseTimer: 0, phase: 'rising' };
    this._krakenTimer = 0;

    this.specialMarkers.push({ x: kx, z: kz, color: '#8800ff', label: '🦑 Kraken!' });

    // Auto-despawn after 60 seconds
    setTimeout(() => {
      if (this._kraken) {
        for (const t of this._kraken.tentacles) {
          this.game.scene.remove(t);
          t.geometry.dispose();
        }
        this._kraken = null;
        this.specialMarkers = this.specialMarkers.filter(m => !m.label.includes('Kraken'));
      }
    }, 60_000);
  }

  _updateKraken(delta) {
    if (!this._kraken) return;
    this._kraken.riseTimer += delta;
    const t = this._kraken.riseTimer;

    for (let i = 0; i < this._kraken.tentacles.length; i++) {
      const mesh   = this._kraken.tentacles[i];
      const wave   = Math.sin(t * 2 + i * 1.5) * 4;
      const riseY  = Math.min(0, -15 + t * 8);   // rises over ~2 seconds
      mesh.position.y = riseY + wave;
      mesh.rotation.z = Math.sin(t + i) * 0.3;

      // Tentacle damages nearby player ships
      if (this.game.playerShip?.isSailing) {
        const ps  = this.game.playerShip.group.position;
        const dx  = mesh.position.x - ps.x;
        const dz  = mesh.position.z - ps.z;
        if (dx * dx + dz * dz < 30 * 30) {
          this.game.playerShip.takeDamage(5 * delta * 60);
          EventEmitter.emit('world:kraken_hit');
        }
      }
    }

    this._krakenTimer = 0.05;   // update every 50ms
  }

  _spawnBountyHunter(playerPos) {
    if (!playerPos) return;
    const angle = Math.random() * Math.PI * 2;
    const dist  = 400;
    const sx = playerPos.x + Math.cos(angle) * dist;
    const sz = playerPos.z + Math.sin(angle) * dist;

    const hunter = this.ships.createShip(ShipClass.PIRATE_HUNTER, Faction.PIRATE_HUNTER, sx, sz);
    if (hunter) {
      hunter._isBountyHunter = true;
      // Hunter speed scales with player reputation
      hunter.speed *= (1 + Math.min(0.5, this._playerReputation / 2000));

      // Red visual tint
      hunter.group.traverse(child => {
        if (child.isMesh && child.material) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xff2000);
          child.material.emissiveIntensity = 0.25;
        }
      });
      if (this.ai) this.ai.registerShip(hunter, 'HUNTER');
    }
  }

  _triggerIslandRaid(px, pz) {
    const capturedIslands = this.game._islands?.filter(
      isl => isl.captured && isl.owner === 'PLAYER'
    );
    if (!capturedIslands?.length) return;

    const target = capturedIslands[Math.floor(Math.random() * capturedIslands.length)];
    const ix = target.position?.x ?? 0;
    const iz = target.position?.z ?? 0;

    // Spawn raiders near the island
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const sx = ix + Math.cos(angle) * 80;
      const sz = iz + Math.sin(angle) * 80;
      const raider = this.ships.createShip(ShipClass.PIRATE_MEDIUM, Faction.PIRATE, sx, sz);
      if (raider && this.ai) this.ai.registerShip(raider, 'NAVY');
    }

    const raidMarkerId = 'raid_' + Date.now();
    this.specialMarkers.push({ id: raidMarkerId, x: ix, z: iz, color: '#ff4444', label: '🔥 Island Raid!' });
    setTimeout(() => this.specialMarkers = this.specialMarkers.filter(m => m.id !== raidMarkerId), 45000);
    EventEmitter.emit('world:island_raid', { island: target });
  }

  // ── Reputation tracking ──────────────────────────────────────────────────────

  _onShipDestroyed(data) {
    // Gain reputation for sinking enemy ships
    if (!data?.ship) return;
    const fac = data.ship.faction;
    if (fac === Faction.PLAYER) return;

    const repGain = fac === Faction.PIRATE_HUNTER ? 50
                  : fac === Faction.MERCHANT       ? 10
                  : 20;
    this._playerReputation = Math.min(6000, this._playerReputation + repGain);
    EventEmitter.emit('world:reputation_changed', { rep: this._playerReputation });
  }

  // ── Nemesis memory ──────────────────────────────────────────────────────────

  _applyNemesisMemory() {
    for (const cap of LEGENDARY_CAPTAINS) {
      if (this._nemesisMemory[cap.id]) {
        cap.angerLevel     = this._nemesisMemory[cap.id].angerLevel    ?? 0;
        cap.timesDefeated  = this._nemesisMemory[cap.id].timesDefeated ?? 0;
      }
    }
  }

  // ── World log broadcast ─────────────────────────────────────────────────────

  _broadcastWorldLog(text) {
    // Show on this client
    EventEmitter.emit('world:log', text);
    // If co-op host, send to partner
    if (this.game.isCoop && this.game.mp?.isHost) {
      this.game.mp.sendWorldEvent(text);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get reputation() { return this._playerReputation; }

  getReputationTitle() {
    const r = this._playerReputation;
    if (r >= 6000) return 'THE DREAD CAPTAIN';
    if (r >= 3000) return 'Legendary Privateer';
    if (r >= 1500) return 'Feared Raider';
    if (r >= 500)  return 'Known Pirate';
    return 'Unknown Sailor';
  }

  _getEventMessage(type) {
    const msgs = {
      MERCHANT_CONVOY:     'A merchant convoy has been spotted crossing the ocean!',
      NAVY_PATROL:         'A Navy patrol fleet has entered these waters.',
      PIRATE_AMBUSH:       'Pirates are attacking a merchant ship nearby!',
      GHOST_FLEET:         '👻 A Ghost Fleet has emerged from the cursed mist!',
      LEGENDARY_CAPTAIN:   '💀 A Legendary Captain has been spotted on the horizon!',
      TREASURE_CONVOY:     '💰 A treasure convoy has been spotted — heavily guarded!',
      STORM_SURGE:         '🌩️ A massive storm surge is sweeping across the ocean!',
      SEA_MONSTER_WARNING: '🦑 The ocean churns... something vast stirs below!',
      BOUNTY_HUNTER:       '🎯 A Bounty Hunter has set course for YOUR ship!',
      ISLAND_RAID:         '🔥 Your island is under attack!',
    };
    return msgs[type] ?? 'Something stirs in the ocean...';
  }
}

export default WorldEventSystem;
