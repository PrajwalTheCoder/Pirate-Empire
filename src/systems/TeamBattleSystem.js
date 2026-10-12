/**
 * TeamBattleSystem — Complete Pirate Team Battle Game Mode
 *
 * Symmetrical Naval Warfare:
 *   West Island: Crimson Corsairs Fortress (1000 HP)
 *   Center Island: Neutral Flag Island with Capture Zone
 *   East Island: Black Tide Raiders Fortress (1000 HP)
 *
 * Objectives:
 *   1. Defend your home fortress
 *   2. Capture & hold the central neutral flag (+score)
 *   3. Destroy enemy fortress (reduce to 0 HP)
 */

import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';
import GameConfig from '../config/GameConfig.js';
import AssetLoader from './AssetLoader.js';
import { randRange, dist2D } from '../utils/MathUtils.js';

export const Team = {
  CRIMSON: 'CRIMSON',      // Crimson Corsairs
  BLACK_TIDE: 'BLACK_TIDE', // Black Tide Raiders
};

export const TeamConfig = {
  [Team.CRIMSON]: {
    name: 'Crimson Corsairs',
    tag: 'CC',
    colorHex: 0x8e3434,
    colorCss: '#8e3434',
    lightCss: '#c85a5a',
    islandPos: new THREE.Vector3(-340, 3, 0),
    dockPos: new THREE.Vector3(-280, 1, 0),
    spawnOffsets: [-28, -10, 10, 28],
    facingRad: Math.PI / 2, // Facing East toward center
  },
  [Team.BLACK_TIDE]: {
    name: 'Black Tide Raiders',
    tag: 'BTR',
    colorHex: 0x142b3a,
    colorCss: '#142b3a',
    lightCss: '#3a6280',
    islandPos: new THREE.Vector3(340, 3, 0),
    dockPos: new THREE.Vector3(280, 1, 0),
    spawnOffsets: [-28, -10, 10, 28],
    facingRad: -Math.PI / 2, // Facing West toward center
  },
};

export const MatchState = {
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  IN_PROGRESS: 'IN_PROGRESS',
  TEAM_A_VICTORY: 'TEAM_A_VICTORY',
  TEAM_B_VICTORY: 'TEAM_B_VICTORY',
  DRAW: 'DRAW',
  POST_MATCH: 'POST_MATCH',
};

export class TeamBattleSystem {
  /**
   * @param {import('../main.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.active = false;

    // Match configuration
    this.mode = '2v2'; // '2v2' | '4v4' | 'TEST'
    this.matchState = MatchState.LOBBY;
    this.matchDuration = 480; // 8 minutes (seconds)
    this.timeRemaining = this.matchDuration;
    this.targetScore = 500;
    this.scoreA = 0; // Crimson Corsairs
    this.scoreB = 0; // Black Tide Raiders

    // Home Island Fortress Health
    this.maxIslandHp = 1000;
    this.islandHpA = this.maxIslandHp;
    this.islandHpB = this.maxIslandHp;

    // Central Flag Capture State
    this.flagRadius = 50; // Capture zone radius in world units
    this.flagOwner = null; // null | Team.CRIMSON | Team.BLACK_TIDE
    this.flagProgress = 0; // -100 (Team B) to +100 (Team A)
    this.isContested = false;
    this.captureTickTimer = 0;
    this.scoreTickTimer = 0;

    // Scene Groups & Visuals
    this._mapGroup = new THREE.Group();
    this._mapGroup.name = 'team_battle_map';
    this._zoneRingMesh = null;
    this._centralFlagMesh = null;
    this._defenseCannons = [];

    // Participants & Rosters
    // Array of { id, name, team, ship, isBot, isHost, ready, shipClass }
    this.participants = [];
    this.botFillEnabled = true;
    this._botActionTimer = 0;

    // Respawn tracking
    // Map of shipId -> { timer, participant }
    this._respawnQueue = new Map();

    // Defense Cannon AI cooldowns
    this._islandCannonCooldownA = 0;
    this._islandCannonCooldownB = 0;
  }

  // ── MAP INITIALIZATION ───────────────────────────────────────────────────────

  /**
   * Build the symmetrical 3-island naval arena.
   */
  initBattlefield() {
    this.cleanBattlefield();
    this.scene.add(this._mapGroup);

    // 1. Build West Fortress (Crimson Corsairs)
    this._buildFortressIsland(Team.CRIMSON);

    // 2. Build East Fortress (Black Tide Raiders)
    this._buildFortressIsland(Team.BLACK_TIDE);

    // 3. Build Neutral Central Flag Island
    this._buildCentralIsland();

    // 4. Register island collision boundaries with ShipSystem & CombatSystem so ships and projectiles cannot enter islands
    const arenaIslands = this.getIslands();
    this.game.ships?.setIslands(arenaIslands);
    this.game.combat?.setIslands(arenaIslands);

    this.active = true;
  }

  /**
   * Return island collision descriptors for the Team Battle arena.
   */
  getIslands() {
    return [
      {
        id: 'tb_island_crimson',
        position: new THREE.Vector3(TeamConfig[Team.CRIMSON].islandPos.x, 0, TeamConfig[Team.CRIMSON].islandPos.z),
        collisionRadius: 36,
      },
      {
        id: 'tb_island_blacktide',
        position: new THREE.Vector3(TeamConfig[Team.BLACK_TIDE].islandPos.x, 0, TeamConfig[Team.BLACK_TIDE].islandPos.z),
        collisionRadius: 36,
      },
      {
        id: 'tb_island_central',
        position: new THREE.Vector3(0, 0, 0),
        collisionRadius: 28,
      },
    ];
  }

