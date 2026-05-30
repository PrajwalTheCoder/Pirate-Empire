/**
 * main.js — Game bootstrap and main loop.
 *
 * Pirate Empire: Rise of the Black Fleet
 *
 * Initialisation order:
 * 1. Three.js renderer + scene + camera
 * 2. Asset loading (shows loading screen with progress)
 * 3. World systems (ocean, sky, islands)
 * 4. Game systems (ships, combat, economy, AI)
 * 5. UI systems (HUD, panels, minimap)
 * 6. RAF game loop
 */

import * as THREE from 'three';

// ── Systems ─────────────────────────────────────────────────────────────────
import AssetLoader    from './systems/AssetLoader.js';
import InputSystem    from './systems/InputSystem.js';
import ShipSystem     from './systems/ShipSystem.js';
import CombatSystem   from './systems/CombatSystem.js';
import EconomySystem  from './systems/EconomySystem.js';
import IslandSystem   from './systems/IslandSystem.js';
import BuildSystem    from './systems/BuildSystem.js';
import MissionSystem  from './systems/MissionSystem.js';
import AISystem       from './systems/AISystem.js';
import CameraSystem   from './systems/CameraSystem.js';
import WakeSystem     from './systems/WakeSystem.js';
import BirdSystem     from './systems/BirdSystem.js';
import LootSystem     from './systems/LootSystem.js';
import PerkSystem     from './systems/PerkSystem.js';
import MultiplayerSystem, { QUICK_CHAT } from './systems/MultiplayerSystem.js';
import WorldEventSystem  from './systems/WorldEventSystem.js';
import StorySystem       from './systems/StorySystem.js';

// ── World ────────────────────────────────────────────────────────────────────
import Ocean           from './world/Ocean.js';
import SkySystem       from './world/SkySystem.js';
import IslandGenerator from './world/IslandGenerator.js';
import HazardsSystem   from './world/HazardsSystem.js';

// ── UI ───────────────────────────────────────────────────────────────────────
import HUD            from './ui/HUD.js';
import UIPanel        from './ui/UIPanel.js';
import MissionUI      from './ui/MissionUI.js';
import DialogueSystem from './ui/DialogueSystem.js';
import Minimap    from './ui/Minimap.js';

// ── Config ───────────────────────────────────────────────────────────────────
import GameConfig from './config/GameConfig.js';
import EventEmitter from './utils/EventEmitter.js';
import { ShipClass, Faction } from './config/ShipConfig.js';
import AudioSystem from './systems/AudioSystem.js';
import { submitScore, getLeaderboard, checkNameAvailability, registerPlayerName } from './utils/SupabaseClient.js';

// ══════════════════════════════════════════════════════════════════════════════
class Game {
  constructor() {
    // Populated during init()
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;
    this.clock    = null;

    this.ocean        = null;
    this.sky          = null;
    this.playerShip   = null;

    this._systems     = [];  // ordered list of systems with update()
    this._running     = false;
    this._isGameOver  = false;
    this._paused      = false;
    this._killCount   = 0;
    this._allyShips   = [];
    this._healingAtIsland = false;
    this._healDisplayTimer = 0;
    this._bossAnnounced   = false;
    this._scoreSubmitted  = false;
    this._bossDefeated    = false;
    this._treasuresFound  = 0;

    this._gameTimer        = 0;
    this._treasureMarks    = [];
    this._stormTimer       = 100 + Math.random() * 80;
    this._stormActive      = false;
    this._stormDuration    = 0;
    this._boardingCooldown = 0;

    // Multiplayer
    this.isCoop        = false;
    this.mp            = null;   // MultiplayerSystem
    this._partnerShip  = null;  // Ghost ship object for partner
    this._partnerRescueTimer = 0;
    this._worldLogQueue = [];

    // World events
    this.worldEvents   = null;  // WorldEventSystem

    // Wind Dynamics
    this.windAngle        = Math.random() * Math.PI * 2;
    this.windStrength     = 0.8;
    this.windTimer        = 180;
    this._targetWindAngle = this.windAngle;

    /** @type {AudioSystem|null} */
    this.audio        = null;

    // Player Name & Unique ID
    this.playerName = localStorage.getItem('pe_player_name') || '';
    this.playerId   = localStorage.getItem('pe_player_id') || null;

    if (!this.playerName) {
      this.playerName = this._generateRandomPirateName();
    }
  }