  /**
   * Build a home fortress island with castle structures, towers, cannons, and docks.
   * @param {string} team — Team.CRIMSON | Team.BLACK_TIDE
   */
  _buildFortressIsland(team) {
    const cfg = TeamConfig[team];
    const group = new THREE.Group();
    group.name = `island_${team}`;
    group.position.set(cfg.islandPos.x, 0, cfg.islandPos.z);

    // ── Solid Land Foundation ────────────────────────────────────────────────
    // Natural materials — do NOT project colormap 256-color palette onto procedural cylinders
    const sandMat = new THREE.MeshLambertMaterial({ color: 0xd6bf87 });
    const grassMat = new THREE.MeshLambertMaterial({ color: 0x3d7028 });
    const rockRimMat = new THREE.MeshLambertMaterial({ color: 0x544f46 });

    // Shoreline rock rim at water edge
    const rockGeo = new THREE.CylinderGeometry(36, 39, 1.4, 36);
    const rockBase = new THREE.Mesh(rockGeo, rockRimMat);
    rockBase.position.set(0, 0.2, 0);
    rockBase.receiveShadow = true;
    group.add(rockBase);

    // Primary sandy landmass (radius 35 at waterline)
    const baseGeo = new THREE.CylinderGeometry(34, 37, 2.6, 36);
    const baseMesh = new THREE.Mesh(baseGeo, sandMat);
    baseMesh.position.set(0, 0.8, 0);
    baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Elevated grass terrace for main keep & ramparts
    const grassGeo = new THREE.CylinderGeometry(27, 31, 1.4, 32);
    const grassPlateau = new THREE.Mesh(grassGeo, grassMat);
    grassPlateau.position.set(0, 1.9, 0);
    grassPlateau.receiveShadow = true;
    group.add(grassPlateau);

    // Natural layered Kenney sand & grass patches covering terrain surface
    const sandCenter = AssetLoader.get('patch-sand');
    sandCenter.scale.set(6.0, 2.2, 6.0);
    sandCenter.position.set(0, 1.2, 0);
    group.add(sandCenter);

    const grassCenter = AssetLoader.get('patch-grass');
    grassCenter.scale.set(4.5, 1.8, 4.5);
    grassCenter.position.set(0, 2.2, 0);
    group.add(grassCenter);

    // Seaward artillery terrace directly supporting the defense cannons
    const cannonTerrace = AssetLoader.get('patch-sand');
    cannonTerrace.scale.set(4.0, 2.0, 6.5);
    cannonTerrace.position.set(team === Team.CRIMSON ? 17 : -17, 1.4, 0);
    group.add(cannonTerrace);

    // Rear bastion terrace supporting watchtowers
    const rearTerrace = AssetLoader.get('patch-sand');
    rearTerrace.scale.set(4.0, 2.0, 5.5);
    rearTerrace.position.set(team === Team.CRIMSON ? -16 : 16, 1.4, 0);
    group.add(rearTerrace);

    // Castle Gate / Main Keep
    const gate = AssetLoader.get('castle-gate');
    gate.scale.setScalar(1.4);
    gate.position.set(0, 2.4, 0);
    gate.rotation.y = cfg.facingRad;
    group.add(gate);

    // Defensive Castle Walls flanking gate
    const wallLeft = AssetLoader.get('castle-wall');
    wallLeft.scale.setScalar(1.3);
    wallLeft.position.set(team === Team.CRIMSON ? 4 : -4, 2.4, -14);
    wallLeft.rotation.y = cfg.facingRad;
    group.add(wallLeft);

    const wallRight = AssetLoader.get('castle-wall');
    wallRight.scale.setScalar(1.3);
    wallRight.position.set(team === Team.CRIMSON ? 4 : -4, 2.4, 14);
    wallRight.rotation.y = cfg.facingRad;
    group.add(wallRight);

    // Watchtower
    const tower = AssetLoader.get('tower-watch');
    tower.scale.setScalar(1.3);
    tower.position.set(team === Team.CRIMSON ? -15 : 15, 2.4, -12);
    group.add(tower);

    // Large Keep Tower
    const towerLarge = AssetLoader.get('tower-complete-large');
    towerLarge.scale.setScalar(1.2);
    towerLarge.position.set(team === Team.CRIMSON ? -16 : 16, 2.4, 12);
    group.add(towerLarge);

    // Dock structure where ships moor/spawn (connecting seamlessly to the shoreline)
    const dock = AssetLoader.get('structure-platform-dock');
    dock.scale.set(2.0, 1.5, 3.5);
    dock.position.set(team === Team.CRIMSON ? 44 : -44, 0.4, 0);
    dock.rotation.y = cfg.facingRad;
    group.add(dock);

    // Team Flag atop fortress
    const flag = AssetLoader.get('flag-pirate-high');
    flag.scale.setScalar(1.5);
    flag.position.set(0, 9.2, 0);
    flag.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material = child.material.clone();
        child.material.color?.setHex(cfg.colorHex);
      }
    });
    group.add(flag);

    // Defense Cannons facing seaward — firmly planted on the cannon terrace land
    const cannonZ = [-18, 0, 18];
    for (const z of cannonZ) {
      const cannon = AssetLoader.get('cannon');
      cannon.scale.setScalar(1.4);
      cannon.position.set(team === Team.CRIMSON ? 18 : -18, 2.4, z);
      cannon.rotation.y = cfg.facingRad;
      group.add(cannon);

      this._defenseCannons.push({
        team,
        mesh: cannon,
        localPos: cannon.position.clone(),
        parentGroup: group,
      });
    }

    // Palms & Scenery firmly planted on terrain
    const palmPositions = [
      [-10, 8], [-22, 0], [-10, -8], [12, -20], [12, 20]
    ];
    for (const [px, pz] of palmPositions) {
      const palm = AssetLoader.get('palm-detailed-straight');
      palm.scale.setScalar(randRange(1.0, 1.4));
      palm.position.set(px, 2.2, pz);
      group.add(palm);
    }

    // Rocky shoreline cover at the water boundary
    const rock = AssetLoader.get('rocks-a');
    rock.scale.setScalar(2.0);
    rock.position.set(team === Team.CRIMSON ? 28 : -28, 0.8, 24);
    group.add(rock);

    const rock2 = AssetLoader.get('rocks-b');
    rock2.scale.setScalar(2.0);
    rock2.position.set(team === Team.CRIMSON ? 28 : -28, 0.8, -24);
    group.add(rock2);

    this._mapGroup.add(group);
  }

  /**
   * Build the central neutral island with flagpole, cover, and water capture zone ring.
   */
  _buildCentralIsland() {
    const group = new THREE.Group();
    group.name = 'island_central';
    group.position.set(0, 0, 0);

    // ── Solid Land Foundation ────────────────────────────────────────────────
    // Natural Caribbean sand and lush green grass (no colormap texture on procedural geometry)
    const sandMat = new THREE.MeshLambertMaterial({ color: 0xd6bf87 });
    const grassMat = new THREE.MeshLambertMaterial({ color: 0x3d7028 });
    const rockRimMat = new THREE.MeshLambertMaterial({ color: 0x544f46 });

    // Shoreline rock foundation ring at water level
    const rockGeo = new THREE.CylinderGeometry(29, 32, 1.4, 32);
    const rockBase = new THREE.Mesh(rockGeo, rockRimMat);
    rockBase.position.set(0, 0.2, 0);
    rockBase.receiveShadow = true;
    group.add(rockBase);

    // Primary sand island base (radius 27 units at waterline)
    const baseGeo = new THREE.CylinderGeometry(27, 29.5, 2.5, 32);
    const baseMesh = new THREE.Mesh(baseGeo, sandMat);
    baseMesh.position.set(0, 0.7, 0);
    baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Elevated grassy hillock in center
    const grassGeo = new THREE.CylinderGeometry(18, 22, 1.3, 28);
    const grassHill = new THREE.Mesh(grassGeo, grassMat);
    grassHill.position.set(0, 1.8, 0);
    grassHill.receiveShadow = true;
    group.add(grassHill);

    // Layered Kenney sand and grass patch modules
    const sand = AssetLoader.get('patch-sand');
    sand.scale.set(5.5, 2.2, 5.5);
    sand.position.set(0, 1.2, 0);
    group.add(sand);

    const grass = AssetLoader.get('patch-grass');
    grass.scale.set(4.0, 1.6, 4.0);
    grass.position.set(0, 2.1, 0);
    group.add(grass);

    // Natural wooden landing dock connecting land to water
    const dock = AssetLoader.get('structure-platform-dock');
    dock.scale.set(1.4, 1.4, 1.8);
    dock.position.set(0, 0.7, 25);
    dock.rotation.y = Math.PI;
    group.add(dock);

    // Central Flagpole firmly planted in the grass
    const flagpole = AssetLoader.get('flag-pirate-high');
    flagpole.scale.setScalar(1.6);
    flagpole.position.set(0, 2.3, 0);
    group.add(flagpole);
    this._centralFlagMesh = flagpole;

    // Palms firmly rooted in island ground
    const palmCoords = [
      [-10, -10], [10, -10], [-10, 10], [10, 10],
      [-16, 0], [16, 0], [0, -16]
    ];
    for (const [x, z] of palmCoords) {
      const palm = AssetLoader.get(Math.random() > 0.5 ? 'palm-straight' : 'palm-bend');
      palm.scale.setScalar(randRange(1.1, 1.5));
      palm.position.set(x, 2.0, z);
      group.add(palm);
    }

    // Rugged rock formations around perimeter shoreline
    const rockCoords = [
      [-23, -15, 'rocks-a'], [23, 15, 'rocks-a'],
      [-19, 19, 'rocks-b'], [19, -19, 'rocks-c'],
      [-24, 0, 'rocks-sand-a'], [24, 0, 'rocks-sand-a']
    ];
    for (const [rx, rz, key] of rockCoords) {
      const r = AssetLoader.get(key);
      r.scale.setScalar(2.2);
      r.position.set(rx, 0.7, rz);
      group.add(r);
    }

    // Glowing Water Ring for the Capture Zone (radius 50 in surrounding waters)
    const ringGeo = new THREE.RingGeometry(this.flagRadius - 2.5, this.flagRadius + 1.5, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xd8c49a, // neutral parchment
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.45, 0); // floats just above water surface
    this.scene.add(ring);
    this._zoneRingMesh = ring;

    // 4 Buoys at cardinal points marking the boundary
    const buoyOffsets = [
      [this.flagRadius, 0], [-this.flagRadius, 0],
      [0, this.flagRadius], [0, -this.flagRadius]
    ];
    for (const [bx, bz] of buoyOffsets) {
      const barrel = AssetLoader.get('barrel');
      barrel.scale.setScalar(1.2);
      barrel.position.set(bx, 0.6, bz);
      group.add(barrel);
    }

    this._mapGroup.add(group);
  }

  /** Clean up battlefield objects when exiting match. */
  cleanBattlefield() {
    if (this._zoneRingMesh) {
      this.scene.remove(this._zoneRingMesh);
      this._zoneRingMesh.geometry?.dispose();
      this._zoneRingMesh.material?.dispose();
      this._zoneRingMesh = null;
    }
    if (this._mapGroup) {
      this.scene.remove(this._mapGroup);
      while (this._mapGroup.children.length > 0) {
        const obj = this._mapGroup.children[0];
        this._mapGroup.remove(obj);
      }
    }
    this._defenseCannons.length = 0;
    this.active = false;

    // Clear countdown timer if active
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }

    // Clear pending respawns
    this._respawnQueue.clear();
    this.game.hud?.hideRespawnCountdown();

    // Clean up participant bot ships from ShipSystem and scene
    if (this.participants && this.participants.length > 0) {
      for (const p of this.participants) {
        if (p.id !== 'local_player' && p.ship) {
          this.game.ships?.unregisterShip(p.ship);
          if (p.ship.group) this.scene.remove(p.ship.group);
          p.ship = null;
        }
      }
      this.participants = [];
    }

    // Restore sandbox islands for Solo Voyage
    if (this.game?._islands) {
      this.game.ships?.setIslands(this.game._islands);
    }
  }

  // ── PARTICIPANTS & ROSTER MANAGEMENT ────────────────────────────────────────

  /**
   * Setup roster for human player + peers + optional bots.
   * @param {string} localPlayerName
   * @param {string} mode — '2v2' | '4v4' | 'TEST'
   * @param {boolean} fillBots
   */
  setupParticipants(localPlayerName, mode = '2v2', fillBots = true) {
    this.mode = mode;
    this.botFillEnabled = fillBots;
    this.participants = [];
    this._respawnQueue.clear();

    const maxPerTeam = mode === '4v4' ? 4 : mode === 'TEST' ? 1 : 2;

    // 1. Add Local Player
    const isMp = !!this.game.mp?.connected;
    const isHost = this.game.mp ? this.game.mp.isHost : true;
    const localTeam = (!isHost && isMp) ? Team.BLACK_TIDE : Team.CRIMSON;

    this.participants.push({
      id: 'local_player',
      name: localPlayerName || 'Captain Jack',
      team: localTeam,
      isBot: false,
      isHost: isHost,
      ready: true,
      shipClass: 'PIRATE_SMALL',
      ship: null,
    });

    // 2. Add connected Multiplayer Peers if in MP
    if (this.game.mp?.connected) {
      if (this.game.mp.isHost && this.game.mp._connections?.size > 0) {
        let peerCount = 0;
        for (const [peerId, conn] of this.game.mp._connections) {
          const peerName = conn.peerName || `Captain ${peerId.slice(-4).toUpperCase()}`;
          const team = peerCount % 2 === 0 ? Team.BLACK_TIDE : Team.CRIMSON;
          this.participants.push({
            id: peerId,
            name: peerName,
            team: team,
            isBot: false,
            isHost: false,
            ready: true,
            shipClass: 'PIRATE_SMALL',
            ship: null,
          });
          peerCount++;
        }
      } else {
        const partnerName = this.game.mp.partnerName || 'Admiral (Host)';
        this.participants.push({
          id: 'peer_partner',
          name: partnerName,
          team: Team.CRIMSON,
          isBot: false,
          isHost: false,
          ready: true,
          shipClass: 'PIRATE_SMALL',
          ship: null,
        });
      }
    }

    // 3. Fill remaining slots with AI Bots if enabled
    if (fillBots) {
      const botNames = [
        'Blackbeard', 'Anne Bonny', 'Calico Jack', 'Bartholomew',
        'Mary Read', 'Henry Morgan', 'Edward Low', 'Grace O\'Malley'
      ];
      let botIdx = 0;

      // Fill Team Crimson
      while (this.participants.filter(p => p.team === Team.CRIMSON).length < maxPerTeam) {
        this.participants.push({
          id: `bot_crimson_${botIdx + 1}`,
          name: `[BOT] ${botNames[botIdx % botNames.length]}`,
          team: Team.CRIMSON,
          isBot: true,
          isHost: false,
          ready: true,
          shipClass: 'PIRATE_SMALL',
          ship: null,
        });
        botIdx++;
      }

      // Fill Team Black Tide
      while (this.participants.filter(p => p.team === Team.BLACK_TIDE).length < maxPerTeam) {
        this.participants.push({
          id: `bot_blacktide_${botIdx + 1}`,
          name: `[BOT] ${botNames[botIdx % botNames.length]}`,
          team: Team.BLACK_TIDE,
          isBot: true,
          isHost: false,
          ready: true,
          shipClass: 'PIRATE_SMALL',
          ship: null,
        });
        botIdx++;
      }
    }
  }

  /**
   * Seamlessly convert disconnected player's ship into an AI warship.
   * @param {string} peerId
   */
  handlePeerDisconnect(peerId) {
    const p = this.participants.find(part => part.id === peerId);
    if (p) {
      p.isBot = true;
      if (p.ship) p.ship._isPartnerGhost = false;
      p.name = `[AI] ${p.name.replace('[AI] ', '')}`;
      this.game.hud?.showTeamBattleAnnouncement(`⚠️ Captain ${p.name} disconnected! AI Corsair has taken command.`, 'danger');
      this.game.hud?.toast(`⚠️ ${p.name} disconnected — converted to AI warship`, 'warning');
    }
  }

  /**
   * Seamlessly assign mid-match connecting player to an active bot slot.
   * @param {string} peerId
   * @param {string} [peerName]
   */
  handlePeerConnect(peerId, peerName) {
    if (!this.active) return;
    let existing = this.participants.find(p => p.id === peerId);
    if (existing) {
      existing.isBot = false;
      return;
    }

    const bot = this.participants.find(p => p.isBot && p.team === Team.BLACK_TIDE)
      || this.participants.find(p => p.isBot);

    if (bot) {
      bot.id = peerId;
      bot.name = peerName || `Captain ${peerId.slice(-4).toUpperCase()}`;
      bot.isBot = false;
      if (bot.ship) {
        bot.ship._isPartnerGhost = true;
      }
      this.game.hud?.showTeamBattleAnnouncement(`⚔️ Captain ${bot.name} has joined the battle!`, 'success');
      this.game.hud?.toast(`⚔️ ${bot.name} joined the fleet!`, 'success');
    }
  }

  // ── SPAWNING & LIFECYCLE ─────────────────────────────────────────────────────

  /**
   * Spawn all participant ships at designated home island dock stations.
   */
  spawnParticipantShips() {
    let crimsonIdx = 0;
    let blackTideIdx = 0;

    for (const p of this.participants) {
      const cfg = TeamConfig[p.team];
      const isCrimson = p.team === Team.CRIMSON;
      const idx = isCrimson ? crimsonIdx++ : blackTideIdx++;
      const zOffset = cfg.spawnOffsets[idx % cfg.spawnOffsets.length];

      const spawnX = cfg.dockPos.x;
      const spawnZ = cfg.dockPos.z + zOffset;

      if (p.id === 'local_player') {
        // Reuse local player ship
        const ship = this.game.playerShip;
        ship.setPosition(spawnX, 1.0, spawnZ);
        ship.setRotationY(cfg.facingRad);
        ship.health = ship.maxHealth;
        ship.velocity.set(0, 0, 0);
        ship.team = p.team;
        ship.state = 'SAILING';
        ship._sinkTimer = 0;
        this.game.ships?.registerShip(ship);
        if (ship.group) {
          if (!ship.group.parent) this.game.scene.add(ship.group);
          ship.group.visible = true;
        }
        p.ship = ship;
        this._applyTeamVisuals(ship, p.team);
      } else if (p.id === 'peer_partner' && this.game._partnerShip) {
        // Reuse partner ghost ship
        const ship = this.game._partnerShip;
        ship.setPosition(spawnX, 1.0, spawnZ);
        ship.setRotationY(cfg.facingRad);
        ship.health = ship.maxHealth;
        ship.team = p.team;
        ship._isPartnerGhost = true;
        p.ship = ship;
        this._applyTeamVisuals(ship, p.team);
      } else {
        // Spawn AI bot or remote player ship
        const ship = this.game.ships.createShip(p.shipClass, 'PLAYER', spawnX, spawnZ);
        ship.setRotationY(cfg.facingRad);
        ship.team = p.team;
        if (!p.isBot) {
          ship._isPartnerGhost = true;
          ship._networkPeerId = p.id;
        }
        p.ship = ship;
        this._applyTeamVisuals(ship, p.team);
      }
    }
  }

  /**
   * Tint sails/flags with team color.
   */
  _applyTeamVisuals(ship, team) {
    if (!ship?.group) return;
    const cfg = TeamConfig[team];
    ship.group.traverse((node) => {
      if (node.isMesh && node.material) {
        node.material = node.material.clone();
        if (node.name.includes('flag') || node.name.includes('sail')) {
          node.material.color?.setHex(cfg.colorHex);
        }
      }
    });
  }

  // ── MATCH FLOW & AUTHORITATIVE STATE MACHINE ────────────────────────────────

  /**
   * Start 5-second battle countdown.
   */
  startCountdown() {
    this.matchState = MatchState.COUNTDOWN;
    this.timeRemaining = this.matchDuration;
    this.scoreA = 0;
    this.scoreB = 0;
    this.islandHpA = this.maxIslandHp;
    this.islandHpB = this.maxIslandHp;
    this.flagOwner = null;
    this.flagProgress = 0;
    this.isContested = false;

    EventEmitter.emit('teambattle:countdown', { seconds: 5 });
    this.game.hud?.showTeamBattleAnnouncement('⚔️ PIRATE TEAM BATTLE — PREPARE BROADSIDES!', 'gold');

    let count = 5;
    if (this._countdownInterval) clearInterval(this._countdownInterval);
    this._countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        EventEmitter.emit('teambattle:countdown', { seconds: count });
      } else {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        this.startMatch();
      }
    }, 1000);
  }

  /**
   * Start active combat match.
   */
  startMatch() {
    this.matchState = MatchState.IN_PROGRESS;
    EventEmitter.emit('teambattle:started');
    this.game.hud?.showTeamBattleAnnouncement('🚩 BATTLE HAS BEGUN! CONQUER THE CENTRAL FLAG!', 'gold');
    this.game.hud?.toast('⚓ Set Sail! Destroy enemy island defenses or claim the flag!', 'success');
  }

  /**
   * Check victory conditions authoritatively.
   */
  _checkVictoryConditions() {
    if (this.matchState !== MatchState.IN_PROGRESS) return;

    // 1. Island Destruction Victory
    if (this.islandHpB <= 0) {
      this._triggerVictory(Team.CRIMSON, 'Enemy Fortress Destroyed!');
      return;
    }
    if (this.islandHpA <= 0) {
      this._triggerVictory(Team.BLACK_TIDE, 'Enemy Fortress Destroyed!');
      return;
    }

    // 2. Score Target Victory
    if (this.scoreA >= this.targetScore) {
      this._triggerVictory(Team.CRIMSON, 'Target Score Reached!');
      return;
    }
    if (this.scoreB >= this.targetScore) {
      this._triggerVictory(Team.BLACK_TIDE, 'Target Score Reached!');
      return;
    }

    // 3. Match Timer Expiry (Tie-breaker sequence)
    if (this.timeRemaining <= 0) {
      if (this.scoreA > this.scoreB) {
        this._triggerVictory(Team.CRIMSON, 'Higher Score on Time Expiry!');
      } else if (this.scoreB > this.scoreA) {
        this._triggerVictory(Team.BLACK_TIDE, 'Higher Score on Time Expiry!');
      } else {
        // Compare remaining fortress HP
        if (this.islandHpA > this.islandHpB) {
          this._triggerVictory(Team.CRIMSON, 'Fortress Integrity Advantage!');
        } else if (this.islandHpB > this.islandHpA) {
          this._triggerVictory(Team.BLACK_TIDE, 'Fortress Integrity Advantage!');
        } else {
          this._triggerDraw();
        }
      }
    }
  }

  _triggerVictory(winningTeam, reason) {
    const isTeamA = winningTeam === Team.CRIMSON;
    this.matchState = isTeamA ? MatchState.TEAM_A_VICTORY : MatchState.TEAM_B_VICTORY;
    const teamName = TeamConfig[winningTeam].name;

    // Destruction fireworks & camera shake
    const losingPos = isTeamA ? TeamConfig[Team.BLACK_TIDE].islandPos : TeamConfig[Team.CRIMSON].islandPos;
    this.game.combat?.spawnDeathExplosion(losingPos.clone().setY(6));
    EventEmitter.emit('camera:shake', { intensity: 1.0, duration: 0.6 });

    EventEmitter.emit('teambattle:victory', { winningTeam, reason });
    this.game.hud?.hideRespawnCountdown();
    this.game.hud?.showTeamBattleAnnouncement(`🏆 ${teamName.toUpperCase()} VICTORY!`, 'gold');
    if (this.game.mp?.isHost) {
      this.game.mp.sendTeamBattleState?.(this.getState());
      this.game.matchmaking?.setRoomStatus(this.game.matchmaking?.currentRoomCode, 'closed');
    }

    setTimeout(() => {
      this.matchState = MatchState.POST_MATCH;
      this.game.hud?.showTeamBattleVictory({
        winningTeam,
        reason,
        scoreA: this.scoreA,
        scoreB: this.scoreB,
        islandHpA: this.islandHpA,
        islandHpB: this.islandHpB,
      });
      if (this.game.mp?.isHost) {
        this.game.mp.sendTeamBattleState?.(this.getState());
      }
    }, 2500);
  }

  _triggerDraw() {
    this.matchState = MatchState.DRAW;
    EventEmitter.emit('teambattle:draw');
    this.game.hud?.hideRespawnCountdown();
    this.game.hud?.showTeamBattleAnnouncement('⚖️ HONOURABLE DRAW — HIGH SEAS STALEMATE!', 'info');
    if (this.game.mp?.isHost) {
      this.game.mp.sendTeamBattleState?.(this.getState());
      this.game.matchmaking?.setRoomStatus(this.game.matchmaking?.currentRoomCode, 'closed');
    }

    setTimeout(() => {
      this.matchState = MatchState.POST_MATCH;
      this.game.hud?.showTeamBattleVictory({
        winningTeam: null,
        reason: 'Equal Score & Fortress HP',
        scoreA: this.scoreA,
        scoreB: this.scoreB,
        islandHpA: this.islandHpA,
        islandHpB: this.islandHpB,
      });
      if (this.game.mp?.isHost) {
        this.game.mp.sendTeamBattleState?.(this.getState());
      }
    }, 2500);
  }

  // ── OBJECTIVE 1: CENTRAL FLAG CAPTURE SIMULATION ─────────────────────────────

  /**
   * Update flag capture progress based on ships within radius 50 of origin.
   * @param {number} delta
   */
  _updateFlagCapture(delta) {
    const center = new THREE.Vector2(0, 0);
    let shipsA = 0;
    let shipsB = 0;

    for (const p of this.participants) {
      const ship = p.ship;
      if (!ship || !ship.isAlive || ship.health <= 0 || ship.state === 'SINKING' || !ship.group) continue;
      const pos2D = new THREE.Vector2(ship.group.position.x, ship.group.position.z);
      if (pos2D.distanceTo(center) <= this.flagRadius) {
        if (p.team === Team.CRIMSON) shipsA++;
        else if (p.team === Team.BLACK_TIDE) shipsB++;
      }
    }


    // Contested Rule: both teams present in zone
    if (shipsA > 0 && shipsB > 0) {
      if (!this.isContested) {
        this.isContested = true;
        this.game.hud?.showTeamBattleAnnouncement('⚔️ THE CENTRAL FLAG IS CONTESTED!', 'danger');
        if (this._zoneRingMesh) this._zoneRingMesh.material.color.setHex(0xffaa00);
      }
      return; // Progress paused while contested
    }

    if (this.isContested) {
      this.isContested = false;
    }

    // Uncontested presence
    const rate = 8.5 * delta; // ~12 seconds for full capture from neutral

    if (shipsA > 0 && shipsB === 0) {
      const prevProgress = this.flagProgress;
      this.flagProgress = Math.min(100, this.flagProgress + rate * Math.min(3, shipsA));

      if (prevProgress < 0 && this.flagProgress >= 0) {
        // Decayed enemy capture back to neutral
        this.flagOwner = null;
        this.game.hud?.showTeamBattleAnnouncement('THE CENTRAL FLAG IS NOW NEUTRAL!', 'info');
      }

      if (this.flagProgress >= 100 && this.flagOwner !== Team.CRIMSON) {
        this.flagOwner = Team.CRIMSON;
        this.scoreA += 50; // Initial capture bonus
        this.game.hud?.showTeamBattleAnnouncement('🔴 THE CRIMSON CORSAIRS HAVE CLAIMED THE CENTRAL FLAG! (+50)', 'gold');
        if (this._zoneRingMesh) this._zoneRingMesh.material.color.setHex(TeamConfig[Team.CRIMSON].colorHex);
      }
    } else if (shipsB > 0 && shipsA === 0) {
      const prevProgress = this.flagProgress;
      this.flagProgress = Math.max(-100, this.flagProgress - rate * Math.min(3, shipsB));

      if (prevProgress > 0 && this.flagProgress <= 0) {
        this.flagOwner = null;
        this.game.hud?.showTeamBattleAnnouncement('THE CENTRAL FLAG IS NOW NEUTRAL!', 'info');
      }

      if (this.flagProgress <= -100 && this.flagOwner !== Team.BLACK_TIDE) {
        this.flagOwner = Team.BLACK_TIDE;
        this.scoreB += 50; // Initial capture bonus
        this.game.hud?.showTeamBattleAnnouncement('🔵 THE BLACK TIDE RAIDERS HAVE CLAIMED THE CENTRAL FLAG! (+50)', 'gold');
        if (this._zoneRingMesh) this._zoneRingMesh.material.color.setHex(TeamConfig[Team.BLACK_TIDE].colorHex);
      }
    }

    // Periodic objective score tick (every 3 seconds for controlling team)
    this.scoreTickTimer += delta;
    if (this.scoreTickTimer >= 3.0) {
      this.scoreTickTimer = 0;
      if (this.flagOwner === Team.CRIMSON) {
        this.scoreA += 5;
      } else if (this.flagOwner === Team.BLACK_TIDE) {
        this.scoreB += 5;
      }
    }
  }

  // ── OBJECTIVE 2: HOME ISLAND SIEGE & HIT PROCESSING ─────────────────────────

  /**
   * Check if a cannonball collides with an enemy island fortress.
   * @param {THREE.Vector3} ballPos
   * @param {import('./ShipSystem.js').Ship} owner
   * @returns {{ team: string }|null}
   */
  checkIslandHit(ballPos, owner) {
    if (!this.active || !owner?.team) return null;

    const ball2D = new THREE.Vector2(ballPos.x, ballPos.z);
    const targetTeam = owner.team === Team.CRIMSON ? Team.BLACK_TIDE : Team.CRIMSON;
    const fortressPos = TeamConfig[targetTeam].islandPos;
    const fort2D = new THREE.Vector2(fortressPos.x, fortressPos.z);

    // Fortress collision target radius: 46 units
    if (ball2D.distanceTo(fort2D) <= 46 && ballPos.y < 12) {
      return { team: targetTeam };
    }
    return null;
  }

  /**
   * Authoritatively apply siege cannon damage to a home island.
   * @param {string} targetTeam
   * @param {number} damage
   * @param {object} shooter
   */
  applyIslandDamage(targetTeam, damage, shooter) {
    if (this.matchState !== MatchState.IN_PROGRESS) return;

    const actualDmg = Math.round(damage);
    if (targetTeam === Team.CRIMSON) {
      this.islandHpA = Math.max(0, this.islandHpA - actualDmg);
      if (this.islandHpA <= 300 && this.islandHpA + actualDmg > 300) {
        this.game.hud?.showTeamBattleAnnouncement('⚠️ CRIMSON FORTRESS: CRITICAL DAMAGE!', 'danger');
      }
    } else {
      this.islandHpB = Math.max(0, this.islandHpB - actualDmg);
      if (this.islandHpB <= 300 && this.islandHpB + actualDmg > 300) {
        this.game.hud?.showTeamBattleAnnouncement('⚠️ BLACK TIDE FORTRESS: CRITICAL DAMAGE!', 'danger');
      }
    }

    EventEmitter.emit('teambattle:island_hit', { targetTeam, damage: actualDmg, shooter });
    this.game.hud?.spawnDamageNumber(
      actualDmg,
      TeamConfig[targetTeam].islandPos.clone().setY(6),
      'enemy'
    );
  }

  /**
   * Called when a cannonball hits a fortress.
   * If multiplayer client, routes hit to host via sendTeamBattleIslandHit.
   * If host or single-player, applies damage authoritatively.
   * @param {string} targetTeam
   * @param {number} damage
   * @param {object} shooter
   */
  onHitIsland(targetTeam, damage, shooter) {
    if (this.game.mp && !this.game.mp.isHost) {
      this.game.mp.sendTeamBattleIslandHit?.({
        targetTeam,
        damage: Math.round(damage),
      });
    } else {
      this.applyIslandDamage(targetTeam, damage, shooter);
    }
  }

  // ── DEFENSE CANNONS SIMULATION ───────────────────────────────────────────────

  /**
   * Home fortress defensive cannons automatically fire at approaching enemy warships.
   * @param {number} delta
   */
  _updateDefenseCannons(delta) {
    this._islandCannonCooldownA -= delta;
    this._islandCannonCooldownB -= delta;

    if (this._islandCannonCooldownA <= 0) {
      this._islandCannonCooldownA = 4.5 + Math.random();
      this._fireDefenseVolley(Team.CRIMSON);
    }
    if (this._islandCannonCooldownB <= 0) {
      this._islandCannonCooldownB = 4.5 + Math.random();
      this._fireDefenseVolley(Team.BLACK_TIDE);
    }
  }

  _fireDefenseVolley(defendingTeam) {
    const enemyTeam = defendingTeam === Team.CRIMSON ? Team.BLACK_TIDE : Team.CRIMSON;
    const fortPos = TeamConfig[defendingTeam].islandPos;

    // Find nearest enemy ship in home waters (< 120 units)
    let closestEnemy = null;
    let closestDist = 120;

    for (const p of this.participants) {
      if (p.team !== enemyTeam || !p.ship?.isAlive || !p.ship.group) continue;
      const d = dist2D(p.ship.group.position, fortPos);
      if (d < closestDist) {
        closestDist = d;
        closestEnemy = p.ship;
      }
    }

    if (closestEnemy && this.game.combat) {
      // Aim and fire defense cannon
      const fromPos = fortPos.clone().add(new THREE.Vector3(defendingTeam === Team.CRIMSON ? 25 : -25, 4, 0));
      this.game.combat.fireAimedCannonball(fromPos, closestEnemy.group.position, 28);
    }
  }

  // ── BOT AI & COMBAT LOGIC ───────────────────────────────────────────────────

  /**
   * Simple, robust AI for participating bots in Team Battle.
   * Bots sail to contest the central flag, attack nearby enemies, and bombard enemy fortress!
   * @param {number} delta
   */
  _updateBots(delta) {
    if (!this.botFillEnabled || this.matchState !== MatchState.IN_PROGRESS) return;

    this._botActionTimer += delta;
    if (this._botActionTimer < 0.25) return;
    this._botActionTimer = 0;

    for (const p of this.participants) {
      if (!p.isBot || !p.ship?.isAlive || !p.ship.group) continue;
      const ship = p.ship;
      const myTeam = p.team;
      const enemyTeam = myTeam === Team.CRIMSON ? Team.BLACK_TIDE : Team.CRIMSON;
      const enemyFortPos = TeamConfig[enemyTeam].islandPos;

      // Find closest enemy ship
      let closestTarget = null;
      let closestDist = Infinity;

      for (const other of this.participants) {
        if (other.team === enemyTeam && other.ship?.isAlive && other.ship.group) {
          const d = dist2D(ship.group.position, other.ship.group.position);
          if (d < closestDist) {
            closestDist = d;
            closestTarget = other.ship;
          }
        }
      }

      // Objective Priority with Tactical Fleet Commands:
      let targetPos;
      const cmd = this._fleetCommand;
      if (cmd === 'FLAG') {
        targetPos = new THREE.Vector3(0, 0, 0);
      } else if (cmd === 'FORTRESS') {
        targetPos = enemyFortPos;
      } else if (cmd === 'DEFEND') {
        targetPos = TeamConfig[myTeam].islandPos;
      } else if (closestTarget && closestDist < 65) {
        targetPos = closestTarget.group.position;
      } else if (this.flagOwner !== myTeam) {
        targetPos = new THREE.Vector3(0, 0, 0);
      } else {
        targetPos = enemyFortPos;
      }

      // Steer ship toward target
      const dx = targetPos.x - ship.group.position.x;
      const dz = targetPos.z - ship.group.position.z;
      const targetAngle = Math.atan2(dx, dz) + Math.PI; // Three.js forward angle convention
      const diff = ((targetAngle - ship.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;

      ship.steering = Math.sign(diff) * Math.min(1.0, Math.abs(diff) * 1.5);
      ship.thrust = Math.abs(diff) > 1.2 ? 0.4 : 0.85;

      // Cannon combat
      if (closestTarget && closestDist < 55) {
        // Check broadside alignment (angle ~90 deg from forward)
        const sideAngle = Math.abs(Math.abs(diff) - Math.PI / 2);
        if (sideAngle < 0.45 && ship.cannonCooldown <= 0) {
          this.game.combat?.fireCannons(ship);
        }
      }
    }
  }

  /**
   * Order ally fleet ships to focus on an objective.
   * @param {'FLAG' | 'FORTRESS' | 'DEFEND'} cmd
   */
  commandFleet(cmd) {
    this._fleetCommand = cmd;
    const msg = cmd === 'FLAG' ? 'Capture Central Flag' : cmd === 'FORTRESS' ? 'Bombard Enemy Fortress' : 'Defend Home Dock';
    this.game.hud?.toast(`🚩 Fleet Command: ${msg}!`, 'info');
  }

  // ── RESPAWNING ───────────────────────────────────────────────────────────────

  /**
   * Track destroyed participant ships and respawn them after 8s delay.
   * @param {number} delta
   */
  _updateRespawns(delta) {
    for (const p of this.participants) {
      const ship = p.ship;
      if (!ship) continue;

      if ((!ship.isAlive || ship.health <= 0 || ship.state === 'SUNK' || ship.state === 'SINKING') && !this._respawnQueue.has(p.id)) {
        this._respawnQueue.set(p.id, { timer: 8.0, participant: p });
        if (p.id === 'local_player') {
          this.game.hud?.showTeamBattleAnnouncement('⚓ SHIP SUNK! RESPAWNING IN 8 SECONDS...', 'danger');
          this.game.hud?.showRespawnCountdown(8.0);
        }
      }
    }

    for (const [id, entry] of this._respawnQueue) {
      entry.timer -= delta;
      if (id === 'local_player') {
        this.game.hud?.updateRespawnCountdown(entry.timer);
      }
      if (entry.timer <= 0) {
        this._respawnQueue.delete(id);
        if (id === 'local_player') {
          this.game.hud?.hideRespawnCountdown();
        }
        this._respawnParticipant(entry.participant);
      }
    }
  }

  _respawnParticipant(p) {
    if (this.matchState !== MatchState.IN_PROGRESS && this.matchState !== MatchState.COUNTDOWN) return;
    const cfg = TeamConfig[p.team];
    const spawnX = cfg.dockPos.x;
    const spawnZ = cfg.dockPos.z + randRange(-15, 15);

    const ship = p.ship;
    if (ship) {
      // 1. Ensure ship is re-registered into ShipSystem so its update() loop ticks every frame
      this.game.ships?.registerShip(ship);

      // 2. Ensure ship group is attached to scene, visible, and oriented properly
      if (ship.group) {
        if (!ship.group.parent) {
          this.game.scene.add(ship.group);
        }
        ship.group.visible = true;
        ship.group.rotation.set(0, cfg.facingRad, 0);
        ship.group.position.set(spawnX, 1.0, spawnZ);
      }

      // 3. Reset physics, health, timers, and state to SAILING
      ship._sinkTimer = 0;
      ship._sinkShakeTimer = 0;
      ship._chainSlowTimer = 0;
      ship._burnTimer = 0;
      ship._burnDPS = 0;
      ship._veynarSlowTimer = 0;
      ship.health = ship.maxHealth;
      ship.state = 'SAILING';
      ship.thrust = 0;
      ship.steering = 0;
      ship.velocity.set(0, 0, 0);
      ship.angularVelocity = 0;
      ship.isDrifting = false;
      ship.cannonCooldown = 1.0;

      // 4. Team visuals
      this._applyTeamVisuals(ship, p.team);

      // 5. If this is the local player, restore playerShip pointer, camera, input, and HUD
      if (p.id === 'local_player') {
        this.game.playerShip = ship;
        this.game.input?.clear();
        if (this.game.cameraSystem) {
          this.game.cameraSystem.setTarget(ship.group);
          this.game.cameraSystem.clearFocus();
          this.game.cameraSystem._cinematicMode = false;
        }
        if (this.game.hud) {
          this.game.hud.updateShipInfo(ship, 1, 0);
        }
      }
    }

    if (p.id === 'local_player') {
      this.game.hud?.toast('⚓ Ship repaired and returned to battle!', 'success');
    }
  }

  // ── PER-FRAME UPDATE ─────────────────────────────────────────────────────────

  update(delta) {
    if (!this.active) return;

    const isAuthority = !this.game.mp || this.game.mp.isHost;

    if (this.matchState === MatchState.IN_PROGRESS) {
      // 1. Tick match clock
      this.timeRemaining = Math.max(0, this.timeRemaining - delta);

      if (isAuthority) {
        // Host simulation: flag, defense cannons, bot AI, respawns, victory check
        this._updateFlagCapture(delta);
        this._updateDefenseCannons(delta);
        this._updateBots(delta);
        this._updateRespawns(delta);
        this._checkVictoryConditions();
      } else {
        // Client: handle local player respawn loop locally
        this._updateLocalRespawn(delta);
      }
      if (this._dockRepairActive) {
        const localP = this.participants.find(p => p.id === 'local_player');
        if (localP?.ship?.isAlive && localP.ship.health < localP.ship.maxHealth) {
          const dockPos = TeamConfig[localP.team].dockPos;
          const d = dist2D(localP.ship.group.position, dockPos);
          if (d < 45) {
            localP.ship.health = Math.min(localP.ship.maxHealth, localP.ship.health + delta * 12);
          }
        }
      }
    }

    // Update In-Game Team Battle HUD
    this.game.hud?.updateTeamBattleHUD(this.getState());
  }

  /**
   * Client-side local player respawn tracking.
   * Resets local ship position and controls when sunk without duplicating bot logic.
   * @param {number} delta
   */
  _updateLocalRespawn(delta) {
    const localP = this.participants.find(p => p.id === 'local_player');
    if (!localP || !localP.ship) return;
    const ship = localP.ship;

    if ((!ship.isAlive || ship.health <= 0 || ship.state === 'SUNK' || ship.state === 'SINKING') && !this._respawnQueue.has('local_player')) {
      this._respawnQueue.set('local_player', { timer: 8.0, participant: localP });
      this.game.hud?.showTeamBattleAnnouncement('⚓ SHIP SUNK! RESPAWNING IN 8 SECONDS...', 'danger');
      this.game.hud?.showRespawnCountdown(8.0);
    }

    const entry = this._respawnQueue.get('local_player');
    if (entry) {
      entry.timer -= delta;
      this.game.hud?.updateRespawnCountdown(entry.timer);
      if (entry.timer <= 0) {
        // In multiplayer client mode, do not unilaterally respawn local ship — wait for host authoritative state
        if (!this.game.mp?.connected || !this.game.mp?.isClient) {
          this._respawnQueue.delete('local_player');
          this.game.hud?.hideRespawnCountdown();
          this._respawnParticipant(entry.participant);
        }
      }
    }
  }

  /**
   * Return snapshot of current match state.
   */
  getState() {
    return {
      islandHpA: this.islandHpA,
      islandHpB: this.islandHpB,
      maxIslandHp: this.maxIslandHp,
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      targetScore: this.targetScore,
      timeRemaining: this.timeRemaining,
      flagOwner: this.flagOwner,
      flagProgress: this.flagProgress,
      isContested: this.isContested,
      matchState: this.matchState,
      dayPhase: this.game.sky?._dayPhase ?? 0,
      participants: this.participants.map(p => ({
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        isHost: p.isHost,
        shipClass: p.shipClass,
        x: p.ship?.group?.position?.x ?? 0,
        y: p.ship?.group?.position?.y ?? 1.0,
        z: p.ship?.group?.position?.z ?? 0,
        ry: p.ship?.group?.rotation?.y ?? 0,
        vx: p.ship?.velocity?.x ?? 0,
        vy: p.ship?.velocity?.y ?? 0,
        vz: p.ship?.velocity?.z ?? 0,
        hp: p.ship?.health ?? 0,
        mhp: p.ship?.maxHealth ?? 120,
        state: p.ship?.state ?? 'SAILING',
        thrust: p.ship?.thrust ?? 0,
        steering: p.ship?.steering ?? 0,
      })),
      respawns: Array.from(this._respawnQueue.entries()).map(([id, entry]) => ({
        id,
        timer: entry.timer,
      })),
    };
  }

  /**
   * Authoritatively apply network match state snapshot from host.
   * @param {object} state
   */
  applyState(state) {
    if (!state) return;
    if (state.islandHpA !== undefined) this.islandHpA = state.islandHpA;
    if (state.islandHpB !== undefined) this.islandHpB = state.islandHpB;
    if (state.scoreA !== undefined) this.scoreA = state.scoreA;
    if (state.scoreB !== undefined) this.scoreB = state.scoreB;
    if (state.timeRemaining !== undefined) this.timeRemaining = state.timeRemaining;
    if (state.flagOwner !== undefined) this.flagOwner = state.flagOwner;
    if (state.flagProgress !== undefined) this.flagProgress = state.flagProgress;
    if (state.isContested !== undefined) this.isContested = state.isContested;

    // Synchronize authoritative Day/Night cycle
    if (state.dayPhase !== undefined && this.game.sky?.setDayPhase) {
      this.game.sky.setDayPhase(state.dayPhase);
    }

    // Reconcile and interpolate all participants (bots and players)
    if (Array.isArray(state.participants)) {
      for (const pData of state.participants) {
        let localP = this.participants.find(p => p.id === pData.id);
        if (!localP && !this.game.mp?.isHost) {
          if (pData.isHost) {
            localP = this.participants.find(p => p.id === 'peer_partner' || p.isHost);
          }
        }
        if (!localP || !localP.ship) continue;

        const ship = localP.ship;

        if (localP.id === 'local_player') {
          // Client owns local ship physics, but reconciles authoritative health and sinking
          if (pData.hp <= 0 && ship.state !== 'SUNK' && ship.state !== 'SINKING') {
            ship.takeDamage(ship.health);
          } else if (pData.hp > 0 && (ship.state === 'SUNK' || ship.state === 'SINKING')) {
            // Authoritative respawn confirmed by host
            ship.respawn(pData.x, 1.0, pData.z, pData.ry, pData.hp);
            this.game.ships?.registerShip(ship);
            this._respawnQueue.delete('local_player');
            this.game.hud?.hideRespawnCountdown();
          }
        } else {
          // Remote participant or AI bot
          if (ship.group && !ship.group.parent) {
            this.game.scene.add(ship.group);
          }
          if (ship.group) ship.group.visible = true;

          // Only trigger sinking if ship was sailing and host reports 0 HP
          if (pData.hp <= 0 && ship.state === 'SAILING') {
            ship.health = 0;
            ship._beginSinking?.();
          }

          // If this is an AI bot (host simulates bots), update bot transform smoothly
          if (p.isBot && ship.state === 'SAILING') {
            const curPos = ship.group.position;
            const distSq = (curPos.x - pData.x) ** 2 + (curPos.z - pData.z) ** 2;
            if (distSq > 400) {
              ship.setPosition(pData.x, pData.y, pData.z);
              ship.setRotationY(pData.ry);
            } else {
              curPos.x += (pData.x - curPos.x) * 0.45;
              curPos.y = pData.y;
              curPos.z += (pData.z - curPos.z) * 0.45;
              const diff = ((pData.ry - ship.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
              ship.group.rotation.y += diff * 0.45;
            }
            ship.velocity?.set(pData.vx, pData.vy, pData.vz);
          }
          // Note: Human player peer ships have transforms smoothly driven by EntityInterpolationBuffer

          ship.health = pData.hp;
          ship.maxHealth = pData.mhp;
          ship.thrust = pData.thrust;
          ship.steering = pData.steering;
        }
      }
    }

    // Synchronize authoritative respawn countdown
    if (Array.isArray(state.respawns)) {
      const myRespawn = state.respawns.find(r => r.id === (this.game.mp?.myPeerId || 'local_player'));
      if (myRespawn && myRespawn.timer > 0) {
        this.game.hud?.showRespawnCountdown(myRespawn.timer);
      } else if (!myRespawn && this._respawnQueue.has('local_player')) {
        this.game.hud?.hideRespawnCountdown();
      }
    }

    if (state.matchState !== undefined && this.matchState !== state.matchState) {
      this.matchState = state.matchState;
      if (this.matchState === MatchState.IN_PROGRESS) {
        this.game.hud?.showTeamBattleAnnouncement('🚩 BATTLE IN PROGRESS!', 'gold');
      } else if (this.matchState === MatchState.TEAM_A_VICTORY) {
        this._triggerVictory(Team.CRIMSON, 'Enemy Fortress Destroyed!');
      } else if (this.matchState === MatchState.TEAM_B_VICTORY) {
        this._triggerVictory(Team.BLACK_TIDE, 'Enemy Fortress Destroyed!');
      } else if (this.matchState === MatchState.DRAW) {
        this._triggerDraw();
      } else if (this.matchState === MatchState.POST_MATCH) {
        this.game.hud?.showTeamBattleVictory({
          winningTeam: (this.islandHpB <= 0 || this.scoreA > this.scoreB) ? Team.CRIMSON : Team.BLACK_TIDE,
          reason: 'Match Concluded',
          scoreA: this.scoreA,
          scoreB: this.scoreB,
          islandHpA: this.islandHpA,
          islandHpB: this.islandHpB,
        });
      }
    }
  }
}

export default TeamBattleSystem;