  _generateRandomPirateName() {
    const adjectives = ['Black', 'Red', 'Jolly', 'Dread', 'Scurvy', 'Iron', 'Golden', 'Blind', 'Cursed', 'Stormy'];
    const nouns = ['Beard', 'Roger', 'Hook', 'Morgan', 'Flint', 'Drake', 'Hawkins', 'Kidd', 'Silver', 'Vane'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `Captain ${adj}${noun}`;
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async init() {
    // ── 1. THREE.js core ────────────────────────────────────────────────────
    this._initRenderer();

    // ── 2. Asset loading ────────────────────────────────────────────────────
    await this._loadAssets();

    // ── 3. World (ocean, sky, islands) — runs BEFORE menu so it's visible
    //       in the live background ─────────────────────────────────────────
    this._initWorld();

    // ── 4. Setup player name UI ──────────────────────────────────────────────
    const nameInput = document.getElementById('mm-player-name');
    const saveBtn   = document.getElementById('mm-save-name');
    const statusEl  = document.getElementById('mm-name-status');

    const updateStatus = (statusClass, text) => {
      if (!statusEl) return;
      statusEl.className = `mm-name-status ${statusClass}`;
      statusEl.textContent = text;
    };

    if (nameInput && saveBtn && statusEl) {
      nameInput.value = this.playerName;

      // Initial status state
      if (localStorage.getItem('pe_player_name') && this.playerId) {
        updateStatus('owned', '⚓ You own this pirate name!');
        saveBtn.disabled = true;
      } else if (localStorage.getItem('pe_player_name')) {
        updateStatus('available', '⛵ Save to register your name!');
        saveBtn.disabled = false;
      } else {
        updateStatus('', '🏴‍☠️ Type a name and click Save to reserve it');
        saveBtn.disabled = false;
      }

      let debounceTimeout = null;

      // Real-time input validation and debounced lookup
      nameInput.addEventListener('input', () => {
        let val = nameInput.value.replace(/[^a-zA-Z0-9\s\-]/g, '');
        if (val.length > 15) val = val.substring(0, 15);
        nameInput.value = val;

        const trimmed = val.trim();
        if (trimmed.length < 3) {
          updateStatus('invalid', '⚓ Name must be at least 3 characters');
          saveBtn.disabled = true;
          return;
        }

        updateStatus('checking', '⚓ Scanning the pirate registry...');
        saveBtn.disabled = true;

        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {
          try {
            const res = await checkNameAvailability(trimmed, this.playerId);
            if (res.error) {
              updateStatus('invalid', '⚠️ Connection failed (registry unreachable)');
              // If Supabase is offline/paused, let them click Save anyway as fallback
              saveBtn.disabled = false;
              return;
            }

            if (res.available) {
              if (res.owned) {
                updateStatus('owned', '⚓ You own this pirate name!');
                saveBtn.disabled = true;
              } else {
                updateStatus('available', '⛵ Name is available!');
                saveBtn.disabled = false;
              }
            } else {
              updateStatus('taken', '☠️ Taken by another captain');
              saveBtn.disabled = true;
            }
          } catch (err) {
            console.error('[Name Check] Error:', err);
            updateStatus('invalid', '⚠️ Error scanning registry');
            saveBtn.disabled = false;
          }
        }, 500);
      });

      // Save name action
      saveBtn.addEventListener('click', async () => {
        const trimmed = nameInput.value.trim();
        if (trimmed.length < 3) return;

        saveBtn.disabled = true;
        nameInput.disabled = true;
        updateStatus('checking', '⚓ Writing to the ledger...');

        try {
          const res = await registerPlayerName(trimmed, this.playerId);
          if (res.success) {
            this.playerName = trimmed;
            this.playerId = res.id;
            localStorage.setItem('pe_player_name', this.playerName);
            localStorage.setItem('pe_player_id', this.playerId);
            updateStatus('owned', '⚓ Registered successfully!');
            saveBtn.disabled = true;
            console.log(`[Name Registered] Welcome, Captain ${trimmed}! ID: ${res.id}`);
          } else {
            updateStatus('invalid', `⚠️ Save failed: ${res.error}`);
            saveBtn.disabled = false;
          }
        } catch (err) {
          console.error('[Name Save] Error:', err);
          updateStatus('invalid', '⚠️ Error writing to ledger');
          saveBtn.disabled = false;
        } finally {
          nameInput.disabled = false;
        }
      });
    }

    // ── 5. Hide loading, show main menu ──────────────────────────────────────
    this._hideLoading();
    this._showMainMenu();
  }

  /** Called by the Play button — kicks off all game systems and the loop. */
  _startGame() {
    // ── 4. Game systems ─────────────────────────────────────────────────────
    this._initSystems();

    // ── 4b. Audio (must start inside a user-gesture call stack) ──────────────
    this.audio = new AudioSystem();
    this.audio.setPlayerShip(this.playerShip);
    // Apply whatever the settings sliders are currently set to
    const masterSlider = document.getElementById('s-master');
    const sfxSlider    = document.getElementById('s-sfx');
    const masterVol    = (masterSlider ? parseInt(masterSlider.value, 10) : 80) / 100;
    const sfxVol       = (sfxSlider    ? parseInt(sfxSlider.value,    10) : 80) / 100;
    this.audio.setVolumes(masterVol, sfxVol);
    this.audio.start();

    // ── 5. UI ────────────────────────────────────────────────────────────────
    this._initUI();

    // ── 6. Reveal game UI ────────────────────────────────────────────────────
    document.body.classList.add('game-started');

    // ── 7. Start game loop ───────────────────────────────────────────────────
    this.start();
  }

  // ── Renderer ───────────────────────────────────────────────────────────────

  _initRenderer() {
    this.scene  = new THREE.Scene();
    this.clock  = new THREE.Clock();

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.5,
      2000,
    );

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    document.getElementById('canvas-container').appendChild(this.renderer.domElement);

    // Resize handler
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── Asset Loading ──────────────────────────────────────────────────────────

  async _loadAssets() {
    const bar       = document.getElementById('loading-bar-fill');
    const loadingTxt = document.getElementById('loading-text');

    const messages = [
      'Summoning the seas...',
      'Loading the Black Pearl...',
      'Training the crew...',
      'Stocking the cannons...',
      'Charting the islands...',
      'Raising the Jolly Roger...',
      'Almost ready to sail!',
    ];
    let msgIdx = 0;

    await AssetLoader.load((loaded, total, name) => {
      const pct = loaded / total;
      if (bar) bar.style.width = `${pct * 100}%`;
      if (loadingTxt) {
        const idx = Math.floor(pct * (messages.length - 1));
        if (idx !== msgIdx) {
          msgIdx = idx;
          loadingTxt.textContent = messages[idx];
        }
      }
    });

    if (loadingTxt) loadingTxt.textContent = 'Setting sail!';
  }

  // ── World ──────────────────────────────────────────────────────────────────

  _initWorld() {
    // Sky and lighting
    this.sky = new SkySystem(this.scene, this.renderer);

    // Ocean wave plane
    this.ocean = new Ocean(this.scene);

    // Islands
    const generator = new IslandGenerator(this.scene);
    this._islands   = generator.generate();

    // World hazards: shipwrecks, abandoned boats, dangerous rocks
    this.hazards = new HazardsSystem(this.scene, this._islands);

    // Scatter floating world debris
    this._scatterDebris();
  }

  // ── Game Systems ──────────────────────────────────────────────────────────

  _initSystems() {
    // Input
    this.input = new InputSystem();

    // Ships
    this.ships = new ShipSystem(this.scene, this.ocean);

    // Spawn player ship
    this.playerShip = this.ships.createShip(
      ShipClass.PIRATE_SMALL,
      Faction.PLAYER,
      0, 0,
    );

    // Camera follows player
    this.cameraSystem = new CameraSystem(this.camera, this.scene);
    this.cameraSystem.setTarget(this.playerShip.group);
    this.sky.setPlayerRef(this.playerShip.group);

    // Combat
    this.combat = new CombatSystem(this.scene, this.ships);

    // Economy
    this.economy = new EconomySystem();

    // Islands
    this.islandSys = new IslandSystem(this._islands, this.economy, this.input, this.ships, this.combat);
    this.combat.setIslands(this._islands);
    this.ships.setIslands(this._islands);

    // Wake trails for all ships
    this.wake = new WakeSystem(this.scene);

    // Seagulls circling islands
    this.birds = new BirdSystem(this.scene, this._islands);

    // Floating loot pickups
    this.loot = new LootSystem(
      this.scene,
      this._islands,
      this.economy,
      this.ocean,
      GameConfig.WORLD_SIZE / 2,
    );

    // Roguelite Perk System
    this.perks = new PerkSystem(this.scene, this.playerShip, this.economy);

    // Listen for perk collected to show a toast
    EventEmitter.on('perk:collected', ({ perk }) => {
      this.hud?.toast(`${perk.icon} Perk Unlocked: ${perk.name}!`, 'success');
    });

    // AI enemies
    this.ai = new AISystem(this.ships, this.combat, this._islands);
    this.ai.spawnInitialEnemies();

    // World Event System (Living Ocean)
    this.worldEvents = new WorldEventSystem(this.ships, this.ai, this);

    // Story Mode System (fires cinematic beats and dialogue)
    this.story = new StorySystem(this, this.playerName);

    // Wire world events to UI
    EventEmitter.on('world:log', (text) => {
      this._showWorldLog(text);
    });


    EventEmitter.on('world:legendary_defeated', ({ cap, mem }) => {
      const bonus = 300 + mem.timesDefeated * 100;
      this.economy.add('gold', bonus);
      this.hud?.toast(`💀 ${cap.name} DEFEATED! +${bonus} gold!`, 'success');
      document.getElementById('legendary-dialogue')?.classList.add('hidden');
    });

    EventEmitter.on('world:reputation_changed', ({ rep }) => {
      const hudEl   = document.getElementById('reputation-hud');
      const titleEl = document.getElementById('rep-title');
      const fillEl  = document.getElementById('rep-bar-fill');
      const scoreEl = document.getElementById('rep-score');
      if (!hudEl) return;
      hudEl.classList.remove('hidden');
      const title = this.worldEvents.getReputationTitle();
      if (titleEl) titleEl.textContent = `${this.playerName} (${title})`;
      if (scoreEl) scoreEl.textContent = rep;
      if (fillEl)  fillEl.style.width  = `${Math.min(100, (rep / 6000) * 100).toFixed(1)}%`;
      if (rep >= 3000) {
        hudEl.classList.add('legendary');
      }
    });

    EventEmitter.on('world:island_raid', ({ island }) => {
      this.hud?.toast('🔥 YOUR ISLAND IS UNDER ATTACK! DEFEND IT!', 'danger');
      this._showWorldLog('🔥 Pirates are raiding your island!');
    });

    EventEmitter.on('world:storm_surge', () => {
      this.hud?.toast('🌩️ A massive storm surge hits the ocean!', 'danger');
    });

    EventEmitter.on('world:kraken_hit', () => {
      this.hud?.toast('🦑 A kraken tentacle hit your ship!', 'danger');
    });

    // Show/hide reputation HUD and missions panel based on mode
    const repHud = document.getElementById('reputation-hud');
    const rightPanel = document.getElementById('right-panel');
    if (this._storyMode) {
      repHud?.classList.add('hidden');
      rightPanel?.classList.add('hidden');
    } else {
      rightPanel?.classList.remove('hidden');
      if (repHud) {
        repHud.classList.remove('hidden');
        const initialRep = this.worldEvents?.reputation ?? 0;
        const initialTitle = this.worldEvents?.getReputationTitle() ?? 'Unknown Sailor';
        const repTitleEl = document.getElementById('rep-title');
        const repScoreEl = document.getElementById('rep-score');
        const repFillEl  = document.getElementById('rep-bar-fill');
        if (repTitleEl) repTitleEl.textContent = `${this.playerName} (${initialTitle})`;
        if (repScoreEl) repScoreEl.textContent = initialRep;
        if (repFillEl)  repFillEl.style.width  = `${Math.min(100, (initialRep / 6000) * 100).toFixed(1)}%`;
      }
    }
    document.getElementById('world-log-ticker')?.classList.remove('hidden');

    // Story: reputation changes → update story-rep-hud  (fix: use story._killCount)
    EventEmitter.on('story:reputation_changed', ({ tier }) => {
      const hudEl   = document.getElementById('story-rep-hud');
      const tierEl  = document.getElementById('story-rep-tier');
      const killsEl = document.getElementById('story-rep-kills');
      if (!hudEl) return;
      if (this._storyMode) hudEl.classList.remove('hidden');
      if (tierEl)  tierEl.textContent = tier.title;
      if (tierEl)  tierEl.style.color = tier.color;
      if (killsEl) killsEl.textContent = `⚔ ${this.story?._killCount ?? 0} ships sunk`;
    });

    // Story: objective update → mission bar
    EventEmitter.on('story:objective_update', ({ objective, progress, killCount, captureCount, currentAct }) => {
      if (!this._storyMode) return;
      const bar       = document.getElementById('story-objective-bar');
      const badgeEl   = document.getElementById('obj-act-badge');
      const textEl    = document.getElementById('obj-text');
      const fillEl    = document.getElementById('obj-progress-fill');
      const labelEl   = document.getElementById('obj-progress-label');

      if (!bar) return;
      bar.classList.remove('hidden');

      // Act badge
      const actLabels = { act1: 'ACT I', act2: 'ACT II', act3: 'ACT III', final: 'FINAL ACT' };
      if (badgeEl) badgeEl.textContent = actLabels[currentAct] || 'ACT I';

      if (objective) {
        if (textEl) textEl.textContent = objective.text;

        const pct = Math.round(progress * 100);
        if (fillEl) fillEl.style.width = `${pct}%`;

        // Progress label
        if (labelEl) {
          if (objective.type === 'KILLS')
            labelEl.textContent = `${killCount} / ${objective.max} ships sunk`;
          else if (objective.type === 'CAPTURES')
            labelEl.textContent = `${captureCount} / ${objective.max} islands captured`;
          else if (objective.type === 'TIME')
            labelEl.textContent = `Survive…`;
          else if (objective.type === 'DISTANCE')
            labelEl.textContent = `Navigate to the marked location`;
          else
            labelEl.textContent = '';
        }
      } else {
        // All beats done in this act
        if (textEl) textEl.textContent = 'Holding the line…';
        if (fillEl) fillEl.style.width = '100%';
        if (labelEl) labelEl.textContent = '';
      }
    });

    // Story: waypoint → compass needle
    EventEmitter.on('story:waypoint', ({ x, z, label }) => {
      if (!this._storyMode) return;
      this._activeWaypoint = { x, z, label };
      const compass = document.getElementById('story-waypoint-compass');
      const labelEl = document.getElementById('waypoint-label');
      if (compass) compass.classList.remove('hidden');
      if (labelEl) labelEl.textContent = label || 'Destination';
      this.hud?.toast(`🗺️ Waypoint set: ${label} — follow the compass!`, 'info');
    });

    this.buildSys = new BuildSystem(this.islandSys, this.economy);

    // Missions
    this.missions = new MissionSystem(this.economy, this.islandSys);

    // Treasure maps — 4 random world destinations
    const _half = GameConfig.WORLD_SIZE / 2 - 120;
    for (let i = 0; i < 4; i++) {
      this._treasureMarks.push({
        x: (Math.random() * 2 - 1) * _half,
        z: (Math.random() * 2 - 1) * _half,
        found: false,
      });
    }

    // Emit initial economy state so HUD populates
    EventEmitter.emit('economy:changed', { ...this.economy.resources });

    // Listen for player ship upgrades and apply to ship stats
    EventEmitter.on('upgrade:purchased', ({ upgrade }) => {
      this._applyUpgradeToPlayer(upgrade);
    });

    // Ally ship recruitment via Shipyard
    this._allyShips = [];
    EventEmitter.on('fleet:recruit', () => {
      const island = this._islands.find(isl =>
        isl.captured && isl.owner === 'PLAYER' && isl.buildings.includes('SHIPYARD'));
      if (!island) return;
      if (this.economy.resources.crew < 5) return;
      this.economy.spend({ crew: 5 });
      const x = island.position.x + (Math.random() - 0.5) * 20;
      const z = island.position.z + (Math.random() - 0.5) * 20;
      const ally = this.ships.createShip(ShipClass.PIRATE_SMALL, Faction.PLAYER, x, z);
      this._allyShips.push(ally);
    });
  }

  _applyUpgradeToPlayer(upgrade, targetShip = null) {
    const ship = targetShip ?? this.playerShip;
    if (!ship) return;
    switch (upgrade.stat) {
      case 'speed':
        ship.speed       *= (1 + upgrade.bonus); break;
      case 'maxHealth':
        ship.maxHealth   = Math.round(ship.maxHealth * (1 + upgrade.bonus));
        ship.health      = Math.min(ship.health, ship.maxHealth);
        break;
      case 'cannonPower':
        ship.cannonPower *= (1 + upgrade.bonus); break;
      case 'fireRate':
        // Reduces cannon cooldown via a persisted multiplier on ship
        ship._fireCooldownMult = (ship._fireCooldownMult ?? 1) * (1 - upgrade.bonus);
        break;
      case 'shipClass':
        this._upgradePlayerShip(upgrade.shipClass); break;
    }
  }

  _upgradePlayerShip(newClass) {
    const old = this.playerShip;
    if (!old) return;
    const pos    = old.group.position.clone();
    const rotY   = old.group.rotation.y;
    const hpFrac = old.health / old.maxHealth;

    // Remove old ship from scene and ship map
    this.scene.remove(old.group);
    this.ships._ships.delete(old.id);

    // Spawn new ship at same location
    const newShip = this.ships.createShip(newClass, Faction.PLAYER, pos.x, pos.z);
    newShip.group.rotation.y = rotY;
    newShip.health = Math.max(1, Math.round(newShip.maxHealth * hpFrac));

    // Re-apply all purchased stat upgrades (skip shipClass to avoid recursion)
    for (const upg of GameConfig.UPGRADES) {
      if (upg.stat === 'shipClass') continue;
      if (this.economy.hasUpgrade(upg.id)) {
        this._applyUpgradeToPlayer(upg, newShip);
      }
    }

    this.playerShip = newShip;
    this.cameraSystem.setTarget(newShip.group);
    this.sky.setPlayerRef(newShip.group);
    this.audio?.setPlayerShip(newShip);
    // Keep perk system pointing at new ship
    if (this.perks) this.perks.playerShip = newShip;
  }

  /** Clean entry point to launch story mode (resume or new). */
  _launchStoryMode(menu, resetFirst = false) {
    if (resetFirst) {
      this.story?.reset();
    }
    this._menuRafRunning = false;
    menu?.classList.add('hidden');
    document.getElementById('mm-version')?.remove();
    this.isCoop     = false;
    this._storyMode = true;
    this._startGame();
    setTimeout(() => {
      if (this.story) {
        this.story.start();
        document.getElementById('story-rep-hud')?.classList.remove('hidden');
        document.getElementById('story-objective-bar')?.classList.remove('hidden');
      }
    }, 1500);
  }

  /** Shows the resume campaign modal with saved progress data. */
  _showResumeModal(saved, menu) {
    const modal      = document.getElementById('story-resume-modal');
    if (!modal) {
      // Fallback — just launch directly
      this._launchStoryMode(menu, false);
      return;
    }

    // Populate modal
    const actTitles = {
      act1: 'ACT I — BLOOD ON THE TIDE',
      act2: 'ACT II — STORM BEFORE THE DARKNESS',
      act3: 'ACT III — THE RETURN OF THE DEAD',
      final: 'FINAL ACT — THE HOLLOW DEEP',
    };
    const repTierTitles = [
      { threshold: 0,    title: 'Unknown Sailor' },
      { threshold: 100,  title: 'Troublemaker' },
      { threshold: 300,  title: 'Infamous Raider' },
      { threshold: 600,  title: 'Feared Captain' },
      { threshold: 1000, title: 'Legendary Privateer' },
      { threshold: 2000, title: 'Dread of the Seas' },
      { threshold: 4000, title: '☠️ THE PIRATE LEGEND' },
    ];

    const actLabelEl = document.getElementById('resume-act-label');
    if (actLabelEl) actLabelEl.textContent = actTitles[saved.act] || actTitles.act1;

    const killsEl = document.getElementById('resume-kills');
    const capEl   = document.getElementById('resume-captures');
    const repEl   = document.getElementById('resume-rep');
    if (killsEl) killsEl.textContent = saved.kills ?? 0;
    if (capEl)   capEl.textContent   = saved.captures ?? 0;

    if (repEl && saved.rep) {
      const brothRep = saved.rep['BROTHERHOOD'] ?? 0;
      let repTitle = 'Unknown Sailor';
      for (const t of repTierTitles) {
        if (brothRep >= t.threshold) repTitle = t.title;
      }
      repEl.textContent = repTitle;
    }

    // Act dots
    const dotsEl   = document.getElementById('resume-act-dots');
    const actOrder = ['act1', 'act2', 'act3', 'final'];
    const actNames  = ['Act I', 'Act II', 'Act III', 'Final'];
    const curIdx    = actOrder.indexOf(saved.act ?? 'act1');
    if (dotsEl) {
      dotsEl.innerHTML = '';
      actOrder.forEach((act, i) => {
        const dot = document.createElement('div');
        dot.className = 'resume-act-dot' +
          (i < curIdx ? ' done' : i === curIdx ? ' current' : '');
        const tip = document.createElement('span');
        tip.className = 'dot-tip';
        tip.textContent = actNames[i];
        dot.appendChild(tip);
        dotsEl.appendChild(dot);
      });
    }

    modal.classList.remove('hidden');

    // Wire buttons
    const continueBtn = document.getElementById('resume-continue-btn');
    const newBtn      = document.getElementById('resume-new-btn');

    const cleanup = () => modal.classList.add('hidden');

    continueBtn?.addEventListener('click', () => {
      cleanup();
      this._launchStoryMode(menu, false);   // keep save intact
    }, { once: true });

    newBtn?.addEventListener('click', () => {
      cleanup();
      this._launchStoryMode(menu, true);    // reset save first
    }, { once: true });
  }

  _togglePause() {
    this._paused = !this._paused;
    const overlay = document.getElementById('pause-overlay');
    if (overlay) overlay.classList.toggle('hidden', !this._paused);
  }

  _toggleJournal() {
    const journal = document.getElementById('captains-journal');
    if (!journal) return;
    const isOpen = !journal.classList.contains('hidden');
    this.audio?.playPageTurn();
    if (isOpen) {
      journal.classList.add('hidden');
    } else {
      journal.classList.remove('hidden');
      this._renderJournal();
    }
  }

  _renderJournal() {
    if (!this.story) return;

    // Logbook Tab
    const actIndicator = document.getElementById('journal-act-indicator');
    const actTimeline = document.getElementById('journal-act-timeline');
    const objectiveBox = document.getElementById('journal-objective-box');

    // Get current act details
    const actLabels = {
      act1: { title: 'ACT I', subtitle: 'BLOOD ON THE TIDE', color: '#c8a415' },
      act2: { title: 'ACT II', subtitle: 'STORM BEFORE THE DARKNESS', color: '#cc4422' },
      act3: { title: 'ACT III', subtitle: 'THE RETURN OF THE DEAD', color: '#7722dd' },
      final: { title: 'FINAL ACT', subtitle: 'THE HOLLOW DEEP', color: '#00d4aa' }
    };
    const curAct = actLabels[this.story._currentAct] || actLabels.act1;

    if (actIndicator) {
      actIndicator.innerHTML = `<span style="color: ${curAct.color}">${curAct.title}</span> — <span>${curAct.subtitle}</span>`;
    }

    // Timeline dots
    if (actTimeline) {
      const actOrder = ['act1', 'act2', 'act3', 'final'];
      const actNames = ['Act I', 'Act II', 'Act III', 'Final Act'];
      const curIdx = actOrder.indexOf(this.story._currentAct);
      
      actTimeline.innerHTML = actOrder.map((act, idx) => {
        let cls = 'jact-dot';
        if (idx < curIdx) cls += ' done';
        else if (idx === curIdx) cls += ' current';
        return `
          <div class="${cls}">
            <span class="tooltip">${actNames[idx]}</span>
          </div>
        `;
      }).join('');
    }

    // Objective
    if (objectiveBox) {
      const obj = this.story.getCurrentObjective();
      if (obj) {
        const pct = Math.round(this.story.getObjectiveProgress() * 100);
        let progressLabel = '';
        if (obj.type === 'KILLS') {
          progressLabel = `${this.story._killCount} / ${obj.max} ships sunk`;
        } else if (obj.type === 'CAPTURES') {
          progressLabel = `${this.story._captureCount} / ${obj.max} islands captured`;
        } else if (obj.type === 'TIME') {
          progressLabel = `Survive...`;
        } else if (obj.type === 'DISTANCE') {
          progressLabel = `Navigate to marked location`;
        }

        objectiveBox.innerHTML = `
          <div class="jobj-text">${obj.text}</div>
          <div class="jobj-bar-track">
            <div class="jobj-bar-fill" style="width: ${pct}%"></div>
          </div>
          <div class="jobj-label">${progressLabel}</div>
        `;
      } else {
        objectiveBox.innerHTML = `
          <div class="jobj-text">All current objectives completed. Hold the line.</div>
          <div class="jobj-bar-track">
            <div class="jobj-bar-fill" style="width: 100%"></div>
          </div>
        `;
      }
    }

    // Radio Logs Tab
    const radioHistory = document.getElementById('journal-radio-history');
    if (radioHistory) {
      const history = this.story._dialogueHistory || [];
      if (history.length === 0) {
        radioHistory.innerHTML = '<div style="font-style: italic; color: #5c3a17; text-align: center; margin-top: 40px;">No dialogue transmissions logged yet.</div>';
      } else {
        radioHistory.innerHTML = history.map(h => `
          <div class="jlog-card">
            <div class="jlog-speaker">${h.speaker}</div>
            <p class="jlog-text">${h.text}</p>
          </div>
        `).reverse().join('');
      }
    }

    // Diplomacy Tab
    const dList = document.getElementById('journal-diplomatic-list');
    if (dList) {
      const factionIds = [
        { id: 'ROYAL_NAVY', name: '👑 Royal Navy' },
        { id: 'BROTHERHOOD', name: '🏴‍☠️ Brotherhood' },
        { id: 'GHOST_FLEET', name: '👻 Ghost Fleet' },
        { id: 'MERCHANTS', name: '📦 Merchants' },
        { id: 'BLACK_TIDE', name: '🌊 Black Tide' },
        { id: 'HUNTERS', name: '🎯 Bounty Hunters' },
        { id: 'CULT', name: '🔮 Deep Cult' }
      ];

      dList.innerHTML = factionIds.map(f => {
        const rep = this.story.getFactionReputation(f.id);
        // Normalize: range -1000 to 2000
        const pct = Math.min(100, Math.max(0, ((rep + 1000) / 3000) * 100));
        
        let standing = 'Neutral';
        let barColor = '#888';
        if (rep >= 1000) { standing = 'Venerated Ally'; barColor = '#22cc88'; }
        else if (rep >= 300) { standing = 'Trusted'; barColor = '#f0c040'; }
        else if (rep >= -100) { standing = 'Neutral'; barColor = '#a0a0a0'; }
        else if (rep >= -400) { standing = 'Wary'; barColor = '#ff8020'; }
        else { standing = 'Hostile'; barColor = '#dd3333'; }

        return `
          <div class="jdip-row">
            <div class="jdip-name-col">${f.name}</div>
            <div class="jdip-bar-col">
              <div class="jdip-bar-track">
                <div class="jdip-bar-fill" style="width: ${pct}%; background: ${barColor};"></div>
                <div class="jdip-standing-label">${standing}</div>
              </div>
            </div>
            <div class="jdip-score-col">${rep > 0 ? '+' : ''}${rep}</div>
          </div>
        `;
      }).join('');
    }
  }

  _updateAllyShips(delta) {
    const enemies = this.ships.enemies;
    for (let i = this._allyShips.length - 1; i >= 0; i--) {
      const ally = this._allyShips[i];
      if (!ally.isAlive) {
        this._allyShips.splice(i, 1);
        continue;
      }
      if (!ally.isSailing) continue;

      let nearest = null, nearestDist = 9999;
      for (const enemy of enemies) {
        const d = ally.group.position.distanceTo(enemy.group.position);
        if (d < nearestDist) { nearestDist = d; nearest = enemy; }
      }

      if (nearest && nearestDist < 150) {
        const tx = nearest.group.position.x - ally.group.position.x;
        const tz = nearest.group.position.z - ally.group.position.z;
        const targetAngle = Math.atan2(tx, tz) + Math.PI;
        let diff = ((targetAngle - ally.group.rotation.y) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        ally.steering = Math.sign(diff) * Math.min(1, Math.abs(diff) * 3);
        ally.thrust   = nearestDist < 60 ? 0.2 : 0.8;
        if (nearestDist < 65) this.combat.fireCannons(ally);
      } else {
        // No enemy nearby — follow the player
        const player = this.playerShip;
        if (player?.isSailing) {
          const dToPlayer = ally.group.position.distanceTo(player.group.position);
          if (dToPlayer > 25) {
            const tx = player.group.position.x - ally.group.position.x;
            const tz = player.group.position.z - ally.group.position.z;
            const ang = Math.atan2(tx, tz) + Math.PI;
            let df = ((ang - ally.group.rotation.y) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
            ally.steering = Math.sign(df) * Math.min(1, Math.abs(df) * 3);
            ally.thrust   = dToPlayer > 60 ? 0.9 : 0.4;
          } else {
            ally.thrust   = 0;
            ally.steering = 0;
          }
        } else {
          ally.thrust   = 0;
          ally.steering = 0;
        }
      }
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  _initUI() {
    this.hud = new HUD(this.camera, this.renderer.domElement);

    this.uiPanel = new UIPanel(
      this.economy,
      this.buildSys,
      this.islandSys,
      this.ships,
    );

    this.missionUI = new MissionUI(this.missions);

    this.minimap = new Minimap(
      this.ships,
      this.islandSys,
      GameConfig.WORLD_SIZE,
    );

    // Cinematic Dialogue System
    this.dialogue = new DialogueSystem(this.playerName);
    if (this.story) this.story.game = this; // ensure game ref is set

    // Act Banner handler
    EventEmitter.on('story:act_banner', ({ title, subtitle, color }) => {
      const banner    = document.getElementById('act-banner');
      const titleEl   = document.getElementById('act-banner-title');
      const subEl     = document.getElementById('act-banner-subtitle');
      if (!banner || !titleEl || !subEl) return;
      titleEl.textContent = title;
      subEl.textContent   = subtitle;
      banner.style.setProperty('--act-color', color);
      banner.classList.remove('hidden');
      banner.classList.add('active');
      // Clone the inner node to restart animation
      const inner = banner.querySelector('.act-banner-inner');
      if (inner) {
        const clone = inner.cloneNode(true);
        inner.parentNode.replaceChild(clone, inner);
      }
      setTimeout(() => {
        banner.classList.remove('active');
        banner.classList.add('hidden');
      }, 5200);
    });

    // Blood Moon atmospheric overlay handler
    EventEmitter.on('story:blood_moon', ({ active }) => {
      const overlay = document.getElementById('blood-moon-overlay');
      if (!overlay) return;
      if (active) {
        overlay.classList.remove('hidden');
        if (this.sky) {
          this.sky.setBloodMoonIntensity(1.0);
        }
        this.hud?.toast('🌕 Blood Moon rises over the Shattered Seas!', 'danger');
      } else {
        overlay.classList.add('hidden');
        if (this.sky) {
          this.sky.setBloodMoonIntensity(0.0);
        }
      }
    });

    // Story Mode: legend dialogue also goes through DialogueSystem
    EventEmitter.on('world:legendary_dialogue', (data) => {
      // Still show the original legendary popup
      const el    = document.getElementById('legendary-dialogue');
      const nameEl  = document.getElementById('legend-name');
      const titleEl = document.getElementById('legend-title');
      const angerEl = document.getElementById('legend-anger');
      const quoteEl = document.getElementById('legend-quote');
      if (el && nameEl) {
        if (nameEl)  nameEl.textContent  = data.name;
        if (titleEl) titleEl.textContent = data.title;
        if (angerEl) {
          const rage = data.angerLevel;
          angerEl.textContent = rage > 0 ? `🔥 ANGER LEVEL ${rage}/10` + (rage >= 8 ? ' — ENRAGED!' : '') : '';
        }
        if (quoteEl) quoteEl.textContent = `"${data.text}"`;
        el.classList.remove('hidden');
        clearTimeout(this._legendaryDialogueTimeout);
        this._legendaryDialogueTimeout = setTimeout(() => el.classList.add('hidden'), 8000);
      }
    });

    // Captain's Journal UI event listeners
    document.querySelectorAll('.journal-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.audio?.playPageTurn();
        document.querySelectorAll('.journal-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.jtab;
        document.querySelectorAll('.journal-pane').forEach(pane => {
          pane.classList.toggle('hidden', pane.id !== `jpane-${tab}`);
        });
        this._renderJournal();
      });
    });

    document.getElementById('journal-close-btn')?.addEventListener('click', () => {
      this.audio?.playPageTurn();
      document.getElementById('captains-journal')?.classList.add('hidden');
    });

    // Wire up pause overlay buttons
    document.getElementById('btn-resume')?.addEventListener('click', () => this._togglePause());
    document.getElementById('btn-quit')?.addEventListener('click', () => location.reload());

    // Victory restart button
    document.getElementById('btn-victory-restart')?.addEventListener('click', () => location.reload());
  }

  // ── Player Death Sequence ─────────────────────────────────────────────────

  /**
   * Called as soon as the player's ship reaches health 0.
   * Triggers explosion + cinematic camera.
   */
  _onPlayerDestroyed() {
    if (this._isGameOver) return;
    this._isGameOver = true;

    const pos = this.playerShip.group.position.clone();

    // 1. Big death explosion
    this.combat.spawnDeathExplosion(pos);

    // 2. Cinematic orbit camera
    this.cameraSystem.startCinematic(pos);

    // 3. Spawn floating treasure loot at death location
    const lootKeys = ['barrel', 'crate', 'chest', 'crate-bottles'];
    for (let i = 0; i < 6; i++) {
      const spawnPos = pos.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        0,
        (Math.random() - 0.5) * 14,
      ));
      const key   = lootKeys[Math.floor(Math.random() * lootKeys.length)];
      const model = AssetLoader.get(key);
      model.position.copy(spawnPos);
      model.position.y = 1.5;
      model.scale.setScalar(1.0 + Math.random() * 0.3);
      model.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(model);
    }

    // 4. After SINKING_DURATION + small buffer, show game over screen
    setTimeout(() => this._showGameOver(), (GameConfig.SINKING_DURATION + 1.5) * 1000);
  }

  /** Show the styled Game Over overlay with final stats. */
  _showGameOver() {
    const overlay   = document.getElementById('game-over-overlay');
    const killsEl   = document.getElementById('go-kills');
    const goldEl    = document.getElementById('go-gold');
    const islandsEl = document.getElementById('go-islands');
    const btnRestart = document.getElementById('btn-restart');

    const gold = this.economy?.resources?.gold ?? 0;
    const kills = this._killCount;
    const islands = this.islandSys?.capturedCount ?? 0;

    if (killsEl)   killsEl.textContent   = kills;
    if (goldEl)    goldEl.textContent    = gold;
    if (islandsEl) islandsEl.textContent = islands;
    const timeEl = document.getElementById('go-time');
    if (timeEl)    timeEl.textContent    = this._formatTime(this._gameTimer);
    if (overlay)   overlay.classList.remove('hidden');

    if (btnRestart) {
      btnRestart.addEventListener('click', () => location.reload());
    }

    if (!this._scoreSubmitted) {
      this._scoreSubmitted = true;
      const score = gold + (kills * 100) + (islands * 250);
      this._submitAndLoadLeaderboard(score, 'go');
    }
  }

  /** Show the Victory overlay (called on game:victory event). */
  _showVictory() {
    const overlay = document.getElementById('victory-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    const gold = this.economy?.resources?.gold ?? 0;
    const kills = this._killCount;
    const islands = this.islandSys?.capturedCount ?? 0;

    document.getElementById('v-kills')?.setAttribute('data-val', kills);
    document.getElementById('v-kills') && (document.getElementById('v-kills').textContent = kills);
    document.getElementById('v-gold') && (document.getElementById('v-gold').textContent = gold);
    document.getElementById('v-islands') && (document.getElementById('v-islands').textContent = islands);
    document.getElementById('v-time') && (document.getElementById('v-time').textContent = this._formatTime(this._gameTimer ?? 0));

    if (!this._scoreSubmitted) {
      this._scoreSubmitted = true;
      const score = gold + (kills * 100) + (islands * 250);
      this._submitAndLoadLeaderboard(score, 'v');
    }
  }

  async _submitAndLoadLeaderboard(score, prefix) {
    const loadingEl   = document.getElementById(`${prefix}-leaderboard-loading`);
    const containerEl = document.getElementById(`${prefix}-leaderboard-container`);
    const rowsEl      = document.getElementById(`${prefix}-leaderboard-rows`);

    if (!loadingEl || !containerEl || !rowsEl) return;

    loadingEl.classList.remove('hidden');
    loadingEl.textContent = '⚓ Submitting your score...';
    containerEl.classList.add('hidden');
    rowsEl.innerHTML = '';

    const gold        = this.economy?.resources?.gold ?? 0;
    const kills       = this._killCount;
    const islands     = this.islandSys?.capturedCount ?? 0;
    const time        = this._gameTimer ?? 0;
    const allies      = this._allyShips?.filter(s => s.isAlive).length ?? 0;
    const treasures   = this._treasuresFound ?? 0;
    const bossDefeated = this._bossDefeated ?? false;
    const outcome     = prefix === 'v' ? 'victory' : 'defeat';

    const playerName  = this.playerName || 'Anonymous Pirate';

    // Auto-register guest if they don't have a registered ID yet
    if (!this.playerId) {
      console.log(`[Game] Player has no ID. Auto-registering guest: "${playerName}"`);
      try {
        const regRes = await registerPlayerName(playerName, null);
        if (regRes.success) {
          this.playerId = regRes.id;
          localStorage.setItem('pe_player_id', this.playerId);
          localStorage.setItem('pe_player_name', playerName);
          console.log(`[Game] Auto-registered successfully! ID: ${this.playerId}`);
        } else {
          console.warn(`[Game] Auto-registration failed: ${regRes.error}. Submitting as anonymous guest.`);
        }
      } catch (err) {
        console.error('[Game] Error during auto-registration:', err);
      }
    }

    console.log(`[Game] Submitting run: name="${playerName}" score=${score} gold=${gold} kills=${kills} islands=${islands} time=${time.toFixed(0)}s outcome=${outcome}`);

    const success = await submitScore(playerName, score, gold, kills, islands, time, allies, treasures, bossDefeated, outcome, this.playerId);
    if (!success) {
      loadingEl.textContent = '⚠️ Score could not be saved — check your internet connection. (See DevTools console for details.)';
      loadingEl.style.color = '#ff8080';
      return;
    }

    loadingEl.textContent = '🏆 Fetching high scores...';
    loadingEl.style.color = '';

    const scores = await getLeaderboard(10);
    if (scores && scores.length > 0) {
      scores.forEach((entry, index) => {
        const tr = document.createElement('tr');

        const rankTd = document.createElement('td');
        let rankText = index + 1;
        if (index === 0) rankText = '🥇';
        else if (index === 1) rankText = '🥈';
        else if (index === 2) rankText = '🥉';
        rankTd.textContent = rankText;

        const nameTd = document.createElement('td');
        nameTd.textContent = entry.player_name || 'Anonymous Captain';

        const outcomeTd = document.createElement('td');
        outcomeTd.textContent = entry.outcome === 'victory' ? '👑 Win' : '💀 Loss';
        outcomeTd.style.color = entry.outcome === 'victory' ? '#60ff60' : '#ff6060';

        const scoreTd = document.createElement('td');
        scoreTd.textContent = entry.score.toLocaleString();

        const goldTd = document.createElement('td');
        goldTd.textContent = entry.gold.toLocaleString();

        const killsTd = document.createElement('td');
        killsTd.textContent = entry.ships_destroyed;

        tr.appendChild(rankTd);
        tr.appendChild(nameTd);
        tr.appendChild(outcomeTd);
        tr.appendChild(scoreTd);
        tr.appendChild(goldTd);
        tr.appendChild(killsTd);

        rowsEl.appendChild(tr);
      });
      loadingEl.classList.add('hidden');
      containerEl.classList.remove('hidden');
    } else if (scores && scores.length === 0) {
      loadingEl.textContent = 'No scores yet — yours will appear after saving!';
    } else {
      loadingEl.textContent = '⚠️ Could not load high scores. See DevTools console.';
      loadingEl.style.color = '#ff8080';
    }
  }

  async _showLeaderboard() {
    const loadingEl = document.getElementById('leaderboard-loading');
    const containerEl = document.getElementById('leaderboard-container');
    const rowsEl = document.getElementById('leaderboard-rows');

    if (!loadingEl || !containerEl || !rowsEl) return;

    loadingEl.classList.remove('hidden');
    loadingEl.textContent = 'Loading high scores...';
    containerEl.classList.add('hidden');
    rowsEl.innerHTML = '';

    try {
      const scores = await getLeaderboard(10);
      if (scores && scores.length > 0) {
        scores.forEach((entry, index) => {
          const tr = document.createElement('tr');

          const rankTd = document.createElement('td');
          let rankText = index + 1;
          if (index === 0) rankText = '🥇';
          else if (index === 1) rankText = '🥈';
          else if (index === 2) rankText = '🥉';
          rankTd.textContent = rankText;

          const nameTd = document.createElement('td');
          nameTd.textContent = entry.player_name || 'Anonymous Captain';

          const outcomeTd = document.createElement('td');
          outcomeTd.textContent = entry.outcome === 'victory' ? '👑 Win' : '💀 Loss';
          outcomeTd.style.color = entry.outcome === 'victory' ? '#60ff60' : '#ff8080';

          const scoreTd = document.createElement('td');
          scoreTd.textContent = entry.score.toLocaleString();

          const goldTd = document.createElement('td');
          goldTd.textContent = entry.gold.toLocaleString();

          const killsTd = document.createElement('td');
          killsTd.textContent = entry.ships_destroyed;

          const islandsTd = document.createElement('td');
          islandsTd.textContent = entry.islands_captured;

          const alliesTd = document.createElement('td');
          alliesTd.textContent = entry.ally_ships ?? 0;

          const treasuresTd = document.createElement('td');
          treasuresTd.textContent = entry.treasures_found ?? 0;

          const bossTd = document.createElement('td');
          bossTd.textContent = entry.boss_defeated ? '☠️ Yes' : 'No';
          if (entry.boss_defeated) bossTd.style.color = '#ff8040';

          const timeTd = document.createElement('td');
          timeTd.textContent = this._formatTime(entry.time_survived);

          tr.appendChild(rankTd);
          tr.appendChild(nameTd);
          tr.appendChild(outcomeTd);
          tr.appendChild(scoreTd);
          tr.appendChild(goldTd);
          tr.appendChild(killsTd);
          tr.appendChild(islandsTd);
          tr.appendChild(alliesTd);
          tr.appendChild(treasuresTd);
          tr.appendChild(bossTd);
          tr.appendChild(timeTd);

          rowsEl.appendChild(tr);
        });
        loadingEl.classList.add('hidden');
        containerEl.classList.remove('hidden');
      } else {
        loadingEl.textContent = 'No voyages recorded yet. Set sail to claim the top spot!';
      }
    } catch (err) {
      console.error('[Leaderboard] Error loading leaderboard:', err);
      loadingEl.textContent = '⚠️ Failed to summon leaderboard from the depths.';
    }
  }

  /** Format seconds into "Xm Ys" string. */
  _formatTime(s) {
    const m = Math.floor(s / 60);
    return `${m}m ${Math.floor(s % 60)}s`;
  }

  // ── Loading screen ─────────────────────────────────────────────────────────

  _hideLoading() {
    const screen = document.getElementById('loading-screen');
    if (screen) {
      screen.classList.add('fade-out');
      setTimeout(() => screen.remove(), 900);
    }
  }

  // ── Main Menu ─────────────────────────────────────────────────────────────

  _showMainMenu() {
    const menu = document.getElementById('main-menu');
    if (menu) menu.classList.remove('hidden');

    // ── Animated background RAF — ocean + slow panning camera ────────────────
    this._menuRafRunning = true;
    this.clock.start();

    // Place camera at a cinematic angle looking across the ocean at an island
    const firstIsland = this._islands?.[0];
    const ix = firstIsland ? firstIsland.position.x : 80;
    const iz = firstIsland ? firstIsland.position.z : 80;
    this.camera.position.set(ix - 80, 28, iz + 60);
    this.camera.lookAt(ix, 4, iz);

    this._menuCamAngle = 0;
    this._menuCamRadius = 90;
    this._menuCamCenter = new THREE.Vector3(ix, 0, iz);

    const menuLoop = () => {
      if (!this._menuRafRunning) return;
      requestAnimationFrame(menuLoop);

      const delta = Math.min(this.clock.getDelta(), 0.1);
      this._menuCamAngle += delta * 0.08;   // very slow orbit

      const cx = this._menuCamCenter.x + Math.sin(this._menuCamAngle) * this._menuCamRadius;
      const cz = this._menuCamCenter.z + Math.cos(this._menuCamAngle) * this._menuCamRadius;
      this.camera.position.set(cx, 28 + Math.sin(this._menuCamAngle * 0.5) * 4, cz);
      this.camera.lookAt(this._menuCamCenter.x, 4, this._menuCamCenter.z);

      // Ocean + sky still update so waves move
      this.sky.update(delta);
      this.ocean.update(delta, this.sky.nightFraction);

      this.renderer.render(this.scene, this.camera);
    };
    menuLoop();

    // ── Wire up menu buttons ──────────────────────────────────────────────────

    // ── Story Mode button ──────────────────────────────────────────────────
    document.getElementById('mm-story')?.addEventListener('click', () => {
      // Check if there's an existing story save
      const savedRaw = localStorage.getItem('pe_story_progress');
      if (savedRaw) {
        try {
          const saved = JSON.parse(savedRaw);
          if (saved.act && saved.act !== 'act1' || (saved.kills ?? 0) > 0) {
            // Show resume modal
            this._showResumeModal(saved, menu);
            return;
          }
        } catch {}
      }
      // No save — start fresh
      this._launchStoryMode(menu, false);
    });

    // Solo Play button
    document.getElementById('mm-play')?.addEventListener('click', () => {
      this._menuRafRunning = false;
      menu.classList.add('hidden');
      document.getElementById('mm-version')?.remove();
      this.isCoop = false;
      this._storyMode = false;
      this._startGame();
    });

    const settingsPanel = document.getElementById('mm-settings-panel');
    const creditsPanel = document.getElementById('mm-credits-panel');
    const coopPanel = document.getElementById('mm-coop-panel');
    const leaderboardPanel = document.getElementById('mm-leaderboard-panel');

    // Co-op Mode button — opens lobby panel
    document.getElementById('mm-coop')?.addEventListener('click', () => {
      coopPanel?.classList.toggle('hidden');
      settingsPanel?.classList.add('hidden');
      creditsPanel?.classList.add('hidden');
      leaderboardPanel?.classList.add('hidden');
      this._initCoopLobby();
    });
    document.getElementById('mm-close-coop')?.addEventListener('click', () => {
      coopPanel?.classList.add('hidden');
    });

    // Settings panel toggle
    document.getElementById('mm-settings')?.addEventListener('click', () => {
      settingsPanel?.classList.toggle('hidden');
      creditsPanel?.classList.add('hidden');
      coopPanel?.classList.add('hidden');
      leaderboardPanel?.classList.add('hidden');
    });
    document.getElementById('mm-close-settings')?.addEventListener('click', () => {
      settingsPanel?.classList.add('hidden');
    });

    // Credits panel toggle
    document.getElementById('mm-credits')?.addEventListener('click', () => {
      creditsPanel?.classList.toggle('hidden');
      settingsPanel?.classList.add('hidden');
      coopPanel?.classList.add('hidden');
      leaderboardPanel?.classList.add('hidden');
    });
    document.getElementById('mm-close-credits')?.addEventListener('click', () => {
      creditsPanel?.classList.add('hidden');
    });

    // Leaderboard panel toggle
    document.getElementById('mm-leaderboard')?.addEventListener('click', () => {
      leaderboardPanel?.classList.toggle('hidden');
      settingsPanel?.classList.add('hidden');
      creditsPanel?.classList.add('hidden');
      coopPanel?.classList.add('hidden');
      if (leaderboardPanel && !leaderboardPanel.classList.contains('hidden')) {
        this._showLeaderboard();
      }
    });
    document.getElementById('mm-close-leaderboard')?.addEventListener('click', () => {
      leaderboardPanel?.classList.add('hidden');
    });

    // Live-update slider values and drive AudioSystem volumes
    ['master', 'music', 'sfx'].forEach(id => {
      const slider = document.getElementById(`s-${id}`);
      const label  = document.getElementById(`sv-${id}`);
      if (slider && label) {
        slider.addEventListener('input', () => {
          label.textContent = slider.value;
          // Sync audio volumes whenever master or sfx slider moves
          if (this.audio) {
            const m = (document.getElementById('s-master')?.value ?? 80) / 100;
            const s = (document.getElementById('s-sfx')?.value    ?? 80) / 100;
            this.audio.setVolumes(m, s);
          }
        });
      }
    });
  }

  // ── Co-op Lobby ─────────────────────────────────────────────────────────

  _initCoopLobby() {
    // Prevent double init
    if (this._coopLobbyInited) return;
    this._coopLobbyInited = true;

    // Tab switching
    document.getElementById('coop-tab-host')?.addEventListener('click', () => {
      document.getElementById('coop-pane-host')?.classList.remove('hidden');
      document.getElementById('coop-pane-join')?.classList.add('hidden');
      document.getElementById('coop-tab-host')?.classList.add('active');
      document.getElementById('coop-tab-join')?.classList.remove('active');
    });
    document.getElementById('coop-tab-join')?.addEventListener('click', () => {
      document.getElementById('coop-pane-join')?.classList.remove('hidden');
      document.getElementById('coop-pane-host')?.classList.add('hidden');
      document.getElementById('coop-tab-join')?.classList.add('active');
      document.getElementById('coop-tab-host')?.classList.remove('active');
    });

    // Auto-start host lobby
    this._startCoopHost();

    // Wire join button
    document.getElementById('coop-join-btn')?.addEventListener('click', () => {
      const code = document.getElementById('coop-join-input')?.value?.trim().toUpperCase();
      if (code?.length !== 6) {
        const statusEl = document.getElementById('coop-join-status');
        if (statusEl) { statusEl.textContent = '⚠️ Enter a valid 6-character code'; statusEl.className = 'coop-status error'; }
        return;
      }
      this._startCoopClient(code);
    });

    // Wire "Set Sail" button (host)
    document.getElementById('coop-host-start')?.addEventListener('click', () => {
      this._launchCoopGame();
    });
  }

  async _startCoopHost() {
    const statusEl  = document.getElementById('coop-host-status');
    const codeEl    = document.getElementById('coop-room-code');
    const startBtn  = document.getElementById('coop-host-start');
    const waitingEl = document.getElementById('coop-waiting-indicator');

    try {
      this.mp = new MultiplayerSystem('HOST');
      const code = await this.mp.init((msg) => {
        if (statusEl) statusEl.textContent = msg;
      });
      if (codeEl) codeEl.textContent = code;
      if (statusEl) statusEl.textContent = '✅ Relay connected — share the code above';

      // Click code to copy
      codeEl?.addEventListener('click', () => {
        navigator.clipboard?.writeText(code).then(() => {
          if (statusEl) statusEl.textContent = '📋 Code copied to clipboard!';
          setTimeout(() => { if (statusEl) statusEl.textContent = '✅ Share this code with your first mate'; }, 2000);
        });
      });

      // Wait for partner to connect
      this.mp.onConnected = () => {
        if (waitingEl) waitingEl.style.display = 'none';
        if (startBtn)  startBtn.style.display   = '';
        if (statusEl)  statusEl.textContent     = '🤝 First mate connected! Ready to sail!';
        if (statusEl)  statusEl.className       = 'coop-status success';
      };
    } catch (err) {
      if (statusEl) { statusEl.textContent = `❌ Connection failed: ${err.message}`; statusEl.className = 'coop-status error'; }
      console.error('[MP] Host init failed:', err);
    }
  }

  async _startCoopClient(code) {
    const statusEl = document.getElementById('coop-join-status');
    const joinBtn  = document.getElementById('coop-join-btn');
    if (joinBtn) joinBtn.disabled = true;
    if (statusEl) statusEl.textContent = '🔗 Connecting...';

    try {
      this.mp = new MultiplayerSystem('CLIENT', code);
      
      this.mp.onConnected = () => {
        if (statusEl) { statusEl.textContent = '✅ Connected to Captain! Loading seas...'; statusEl.className = 'coop-status success'; }
        // Auto-launch after brief delay
        setTimeout(() => this._launchCoopGame(), 1200);
      };

      await this.mp.init((msg) => {
        if (statusEl) {
          statusEl.textContent = msg;
          // Style success / error messages
          if (msg.startsWith('✅') || msg.startsWith('🤝')) statusEl.className = 'coop-status success';
          else if (msg.startsWith('❌')) statusEl.className = 'coop-status error';
          else statusEl.className = 'coop-status';
        }
      });
    } catch (err) {
      if (statusEl) { statusEl.textContent = `❌ Failed: ${err?.message ?? 'Invalid code or host offline'}`; statusEl.className = 'coop-status error'; }
      if (joinBtn) joinBtn.disabled = false;
    }
  }

  _launchCoopGame() {
    const menu = document.getElementById('main-menu');
    this._menuRafRunning = false;
    menu?.classList.add('hidden');
    document.getElementById('mm-version')?.remove();
    this.isCoop = true;
    this._startGame();
    this._initCoopInGame();
  }

  _initCoopInGame() {
    // Show co-op HUD elements
    document.getElementById('coop-partner-hud')?.classList.remove('hidden');
    document.getElementById('coop-flare-btn')?.classList.remove('hidden');
    document.getElementById('world-log-ticker')?.classList.remove('hidden');
    document.getElementById('coop-hint-extra').style.display = '';

    // Spawn partner ghost ship
    this._partnerShip = this.ships.createShip(
      'PIRATE_SMALL', 'PLAYER', 80, 0
    );
    // Tint partner ship blue to distinguish
    this._partnerShip.group.traverse(child => {
      if (child.isMesh && child.material) {
        child.material = child.material.clone();
        child.material.color?.setHex(0x4080ff);
      }
    });
    this._partnerShip._isPartnerGhost = true;

    // Build quick-chat radial
    const grid = document.getElementById('qc-grid');
    if (grid) {
      QUICK_CHAT.forEach(msg => {
        const btn = document.createElement('button');
        btn.className = 'qc-btn';
        btn.innerHTML = `${msg.icon} ${msg.text}`;
        btn.addEventListener('click', () => {
          this.mp?.sendQuickChat(msg.id);
          document.getElementById('quick-chat-radial')?.classList.add('hidden');
          this._showQuickChatPopup(`🤝 You: ${msg.icon} ${msg.text}`);
        });
        grid.appendChild(btn);
      });
    }

    // Flare button
    document.getElementById('coop-flare-btn')?.addEventListener('click', () => {
      const pos = this.playerShip?.group.position;
      if (pos) { this.mp?.sendFlare(pos.x, pos.z); }
      this.hud?.toast('🚨 Distress flare fired!', 'danger');
    });

    // Wire MP events
    this.mp.onPartnerShipState = (state) => {
      if (this._partnerShip) {
        this._partnerShip.group.position.set(state.x, state.y, state.z);
        this._partnerShip.group.rotation.y = state.ry;
        this._partnerShip.velocity?.set(state.vx, state.vy, state.vz);
        this._partnerShip.health    = state.hp;
        this._partnerShip.maxHealth = state.mhp;
      }
    };

    this.mp.onQuickChat = (data) => {
      const msg = QUICK_CHAT.find(m => m.id === data.id);
      if (msg) {
        this.hud?.toast(`🏴‍☠️ First Mate: ${msg.icon} ${msg.text}`, 'success');
        this._showQuickChatPopup(`🏴‍☠️ First Mate: ${msg.icon} ${msg.text}`);
      }
    };

    this.mp.onFlare = (data) => {
      this.hud?.toast('🚨 YOUR FIRST MATE FIRED A FLARE!', 'danger');
      this._showWorldLog(`🚨 First Mate fired a distress flare!`);
    };

    this.mp.onRescueRequest = (data) => {
      const overlay = document.getElementById('coop-rescue-overlay');
      overlay?.classList.remove('hidden');
      this._partnerRescueTimer = data.timer ?? 60;
    };

    this.mp.onRescueResolve = (data) => {
      document.getElementById('coop-rescue-overlay')?.classList.add('hidden');
      if (data.ok) {
        this.hud?.toast('⚓ First Mate rescued!', 'success');
      } else {
        this.hud?.toast('💀 First Mate was lost...', 'danger');
      }
    };

    this.mp.onWorldEvent = (data) => {
      this._showWorldLog(data.text);
    };

    this.mp.onDisconnected = () => {
      const onlineEl = document.getElementById('coop-partner-online');
      if (onlineEl) { onlineEl.textContent = '● Offline'; onlineEl.classList.add('offline'); }
      this.hud?.toast('⚠️ First mate disconnected!', 'danger');
    };
  }

  _showWorldLog(text) {
    const ticker  = document.getElementById('world-log-ticker');
    const textEl  = document.getElementById('world-log-text');
    if (!ticker || !textEl) return;
    textEl.textContent = text;
    ticker.classList.remove('hidden');
    // Auto-hide after 6 seconds
    clearTimeout(this._worldLogTimeout);
    this._worldLogTimeout = setTimeout(() => {
      ticker.classList.add('hidden');
    }, 6000);
  }

  _showQuickChatPopup(text) {
    document.querySelectorAll('.qc-message-popup').forEach(el => el.remove());
    const popup = document.createElement('div');
    popup.className = 'qc-message-popup';
    popup.textContent = text;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 3000);
  }

  // ── Game Loop ─────────────────────────────────────────────────────────────

  start() {
    this._running = true;
    this.clock.start();
    this._raf();
  }

  _raf() {
    if (!this._running) return;
    requestAnimationFrame(() => this._raf());

    const delta = Math.min(this.clock.getDelta(), 0.1); // cap at 100ms

    // Real-time FPS calculation updated every 0.5s
    this._fpsTimer = (this._fpsTimer || 0) + delta;
    this._fpsFrameCount = (this._fpsFrameCount || 0) + 1;
    if (this._fpsTimer >= 0.5) {
      const fps = Math.round(this._fpsFrameCount / this._fpsTimer);
      const fpsEl = document.getElementById('fps-counter');
      if (fpsEl) {
        fpsEl.textContent = `FPS: ${fps}`;
        // Color code based on performance
        if (fps >= 55) fpsEl.style.color = '#00ff66';      // green
        else if (fps >= 30) fpsEl.style.color = '#f0c040'; // amber
        else fpsEl.style.color = '#ff3838';               // red
      }
      this._fpsTimer = 0;
      this._fpsFrameCount = 0;
    }

    this._update(delta);
    this.renderer.render(this.scene, this.camera);
  }

  _update(delta) {
    // ── Pause toggle ──────────────────────────────────────────────────────────
    if (this.input?.justPressed('Escape')) this._togglePause();
    if (this._paused) { this.input.update(); return; }

    // ── Game timer ────────────────────────────────────────────────────────────
    if (!this._isGameOver) this._gameTimer += delta;

    // ── Boarding cooldown ─────────────────────────────────────────────────────
    this._boardingCooldown = Math.max(0, this._boardingCooldown - delta);

    // ── Drive player ship from input ────────────────────────────────────────
    this._handlePlayerInput(delta);

    // ── Sky / shadows follow player ─────────────────────────────────────────
    this.sky.update(delta);

    // ── Ocean animation ──────────────────────────────────────────────────────
    this.ocean.update(delta, this.sky.nightFraction);

    // ── Weather / storm system ────────────────────────────────────────────────
    this._stormTimer -= delta;
    if (!this._stormActive && this._stormTimer <= 0) {
      this._stormActive   = true;
      this._stormDuration = 30 + Math.random() * 30;
      this._stormTimer    = 90 + Math.random() * 90;
      this.hud.toast('🌩️ A storm is brewing!', 'danger');
    }
    if (this._stormActive) {
      this._stormDuration -= delta;
      const stormFrac = Math.max(0, Math.min(1, 1 - this._stormDuration / 60));
      this.sky.setStormIntensity(1 - stormFrac);
      if (this.scene?.fog) this.scene.fog.density = 0.0012 + (1 - stormFrac) * 0.004;
      if (this._stormDuration <= 0) {
        this._stormActive = false;
        this.sky.setStormIntensity(0);
        if (this.scene?.fog) this.scene.fog.density = 0.0012;
        this.hud.toast('☀️ The storm has passed.', 'success');
      }
    }

    // ── Wind Direction Shifting ──────────────────────────────────────────────
    this.windTimer -= delta;
    if (this.windTimer <= 0) {
      this.windTimer = 120 + Math.random() * 120;
      this._targetWindAngle = Math.random() * Math.PI * 2;
    }
    if (this._targetWindAngle !== undefined) {
      let diff = ((this._targetWindAngle - this.windAngle) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      this.windAngle += Math.sign(diff) * Math.min(Math.abs(diff), 0.1 * delta);
    }

    // ── Update HUD wind ──────────────────────────────────────────────────────
    if (this.playerShip && this.hud) {
      this.hud.updateWind?.(this.windAngle, this.playerShip.group.rotation.y);
    }

    // ── Ships (movement + sinking) ───────────────────────────────────────────
    this.ships.update(delta, this.windAngle, this.windStrength);

    // ── Wake trails ─────────────────────────────────────────────────────────
    for (const ship of this.ships.alive) {
      this.wake.notifyShip(ship, delta);
    }
    this.wake.update(delta);

    // ── Combat (cannonballs + smoke) ─────────────────────────────────────────
    this.combat.update(delta);
    if (this.playerShip) {
      const isAiming = this.input.isDown('Mouse0');
      this.combat.updateAimingLines(this.playerShip, isAiming);
    }

    // ── Cannon reload arc ────────────────────────────────────────────────────
    const reloadArc = document.getElementById('reload-arc');
    if (reloadArc && this.playerShip) {
      const frac = 1 - Math.min(1, (this.playerShip.cannonCooldown ?? 0) / GameConfig.CANNON_FIRE_COOLDOWN);
      reloadArc.style.strokeDashoffset = (100.5 * (1 - frac)).toFixed(1);
      const reloadIcon = document.getElementById('reload-icon');
      if (reloadIcon) reloadIcon.textContent = frac >= 1 ? '💣' : '⏳';
    }

    // ── AI enemies ───────────────────────────────────────────────────────────
    if (this.playerShip?.isAlive) {
      this.ai.update(delta, this.playerShip.group.position);
    }

    // ── Island capture + passive income ──────────────────────────────────────
    if (this.playerShip?.isAlive) {
      this.islandSys.update(delta, this.playerShip.group.position);
    }
    // ── Island healing ──────────────────────────────────────────────────────────────
    if (this.playerShip?.isAlive) {
      const HEAL_RATE    = 8;    // HP per second
      const HEAL_RANGE   = 35;   // world units
      const WOOD_PER_SEC = 1.5;  // wood cost per second of healing
      const ship = this.playerShip;
      let nearIsland = false;
      if (ship.health < ship.maxHealth) {
        for (const island of this._islands) {
          if (!island.captured || island.owner !== 'PLAYER') continue;
          const dx = island.position.x - ship.group.position.x;
          const dz = island.position.z - ship.group.position.z;
          if (dx * dx + dz * dz < HEAL_RANGE * HEAL_RANGE) {
            // Wood cost check — stop healing if resources insufficient
            const woodCost = WOOD_PER_SEC * delta;
            if (this.economy.resources.wood < woodCost) break;
            this.economy.spend({ wood: Math.max(1, Math.round(woodCost)) });

            nearIsland = true;
            ship.heal(HEAL_RATE * delta);
            // Show floating heal number every ~0.8 s
            this._healDisplayTimer -= delta;
            if (this._healDisplayTimer <= 0) {
              this._healDisplayTimer = 0.8;
              this.hud.spawnDamageNumber(
                Math.round(HEAL_RATE * 0.8),
                ship.group.position.clone(),
                'heal',
              );
            }
            break;
          }
        }
      }
      // Show / hide heal prompt
      if (nearIsland && !this._healingAtIsland) {
        this._healingAtIsland = true;
        this.hud.toast('❤️ Healing at island… (costs 🪵 wood)', 'success');
      } else if (!nearIsland) {
        this._healingAtIsland = false;
        this._healDisplayTimer = 0;
      }
    }
    // ── Ally ships ───────────────────────────────────────────────────────────
    this._updateAllyShips(delta);

    // ── Camera ───────────────────────────────────────────────────────────────
    this.cameraSystem.update(delta);

    // ── HUD update ────────────────────────────────────────────────────────────
    this.hud.updateShipInfo(
      this.playerShip,
      this.ships.all.filter(s => s.faction === Faction.PLAYER && s.isAlive).length,
      this.islandSys.capturedCount,
    );

    // ── Boss bar ──────────────────────────────────────────────────────────────
    const bossShip = this.ships.all.find(s => 
      (s.faction === Faction.PIRATE_HUNTER || s.group?.name === "Silas Veynar's Dread") && s.isAlive
    );
    if (bossShip && !this._bossAnnounced) {
      this._bossAnnounced = true;
      if (bossShip.group?.name === "Silas Veynar's Dread") {
        this.hud.toast('☠️ ADMIRAL SILAS VEYNAR HAS ARRIVED!', 'danger');
      } else {
        this.hud.toast('☠️ THE PIRATE HUNTER HAS ARRIVED! FLEE OR FIGHT!', 'danger');
      }
    } else if (!bossShip) {
      this._bossAnnounced = false;
    }
    const bossBarEl = document.getElementById('boss-bar');
    if (bossBarEl) {
      bossBarEl.classList.toggle('hidden', !bossShip);
      if (bossShip) {
        const labelEl = bossBarEl.querySelector('.boss-bar-label');
        if (labelEl) {
          if (bossShip.group?.name === "Silas Veynar's Dread") {
            labelEl.textContent = "💀 ADMIRAL SILAS VEYNAR — LORD OF THE BLACK FLEET";
            bossBarEl.classList.add('veynar-boss');
          } else {
            labelEl.textContent = "💀 PIRATE HUNTER";
            bossBarEl.classList.remove('veynar-boss');
          }
        }
        const fill = document.getElementById('boss-bar-fill');
        if (fill) fill.style.width = `${(bossShip.health / bossShip.maxHealth) * 100}%`;
      }
    }

    // ── Island HP bars ────────────────────────────────────────────────────────
    this.hud.updateIslandHPBars(this._islands);

    // ── Minimap ────────────────────────────────────────────────────────────
    this.minimap.update(delta, this.playerShip?.group.position ?? null, this._treasureMarks ?? []);

    // ── Treasure mark proximity ───────────────────────────────────────────────
    if (this.playerShip?.isAlive && this._treasureMarks) {
      for (const mark of this._treasureMarks) {
        if (mark.found) continue;
        const dx = mark.x - this.playerShip.group.position.x;
        const dz = mark.z - this.playerShip.group.position.z;
        if (dx * dx + dz * dz < 15 * 15) {
          mark.found = true;
          this._treasuresFound++;
          const bonus = 150 + Math.floor(Math.random() * 150);
          this.economy.add('gold', bonus);
          this.hud.toast(`🗺️ You found the treasure! +${bonus} gold!`, 'success');
        }
      }
    }

    // ── Birds + floating loot ────────────────────────────────────────────────
    this.birds.update(delta);
    if (this.playerShip?.isAlive) {
      this.loot.update(delta, this.playerShip.group.position);
    }

    // ── Perk system (orb pickup + passive ticks) ──────────────────────────────
    if (this.playerShip?.isAlive) {
      this.perks.update(delta);
    }

    // ── World Event System (living ocean simulation) ──────────────────────────
    if (this.worldEvents) {
      this.worldEvents.update(delta, this.playerShip?.group.position ?? null);
    }

    // ── Story Mode System (cinematic beats + dialogue) ────────────────────────
    if (this.story && this._storyMode) {
      this.story.update(delta);

      // J — Captain's Journal toggle
      if (this.input.justPressed('KeyJ')) {
        this._toggleJournal();
      }

      // Brotherhood ally spawning based on reputation
      this._brotherhoodSpawnTimer = (this._brotherhoodSpawnTimer || 60) - delta;
      if (this._brotherhoodSpawnTimer <= 0) {
        this._brotherhoodSpawnTimer = 90;
        const activeAllies = this._allyShips.filter(s => s.isAlive).length;
        const rep = this.story.getFactionReputation('BROTHERHOOD');
        if (activeAllies === 0 && rep >= 300 && this.playerShip?.isAlive) {
          const pos = this.playerShip.group.position;
          const x = pos.x + (Math.random() - 0.5) * 60;
          const z = pos.z + (Math.random() - 0.5) * 60;
          const ally = this.ships.createShip('PIRATE_SMALL', Faction.PLAYER, x, z);
          ally.group.name = "Brotherhood Reinforcement";
          this._allyShips.push(ally);
          this.hud?.toast('🏴‍☠️ Brotherhood allies have arrived to help!', 'success');
        }
      }

      // Waypoint compass — rotate arrow toward active waypoint
      if (this._activeWaypoint && this.playerShip?.group) {
        const pp = this.playerShip.group.position;
        const wp = this._activeWaypoint;
        const dx = wp.x - pp.x;
        const dz = wp.z - pp.z;
        const dist = Math.hypot(dx, dz);
        const distEl = document.getElementById('waypoint-dist');
        if (distEl) distEl.textContent = `${Math.round(dist)} m`;

        // Rotate arrow relative to camera heading
        const playerAngle = this.playerShip.group.rotation.y;
        const angleToWp   = Math.atan2(dx, dz);
        const relAngle    = (angleToWp - playerAngle) * (180 / Math.PI);
        const arrowEl     = document.getElementById('waypoint-arrow');
        if (arrowEl) arrowEl.style.transform = `rotate(${relAngle}deg)`;

        // Hide waypoint compass if within 50 units (arrived)
        if (dist < 50) {
          document.getElementById('story-waypoint-compass')?.classList.add('hidden');
          this._activeWaypoint = null;
        }
      }
    }

    // ── World hazards (bobbing wrecks / boats) ───────────────────────────────
    this.hazards?.update(delta);

    // ── Rock collision — damages + repels the player ship ────────────────────
    if (this.playerShip?.isSailing && this.hazards) {
      for (const h of this.hazards.getHazards()) {
        if (h.type !== 'rock') continue;
        const dx = h.mesh.position.x - this.playerShip.group.position.x;
        const dz = h.mesh.position.z - this.playerShip.group.position.z;
        if (dx * dx + dz * dz < h.collisionRadius * h.collisionRadius) {
          this.playerShip.takeDamage(15);
          const dir = new THREE.Vector3(-dx, 0, -dz).normalize();
          this.playerShip.velocity.addScaledVector(dir, 8);
          this.hud.toast('💥 Hit a rock!', 'danger');
        }
      }
    }

    // ── Audio (creak timer + wind dynamics) ──────────────────────────────────
    this.audio?.update(delta);

    // ── Co-op per-frame ───────────────────────────────────────────────────────
    if (this.isCoop && this.mp) {
      // Tick the MP system (sends ship state, world snapshots, rescue timer)
      this.mp.update(
        delta,
        this.playerShip,
        this.mp.isHost ? this.economy   : null,
        this.mp.isHost ? this._islands  : null,
      );

      // Update partner HUD
      const ps = this.mp.partnerState;
      if (ps) {
        const hpFrac  = ps.mhp > 0 ? ps.hp / ps.mhp : 0;
        const fillEl  = document.getElementById('coop-partner-hp-fill');
        const textEl  = document.getElementById('coop-partner-hp-text');
        const distEl  = document.getElementById('coop-partner-dist');
        if (fillEl) {
          fillEl.style.width = `${(hpFrac * 100).toFixed(0)}%`;
          fillEl.className = 'coop-partner-hp-fill' +
            (hpFrac > 0.5 ? '' : hpFrac > 0.25 ? ' medium' : ' low');
        }
        if (textEl) textEl.textContent = `${ps.hp}/${ps.mhp}`;
        if (distEl && this.playerShip) {
          const dx = ps.x - this.playerShip.group.position.x;
          const dz = ps.z - this.playerShip.group.position.z;
          const d  = Math.round(Math.sqrt(dx * dx + dz * dz));
          distEl.textContent = `⚓ ${d}u away`;
        }
      }

      // Rescue timer overlay countdown
      if (this.mp._rescueActive) {
        const t = Math.max(0, Math.ceil(this.mp._rescueTimer));
        const timerEl = document.getElementById('rescue-timer-text');
        const barEl   = document.getElementById('rescue-bar-fill');
        if (timerEl) timerEl.textContent = t;
        if (barEl)   barEl.style.width   = `${(t / 60) * 100}%`;
      }

      // G — Map ping
      if (this.input.justPressed('KeyG') && this.playerShip) {
        const pos = this.playerShip.group.position;
        this.mp.sendPingMap('waypoint', pos.x, pos.z);
        const ind = document.getElementById('mp-ping-indicator');
        const txt = document.getElementById('mp-ping-text');
        if (ind && txt) {
          txt.textContent = '📍 You pinged the map!';
          ind.classList.remove('hidden');
          setTimeout(() => ind.classList.add('hidden'), 3000);
        }
      }

      // F — Distress flare
      if (this.input.justPressed('KeyF') && this.playerShip) {
        const pos = this.playerShip.group.position;
        this.mp.sendFlare(pos.x, pos.z);
        this.hud?.toast('🚨 Distress flare fired!', 'danger');
      }

      // Z — Quick-chat radial toggle
      if (this.input.justPressed('KeyZ')) {
        const radial = document.getElementById('quick-chat-radial');
        radial?.classList.toggle('hidden');
      }

      // Show partner ping notification when received
      EventEmitter.once?.('mp:ping', (data) => {
        const ind = document.getElementById('mp-ping-indicator');
        const txt = document.getElementById('mp-ping-text');
        if (ind && txt) {
          txt.textContent = `📍 First Mate pinged the map!`;
          ind.classList.remove('hidden');
          setTimeout(() => ind.classList.add('hidden'), 3000);
        }
      });
    }

    // ── Input: clear per-frame state ─────────────────────────────────────────
    this.input.update();
  }


  // ── World Debris ─────────────────────────────────────────────────────────

  _scatterDebris() {
    const half   = GameConfig.WORLD_SIZE / 2 - 80;
    const items  = ['barrel', 'crate', 'rocks-a', 'rocks-b', 'rocks-sand-a'];
    const count  = 35;

    for (let i = 0; i < count; i++) {
      const key  = items[Math.floor(Math.random() * items.length)];
      const mesh = AssetLoader.get(key);

      const x = (Math.random() * 2 - 1) * half;
      const z = (Math.random() * 2 - 1) * half;

      // Keep away from spawn and islands
      const tooClose = this._islands.some(isl => {
        const dx = isl.position.x - x;
        const dz = isl.position.z - z;
        return dx * dx + dz * dz < 60 * 60;
      });
      if (tooClose || (x * x + z * z < 80 * 80)) { i--; continue; }

      mesh.position.set(x, 0.5, z);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      mesh.scale.setScalar(0.6 + Math.random() * 0.6);
      this.scene.add(mesh);
    }
  }

  // ── Player Input Handler ──────────────────────────────────────────────────

  _handlePlayerInput(delta) {
    const ship = this.playerShip;
    if (!ship || !ship.isSailing) return;
    // Disable all controls after game over
    if (this._isGameOver) {
      ship.thrust   = 0;
      ship.steering = 0;
      return;
    }

    const inp = this.input;

    // Throttle / thrust
    if (inp.isDown('KeyW')) {
      ship.thrust = 1;
    } else if (inp.isDown('KeyS')) {
      ship.thrust = -0.4;
    } else {
      ship.thrust = 0;
    }

    // Steering
    if (inp.isDown('KeyA')) {
      ship.steering = -1;
    } else if (inp.isDown('KeyD')) {
      ship.steering = 1;
    } else {
      ship.steering = 0;
    }

    // Anchor / Drift
    if (inp.isDown('KeyQ')) {
      const speed = ship.velocity.length();
      if (speed > 3.0) {
        ship.isDrifting = true;
      } else {
        // Slow speed -> hard stop anchor brake
        ship.isDrifting = false;
        ship.velocity.multiplyScalar(0.08);
        ship.angularVelocity = 0;
        ship.thrust   = 0;
        ship.steering = 0;
      }
    } else {
      ship.isDrifting = false;
    }

    // Fire cannons
    if (inp.justPressed('Space') || inp.justReleased('Mouse0')) {
      this.combat.fireCannons(ship);
    }

    // ── Ammo selection (1=Round, 2=Chain, 3=Fire) ─────────────────────────────
    if (inp.justPressed('Digit1')) {
      this.combat.setAmmo('ROUND');
      this.hud.toast('💣 Round Shot', '');
    } else if (inp.justPressed('Digit2')) {
      this.combat.setAmmo('CHAIN');
      this.hud.toast('⛓ Chain Shot — slows enemies!', '');
    } else if (inp.justPressed('Digit3')) {
      this.combat.setAmmo('FIRE');
      this.hud.toast('🔥 Fire Shot — burns over time!', '');
    }

    // ── Board enemy ship (B key) ─────────────────────────────────────────────
    if (inp.justPressed('KeyB')) {
      if (this._boardingCooldown > 0) {
        this.hud.toast(`⚓ Boarding on cooldown (${this._boardingCooldown.toFixed(0)}s)`, 'warning');
      } else {
        const enemies = this.ships.enemies;
        let target = null, minD = 9999;
        for (const e of enemies) {
          if (!e.isAlive) continue;
          const d = ship.group.position.distanceTo(e.group.position);
          if (d < 18 && d < minD) { minD = d; target = e; }
        }
        if (!target) {
          this.hud.toast('⚓ No ship close enough to board!', 'warning');
        } else {
          this._boardingCooldown = 8;
          if (Math.random() < 0.4) {
            target.faction = Faction.PLAYER;
            this._allyShips.push(target);
            this.hud.toast('🏴‍☠️ Ship boarded and captured!', 'success');
          } else {
            const loot = 50 + Math.floor(Math.random() * 80);
            this.economy.add('gold', loot);
            this.hud.toast(`⚔️ Boarded! Seized ${loot} gold!`, 'success');
          }
        }
      }
    }

    // ── Repair at island (R key) ─────────────────────────────────────────────
    if (inp.justPressed('KeyR')) {
      const REPAIR_COST = 500;
      const nearIsland = this._islands.some(isl => {
        if (!isl.captured || isl.owner !== 'PLAYER') return false;
        const dx = isl.position.x - ship.group.position.x;
        const dz = isl.position.z - ship.group.position.z;
        return dx * dx + dz * dz < 35 * 35;
      });
      if (!nearIsland) {
        this.hud.toast('⚓ Sail to your island to repair!', 'warning');
      } else if (!this.economy.spend({ gold: REPAIR_COST })) {
        this.hud.toast(`💸 Need ${REPAIR_COST} gold to repair!`, 'danger');
      } else {
        ship.health = ship.maxHealth;
        this.hud.toast('🔧 Hull fully repaired!', 'success');
      }
    }
  }
}

// ── Damage number visualisation — done once ────────────────────────────────
// We hook this here so it has access to the game instance after construction.
async function bootstrap() {
  const game = new Game();
  await game.init();

  // Connect hit events to floating damage numbers
  EventEmitter.on('ship:hit', ({ ship, damage }) => {
    if (!game.hud) return;
    const type = ship.faction === Faction.PLAYER ? 'player' : 'enemy';
    game.hud.spawnDamageNumber(
      Math.round(damage),
      ship.group.position.clone(),
      type,
    );
  });

  // Track kills and boss defeated
  EventEmitter.on('ship:destroyed', ({ ship }) => {
    if (ship.faction !== Faction.PLAYER) {
      game._killCount++;
      if (ship.faction === Faction.PIRATE_HUNTER) {
        game._bossDefeated = true;
      }
    }
  });

  // Player ship destroyed — trigger cinematic + explosion
  EventEmitter.on('ship:destroyed', ({ ship }) => {
    if (ship.faction === Faction.PLAYER) {
      game._onPlayerDestroyed();
    }
  });

  // Pause AI when player is gone
  EventEmitter.on('ship:sunk', ({ ship }) => {
    if (ship.faction === Faction.PLAYER) {
      // AI stops chasing (no target remaining)
      game._isGameOver = true;
    }
  });

  // Victory event
  EventEmitter.on('game:victory', () => game._showVictory());

  // Attach game to window for debugging
  window.__game = game;
}

bootstrap().catch(err => {
  console.error('[Game] Fatal error during bootstrap:', err);
  const loadingTxt = document.getElementById('loading-text');
  if (loadingTxt) loadingTxt.textContent = `Error: ${err.message}`;
});
