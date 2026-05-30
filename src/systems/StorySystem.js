/**
 * StorySystem — Cinematic Story Mode State Machine
 *
 * Pirate Empire: Rise of the Black Fleet
 *
 * Manages:
 *  - Story Acts (1 → Final)
 *  - Mission objectives and triggers
 *  - Faction reputation (7 factions)
 *  - Story NPC ship spawning (Veynar, Old Cass, Holt)
 *  - Cinematic world events (Blood Moon, Ghost Invasion, Veynar Sighting)
 *  - Act title banners
 *  - Dynamic {PLAYER_NAME} dialogues
 *  - Co-op partner name support
 *  - localStorage persistence
 */

import * as THREE from 'three';
import EventEmitter from '../utils/EventEmitter.js';
import { Faction, ShipClass } from '../config/ShipConfig.js';

// ── Faction IDs ───────────────────────────────────────────────────────────────
export const STORY_FACTION = {
  ROYAL_NAVY:       'ROYAL_NAVY',
  BROTHERHOOD:      'BROTHERHOOD',
  GHOST_FLEET:      'GHOST_FLEET',
  MERCHANTS:        'MERCHANTS',
  BLACK_TIDE:       'BLACK_TIDE',
  HUNTERS:          'HUNTERS',
  CULT:             'CULT',
};

// ── Reputation tiers ──────────────────────────────────────────────────────────
const REP_TIERS = [
  { threshold: 0,    title: 'Unknown Sailor',       color: '#888' },
  { threshold: 100,  title: 'Troublemaker',          color: '#aa8833' },
  { threshold: 300,  title: 'Infamous Raider',       color: '#cc6622' },
  { threshold: 600,  title: 'Feared Captain',        color: '#dd3333' },
  { threshold: 1000, title: 'Legendary Privateer',   color: '#cc44ff' },
  { threshold: 2000, title: 'Dread of the Seas',     color: '#ff2200' },
  { threshold: 4000, title: '☠️ THE PIRATE LEGEND',  color: '#f0c040' },
];

// ── Story Acts ────────────────────────────────────────────────────────────────
const ACTS = [
  {
    id: 'act1',
    number: 1,
    title: 'ACT I',
    subtitle: 'BLOOD ON THE TIDE',
    color: '#c8a415',
  },
  {
    id: 'act2',
    number: 2,
    title: 'ACT II',
    subtitle: 'STORM BEFORE THE DARKNESS',
    color: '#cc4422',
  },
  {
    id: 'act3',
    number: 3,
    title: 'ACT III',
    subtitle: 'THE RETURN OF THE DEAD',
    color: '#7722dd',
  },
  {
    id: 'final',
    number: 4,
    title: 'FINAL ACT',
    subtitle: 'THE HOLLOW DEEP',
    color: '#00d4aa',
  },
];

// ── Story Beats per Act ──────────────────────────────────────────────────────
// Each beat fires when its trigger condition is met.
// type: 'KILLS' | 'CAPTURES' | 'GOLD' | 'TIME' | 'EVENT' | 'MANUAL' | 'DISTANCE'
//
// objective: { text, type ('KILLS'|'CAPTURES'|'TIME'|'DISTANCE'|'AUTO'), max }
//   → used by the Mission Objective Bar to show progress
const STORY_BEATS = {
  act1: [
    {
      id: 'act1_intro',
      type: 'TIME',
      trigger: 5,   // 5 seconds after game start
      objective: { text: 'Set sail — explore the Shattered Seas', type: 'AUTO', max: 1 },
      dialogues: [
        {
          speaker: '📻 Unknown Signal',
          title: 'Source: Unknown',
          text: 'Any captain within range — I say again — the convoy at Deadrock Passage is under attack! We\'re taking fire from— [static] —please, if anyone—\n[TRANSMISSION LOST]',
          faction: 'merchant',
          duration: 8000,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Not bad for a nobody. Someone\'s crying out there, Captain {PLAYER_NAME}. The sea doesn\'t care. But we do. Shall we?',
          faction: 'pirate',
          duration: 7000,
        },
      ],
      actBanner: 'act1',
    },
    {
      id: 'act1_first_blood',
      type: 'KILLS',
      trigger: 3,
      objective: { text: 'Prove yourself — sink enemy ships', type: 'KILLS', max: 3 },
      dialogues: [
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Three ships down. The Brotherhood is watching, Captain {PLAYER_NAME}. They\'re starting to take notice. Don\'t let the sea stop ye now.',
          faction: 'pirate',
          duration: 6000,
        },
      ],
    },
    {
      id: 'act1_navy_notice',
      type: 'KILLS',
      trigger: 8,
      objective: { text: 'Make the Royal Navy take notice — sink 8 ships', type: 'KILLS', max: 8 },
      dialogues: [
        {
          speaker: 'Commodore Holt',
          title: 'Royal Navy — Eastern Fleet',
          text: 'Unidentified vessel — stand down IMMEDIATELY or I will have your hull reduced to splinters. You are attacking Empire property. This is your ONLY warning, {PLAYER_NAME}.',
          faction: 'navy',
          duration: 7000,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Ha! Holt himself. That means ye\'ve annoyed the Empire enough to matter. Well done, Captain {PLAYER_NAME}. Well done indeed.',
          faction: 'pirate',
          duration: 5500,
        },
      ],
    },
    {
      id: 'act1_ghost_water',
      type: 'TIME',
      trigger: 120,
      objective: { text: 'Survive the cursed waters — keep sailing', type: 'TIME', max: 120 },
      dialogues: [
        {
          speaker: '📻 Distorted Signal',
          title: 'Source: Unresolvable',
          text: '...turn... back... nothing...',
          faction: 'ghost',
          duration: 5000,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Ye feel that? The water\'s changed colour. Something is under those waves that shouldn\'t be. I\'ve heard stories, Captain {PLAYER_NAME}. Stories I don\'t like repeating.',
          faction: 'pirate',
          duration: 7000,
        },
        {
          speaker: '📜 Message in a Bottle',
          title: 'Recovered from wreck site',
          text: '"The fog didn\'t hide what came for us. It WAS what came for us. Don\'t follow the lights. Don\'t listen to the voices. Whatever you do — DON\'T—"\n[The note ends here.]',
          faction: 'neutral',
          duration: 8000,
        },
      ],
    },
    {
      id: 'act1_capture',
      type: 'CAPTURES',
      trigger: 1,
      objective: { text: 'Claim an island for your fleet', type: 'CAPTURES', max: 1 },
      dialogues: [
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'An island claimed. The Brotherhood sees ye now, Captain {PLAYER_NAME}. Word spreads fast on these seas. Make sure it\'s the right kind of word.',
          faction: 'pirate',
          duration: 6000,
        },
      ],
    },
  ],
  act2: [
    {
      id: 'act2_intro',
      type: 'KILLS',
      trigger: 15,
      objective: { text: 'Earn Brotherhood respect — sink 15 ships', type: 'KILLS', max: 15 },
      dialogues: [
        {
          speaker: 'Brotherhood Contact',
          title: 'Free Sails — High Council',
          text: 'Captain {PLAYER_NAME}. I\'ll be plain — this job gets most captains killed. But three of our best are in Navy irons, heading to Irongate Key. We need someone reckless enough to try a rescue.',
          faction: 'pirate',
          duration: 7500,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Don\'t look at me like that. I told ye — ye were always going to end up here, Captain {PLAYER_NAME}. The sea knew it before ye did.',
          faction: 'pirate',
          duration: 5500,
        },
      ],
      actBanner: 'act2',
    },
    {
      id: 'act2_mira',
      type: 'KILLS',
      trigger: 20,
      objective: { text: 'Track down Mira Salthook\'s intelligence — sink 20 ships', type: 'KILLS', max: 20 },
      dialogues: [
        {
          speaker: 'Mira Salthook',
          title: 'Concordat Cartographer',
          text: 'You found the Crimson Vow\'s coordinates. Nobody\'s found those in fifty years. I have marked the exact wreckage coordinates: (240, -180). We must sail there to search for the Concordat Charter, Captain!',
          faction: 'pirate',
          duration: 8000,
        },
      ],
      spawnEvent: 'spawn_act2_wreck',
      waypointEvent: { x: 240, z: -180, label: '🗺️ Crimson Vow Wreck Site' },
    },
    {
      id: 'act2_charter_found',
      type: 'DISTANCE',
      coordinates: { x: 240, z: -180 },
      triggerRange: 45,
      objective: { text: 'Sail to the Crimson Vow wreck site (240, -180)', type: 'DISTANCE', max: 1 },
      dialogues: [
        {
          speaker: 'Mira Salthook',
          title: 'Concordat Cartographer',
          text: 'We\'ve reached the coordinates! Diving crews are returning... they found it! The Concordat Charter is secure. But look out — Navy patrol is closing in on us!',
          faction: 'pirate',
          duration: 8000
        }
      ],
      spawnEvent: 'spawn_holt_ambush'
    },
    {
      id: 'act2_holt_ambush_beat',
      type: 'KILLS',
      trigger: 25,
      objective: { text: 'Fight through Holt\'s ambush — survive to 25 kills', type: 'KILLS', max: 25 },
      dialogues: [
        {
          speaker: 'Commodore Holt',
          title: 'Royal Navy — Eastern Fleet',
          text: 'Captain {PLAYER_NAME}. I have six guns aimed at your hull right now. Every exit from this cove is covered. Strike your colours. Or we do this the other way.',
          faction: 'navy',
          duration: 8000,
        },
        {
          speaker: 'Brotherhood Captain',
          title: 'Free Sails — Combat Fleet',
          text: 'Miss us, Captain {PLAYER_NAME}? Consider this paid in advance — for what you did at that convoy. Now GO. We\'ll keep these Navy dogs busy!',
          faction: 'pirate',
          duration: 6000,
        },
        {
          speaker: '📻 Brotherhood Radio',
          title: 'Brotherhood Ship — Iron Gallows',
          text: '...Brotherhood ship IRON GALLOWS going down — she\'s breaking apart — tell the captain we held the line! Tell {PLAYER_NAME} — we HELD—\n[SILENCE]',
          faction: 'pirate',
          duration: 8000,
        },
      ],
    },
    {
      id: 'act2_cass_betrayal',
      type: 'KILLS',
      trigger: 28,
      objective: { text: 'Confront Old Cass\'s secret — continue fighting', type: 'KILLS', max: 28 },
      dialogues: [
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'I gave Holt your patrol routes, {PLAYER_NAME}. I did. I\'m not going to make excuses.',
          faction: 'pirate',
          duration: 6000,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'But I want ye to know — every route I gave him was one I knew you\'d already changed. I gave him ghosts. Real information would have got ye killed. I\'m not asking for forgiveness. I\'m asking ye to believe me when I say — I never stopped bein\' on your side.',
          faction: 'pirate',
          duration: 9000,
        },
      ],
    },
  ],
  act3: [
    {
      id: 'act3_intro',
      type: 'KILLS',
      trigger: 35,
      objective: { text: 'Build your legend — sink 35 ships', type: 'KILLS', max: 35 },
      dialogues: [
        {
          speaker: '📻 Distorted Voices',
          title: 'Source: UNRESOLVABLE — DEEP SIGNAL',
          text: '…we tried… we couldn\'t… there were so many……the Admiral sees you, little captain……{PLAYER_NAME}… he knows your name…',
          faction: 'ghost',
          duration: 8000,
        },
        {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Black Fleet',
          text: 'Captain {PLAYER_NAME}. I know. It\'s overwhelming, isn\'t it? Seeing it all at once. I am going to give you a gift. I am going to let you leave. Not because you are weak — far from it. But because the Hollow Deep wants you to understand what is coming before you face me.',
          faction: 'veynar',
          duration: 10000,
        },
        {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Black Fleet',
          text: 'We will speak again. Soon.',
          faction: 'veynar',
          duration: 4000,
        },
      ],
      actBanner: 'act3',
    },
    {
      id: 'act3_ironrock',
      type: 'CAPTURES',
      trigger: 3,
      objective: { text: 'Storm the Empire\'s islands — capture 3', type: 'CAPTURES', max: 3 },
      dialogues: [
        {
          speaker: 'Brotherhood War Council',
          title: 'Free Sails — High Command',
          text: 'Captain {PLAYER_NAME}. We\'ve never attacked Ironrock. Any captain who suggested it was laughed out of port. ...We\'re not laughing anymore.',
          faction: 'pirate',
          duration: 7000,
        },
        {
          speaker: 'Commodore Holt',
          title: 'Royal Navy — Eastern Fleet',
          text: 'You are ATTACKING AN EMPIRE FORTIFICATION, {PLAYER_NAME}. Do you have any concept of what you\'ve started? This isn\'t piracy anymore. This is WAR.',
          faction: 'navy',
          duration: 7000,
        },
      ],
    },
    {
      id: 'act3_cass_farewell',
      type: 'KILLS',
      trigger: 50,
      objective: { text: 'Wage total war — sink 50 ships', type: 'KILLS', max: 50 },
      cassDeathBeat: true,
      dialogues: [
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'Don\'t give me that look, {PLAYER_NAME}. I\'ve known this was coming since Greyveil. Since I sailed too close to one of the ghost ships. Curiosity. Always been my worst quality.',
          faction: 'pirate',
          duration: 8000,
        },
        {
          speaker: 'Old Cass',
          title: 'Veteran Pirate Captain',
          text: 'The Hollow Deep won\'t take me somewhere too terrible. I\'ve seen enough terrible in my time. I think I\'m ready for whatever comes after. Take the chart. Make the sea remember us properly. Both of us.',
          faction: 'pirate',
          duration: 9000,
        },
        {
          speaker: '📻 Ghost Fleet',
          title: 'Deep Transmission',
          text: '…the sea takes us all eventually, Captain {PLAYER_NAME}… some sooner… some later… do not grieve… she was braver than she knew…',
          faction: 'ghost',
          duration: 8000,
        },
      ],
    },
  ],
  final: [
    {
      id: 'final_intro',
      type: 'KILLS',
      trigger: 65,
      objective: { text: 'Lead the final charge — sink 65 ships', type: 'KILLS', max: 65 },
      dialogues: [
        {
          speaker: 'Brotherhood Captain',
          title: 'Escort Fleet — Final Voyage',
          text: 'This is as far as any of us have sailed and made it back, Captain {PLAYER_NAME}. From here… you\'re on your own. Whatever ye decide in there — know that every captain in these seas will remember your name. Long after this water goes dark or goes bright.',
          faction: 'pirate',
          duration: 9000,
        },
      ],
      actBanner: 'final',
    },
    {
      id: 'final_veynar_offer',
      type: 'KILLS',
      trigger: 75,
      objective: { text: 'Fight your way to Veynar — sink 75 ships, then make your choice', type: 'KILLS', max: 75 },
      dialogues: [
        {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Black Fleet — The Ossuary',
          text: 'Captain {PLAYER_NAME}. You made it. The Hollow Deep does not hate. It simply… consumes, eventually. My offer: help me open the Maw completely — join the Black Fleet of your own will — and you will sail these waters forever. Or fight me, seal the Maw, and face your end. Which choice will you make?',
          faction: 'veynar',
          duration: 15000,
          choices: [
            { text: "☠️ Join the Black Fleet (Endless Spectral Mode)", action: "join_black_fleet", class: "choice-a" },
            { text: "⚓ Defy Silas Veynar (Trigger Boss Flagship)", action: "defy_black_fleet", class: "choice-b" }
          ]
        },
      ],
    },
  ],
};

// ── StorySystem class ─────────────────────────────────────────────────────────
export class StorySystem {
  /**
   * @param {import('../main.js').Game} game
   * @param {string} playerName
   */
  constructor(game, playerName) {
    this.game       = game;
    this.playerName = playerName;

    // State
    this._currentAct    = 'act1';
    this._actIndex      = 0;
    this._beatsFired    = new Set();
    this._dialogueHistory = [];
    this._killCount     = 0;
    this._captureCount  = 0;
    this._gameTime      = 0;
    this._storyActive   = false;
    this._cassIsDead    = false;   // set after act3_cass_farewell fires
    this._activeWaypoint = null;   // { x, z, label } — shown on minimap/compass

    // Faction reputations: 0-1000
    this._reputation = {
      [STORY_FACTION.ROYAL_NAVY]:  -200,  // start hostile
      [STORY_FACTION.BROTHERHOOD]:  100,
      [STORY_FACTION.GHOST_FLEET]: -500,
      [STORY_FACTION.MERCHANTS]:     50,
      [STORY_FACTION.BLACK_TIDE]:  -100,
      [STORY_FACTION.HUNTERS]:      -50,
      [STORY_FACTION.CULT]:        -300,
    };

    // Load saved progress
    this._loadProgress();

    // Wire events
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship?.faction !== Faction.PLAYER) {
        this._killCount++;
        this._checkBeats();
        this._updateReputation(ship.faction);
        EventEmitter.emit('story:objective_update', this._buildObjectivePayload());

        // Check if boss flagship was sunk for Option B Defy Silas Veynar
        if (ship.group?.name === "Silas Veynar's Dread") {
          this._fireBeat({
            id: 'final_victory_defy',
            dialogues: [
              {
                speaker: 'The Sea',
                title: '— The Concordat Lords, Together —',
                text: 'Thank you, Captain {PLAYER_NAME}. Silas Veynar is sunk. The Maw is sealed forever. The Shattered Seas are safe once more.',
                faction: 'ghost',
                duration: 10000,
              },
              {
                speaker: 'Brotherhood Fleet',
                title: 'All Captains — The Shattered Seas',
                text: 'RAISE THE COLOURS! Silas Veynar\'s Dread flagship is sunk! Captain {PLAYER_NAME} has freed the ocean!',
                faction: 'pirate',
                duration: 8000,
              }
            ]
          });
          
          // Trigger standard game victory screen after final dialogue
          setTimeout(() => {
            EventEmitter.emit('game:victory');
          }, 18000);
        }
      }
    });

    EventEmitter.on('island:captured', () => {
      this._captureCount++;
      this._checkBeats();
      EventEmitter.emit('story:objective_update', this._buildObjectivePayload());
    });

    // Final act choice selection
    EventEmitter.on('story:choice_selected', ({ action }) => {
      this._handleFinalChoice(action);
    });

    // World events hook into story
    EventEmitter.on('world:event', ({ type }) => {
      this._onWorldEvent(type);
    });

    // Intercept dialogues for ledger
    EventEmitter.on('story:dialogue', (d) => {
      this._recordDialogue(d);
    });
  }

  _recordDialogue(d) {
    if (!d || !d.text) return;
    const speaker = d.speaker || 'Unknown';
    // Clean player name token
    const text = d.text.replace(/\{PLAYER_NAME\}/g, this.playerName);
    
    // Prevent duplicate adjacent entries in logs
    const last = this._dialogueHistory[this._dialogueHistory.length - 1];
    if (last && last.text === text && last.speaker === speaker) return;

    this._dialogueHistory.push({ speaker, text });
    if (this._dialogueHistory.length > 15) {
      this._dialogueHistory.shift();
    }
    this._saveProgress();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Call every frame from main game loop. */
  update(delta) {
    if (!this._storyActive) return;
    this._gameTime += delta;
    this._checkBeats();
  }

  /** Start Story Mode. Called when player presses Story Mode button. */
  start() {
    this._storyActive = true;
    this._updateFactionHUD();

    const isNew = this._beatsFired.size === 0;
    const crawlEl = document.getElementById('story-intro-crawl');

    if (isNew && crawlEl) {
      crawlEl.classList.remove('hidden');

      const fadeOutCrawl = () => {
        if (crawlEl.classList.contains('fade-out')) return;
        crawlEl.classList.add('fade-out');
        
        // Cleanup key/click event listeners
        window.removeEventListener('keydown', skipHandler);
        crawlEl.removeEventListener('click', skipHandler);
        clearTimeout(this._introTimeout);

        setTimeout(() => {
          crawlEl.classList.add('hidden');
          // Launch Act 1 banner and beats
          this._showActBanner('act1');
          setTimeout(() => this._fireBeatsForAct('act1'), 4000);
          EventEmitter.emit('story:objective_update', this._buildObjectivePayload());
        }, 1800);
      };

      const skipHandler = () => {
        fadeOutCrawl();
      };

      window.addEventListener('keydown', skipHandler);
      crawlEl.addEventListener('click', skipHandler);

      this._introTimeout = setTimeout(fadeOutCrawl, 12000);
      
      // Broadcast initial objective state (hidden during crawl)
      EventEmitter.emit('story:objective_update', this._buildObjectivePayload());
    } else {
      // Resume campaign
      setTimeout(() => {
        this._showActBanner(this._currentAct);
      }, 1000);
      setTimeout(() => {
        this._fireBeatsForAct(this._currentAct);
      }, 3000);
      setTimeout(() => {
        EventEmitter.emit('story:objective_update', this._buildObjectivePayload());
      }, 3500);
    }
  }

  /** Change player name (e.g. after name registration). */
  setPlayerName(name) {
    this.playerName = name;
    if (this.game?.dialogue) {
      this.game.dialogue.setPlayerName(name);
    }
  }

  /** Get current reputation tier for display. */
  getReputationTier() {
    // Use the max reputation across positive factions as overall level
    const avgRep = Math.max(
      this._reputation[STORY_FACTION.BROTHERHOOD],
      this._reputation[STORY_FACTION.MERCHANTS],
      0
    );
    let tier = REP_TIERS[0];
    for (const t of REP_TIERS) {
      if (avgRep >= t.threshold) tier = t;
    }
    return tier;
  }

  getFactionReputation(factionId) {
    return this._reputation[factionId] ?? 0;
  }

  /**
   * Returns the next unfired beat's objective, or null if all beats are done.
   * @returns {{ text:string, type:string, max:number, current:number }|null}
   */
  getCurrentObjective() {
    const beats = STORY_BEATS[this._currentAct] || [];
    for (const beat of beats) {
      if (this._beatsFired.has(beat.id)) continue;
      if (!beat.objective) continue;
      return { ...beat.objective, current: this._getProgressFor(beat) };
    }
    return null;
  }

  /** Returns 0-1 fraction of progress toward the next objective. */
  getObjectiveProgress() {
    const obj = this.getCurrentObjective();
    if (!obj || obj.max <= 0 || obj.type === 'AUTO') return 0;
    return Math.min(1, obj.current / obj.max);
  }

  /** Returns act completion info for the journal/HUD. */
  getActProgress() {
    const actOrder = ['act1', 'act2', 'act3', 'final'];
    const currentIdx = actOrder.indexOf(this._currentAct);
    return ACTS.map((act, i) => ({
      ...act,
      done:    i < currentIdx,
      current: i === currentIdx,
    }));
  }

  /** @private Build payload for story:objective_update events. */
  _buildObjectivePayload() {
    return {
      objective:    this.getCurrentObjective(),
      progress:     this.getObjectiveProgress(),
      killCount:    this._killCount,
      captureCount: this._captureCount,
      currentAct:   this._currentAct,
      actProgress:  this.getActProgress(),
      waypoint:     this._activeWaypoint,
    };
  }

  /** @private Get numeric progress value for a given beat. */
  _getProgressFor(beat) {
    switch (beat.type) {
      case 'KILLS':    return this._killCount;
      case 'CAPTURES': return this._captureCount;
      case 'TIME':     return this._gameTime;
      case 'DISTANCE': {
        if (!beat.coordinates || !this.game?.playerShip?.group) return 0;
        const p = this.game.playerShip.group.position;
        const dist = Math.hypot(p.x - beat.coordinates.x, p.z - beat.coordinates.z);
        return dist <= (beat.triggerRange || 45) ? 1 : 0;
      }
      default: return 0;
    }
  }

  // ── Story Beats ────────────────────────────────────────────────────────────

  _checkBeats() {
    const beats = STORY_BEATS[this._currentAct] || [];

    for (const beat of beats) {
      if (this._beatsFired.has(beat.id)) continue;

      let triggered = false;
      switch (beat.type) {
        case 'KILLS':    triggered = this._killCount    >= beat.trigger; break;
        case 'CAPTURES': triggered = this._captureCount >= beat.trigger; break;
        case 'TIME':     triggered = this._gameTime     >= beat.trigger; break;
        case 'GOLD':
          triggered = (this.game?.economy?.resources?.gold ?? 0) >= beat.trigger;
          break;
        case 'DISTANCE':
          if (beat.coordinates && this.game.playerShip?.group) {
            const playerPos = this.game.playerShip.group.position;
            const targetPos = new THREE.Vector3(beat.coordinates.x, playerPos.y, beat.coordinates.z);
            const dist = playerPos.distanceTo(targetPos);
            triggered = dist <= (beat.triggerRange || 45);
          }
          break;
        case 'EVENT':
          // Fired externally via _onWorldEvent
          break;
        default: break;
      }

      if (triggered) {
        this._fireBeat(beat);
      }
    }

    // Check act advancement
    this._checkActAdvancement();
  }

  _fireBeat(beat) {
    this._beatsFired.add(beat.id);

    // Act banner first if needed
    if (beat.actBanner) {
      this._showActBanner(beat.actBanner);
    }

    // Queue dialogues with delays so banner shows first
    const delay = beat.actBanner ? 3500 : 0;
    if (beat.dialogues?.length) {
      setTimeout(() => {
        for (const d of beat.dialogues) {
          EventEmitter.emit('story:dialogue', d);
        }
      }, delay);
    }

    // Trigger special spawn events
    if (beat.spawnEvent) {
      this._handleSpawnEvent(beat.spawnEvent);
    }

    // Trigger waypoint (map marker + compass)
    if (beat.waypointEvent) {
      this._activeWaypoint = beat.waypointEvent;
      EventEmitter.emit('story:waypoint', beat.waypointEvent);
    }

    // Mark Old Cass as dead so future world event dialogues skip her lines
    if (beat.cassDeathBeat) {
      this._cassIsDead = true;
    }

    // Save progress
    this._saveProgress();
    EventEmitter.emit('story:beat_fired', { beatId: beat.id, act: this._currentAct });
    EventEmitter.emit('story:objective_update', this._buildObjectivePayload());
  }

  _checkActAdvancement() {
    const actOrder = ['act1', 'act2', 'act3', 'final'];
    const currentIdx = actOrder.indexOf(this._currentAct);

    // Advance acts based on kill milestones
    const actThresholds = { act1: 12, act2: 32, act3: 58, final: 80 };
    const nextAct = actOrder[currentIdx + 1];

    if (nextAct && this._killCount >= actThresholds[nextAct] &&
        !this._beatsFired.has(`act_advance_${nextAct}`)) {
      this._beatsFired.add(`act_advance_${nextAct}`);
      this._advanceAct(nextAct);
    }
  }

  _handleSpawnEvent(eventName) {
    if (eventName === 'spawn_act2_wreck') {
      const wreckModel = this.game.scene.getObjectByName('ship_wreck_landmark');
      if (!wreckModel) {
        const wreckGroup = new THREE.Group();
        wreckGroup.name = 'ship_wreck_landmark';
        
        // Spawn a simple crate or wreckage mesh
        const geometry = new THREE.BoxGeometry(8, 5, 12);
        const material = new THREE.MeshStandardMaterial({ 
          color: 0x5a3e1a, 
          roughness: 0.95,
          metalness: 0.1 
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = 0.25;
        mesh.rotation.y = 0.6;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        wreckGroup.add(mesh);
        
        // Add a glowing beacon
        const light = new THREE.PointLight(0x00ffaa, 5, 45);
        light.position.set(0, 4, 0);
        wreckGroup.add(light);
        
        wreckGroup.position.set(240, 0, -180);
        this.game.scene.add(wreckGroup);
        
        this.game.hud?.toast("🗺️ Landmark wreck coordinates: (240, -180)", "info");
      }
    } else if (eventName === 'spawn_holt_ambush') {
      const playerPos = this.game.playerShip.group.position;
      const x = playerPos.x + 65;
      const z = playerPos.z + 65;
      
      const ship = this.game.ships.createShip('navy_medium', 'BRITISH', x, z);
      ship.group.name = "Commodore Holt's Flagship";
      this.game.ai.registerShip(ship, 'HUNTER');
      this.game.hud?.toast("⚓ Commodore Holt has ambushed you!", "danger");
      
      if (this.game.cameraSystem) {
        this.game.cameraSystem.focusCinematic(ship.group, 4500);
      }
    } else if (eventName === 'spawn_veynar_dread') {
      const playerPos = this.game.playerShip.group.position;
      const x = playerPos.x - 90;
      const z = playerPos.z - 90;
      
      const ship = this.game.ships.createShip('ghost_large', 'GHOST_FLEET', x, z);
      ship.group.name = "Silas Veynar's Dread";
      this.game.ai.registerShip(ship, 'HUNTER');
      this.game.hud?.toast("☠️ Silas Veynar has arrived in the Dread Flagship!", "danger");
      
      if (this.game.cameraSystem) {
        this.game.cameraSystem.focusCinematic(ship.group, 6000);
      }
    }
  }

  _handleFinalChoice(action) {
    if (action === 'join_black_fleet') {
      this.game._joinedBlackFleet = true;
      this._triggerBloodMoon();
      
      if (this.game.sky) {
        // Dynamic blood moon forever
        this.game.sky.setBloodMoonIntensity(1.0);
      }
      
      setTimeout(() => {
        EventEmitter.emit('story:dialogue', {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Black Fleet',
          text: 'Welcome to the armada, Captain {PLAYER_NAME}. The seas are ours, for all eternity. Let the living weep!',
          faction: 'veynar',
          duration: 7000
        });
      }, 1000);
      
      this.game.hud?.toast("💀 You have joined the Black Fleet! Endless mode active.", "danger");
    } else if (action === 'defy_black_fleet') {
      this._handleSpawnEvent('spawn_veynar_dread');
      
      setTimeout(() => {
        EventEmitter.emit('story:dialogue', {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Black Fleet',
          text: 'Very well! If you will not rule beside me, then you will sink below me! Prepare to die, {PLAYER_NAME}!',
          faction: 'veynar',
          duration: 7000
        });
      }, 1200);
    }
  }

  _advanceAct(newAct) {
    this._currentAct = newAct;
    this._actIndex++;

    // Show banner
    setTimeout(() => this._showActBanner(newAct), 1000);

    // Fire intro beats for new act
    setTimeout(() => this._fireBeatsForAct(newAct), 4000);

    EventEmitter.emit('story:act_changed', { act: newAct });
    this._saveProgress();
  }

  _fireBeatsForAct(actId) {
    // Only fire TIME-triggered intro beats at act start
    const beats = STORY_BEATS[actId] || [];
    for (const beat of beats) {
      if (beat.type === 'TIME' && beat.trigger <= 10 && !this._beatsFired.has(beat.id)) {
        this._fireBeat(beat);
        break; // Only first intro beat
      }
    }
  }

  // ── World Event Hooks ──────────────────────────────────────────────────────

  _onWorldEvent(type) {
    if (!this._storyActive) return;

    switch (type) {
      case 'GHOST_FLEET':
        this._onGhostFleetEvent();
        break;
      case 'SEA_MONSTER_WARNING':
        this._onKrakenEvent();
        break;
      case 'STORM_SURGE':
        this._onStormEvent();
        break;
      case 'LEGENDARY_CAPTAIN':
        this._onLegendaryEvent();
        break;
      case 'BOUNTY_HUNTER':
        this._onBountyHunterEvent();
        break;
    }
  }

  _onGhostFleetEvent() {
    // Story-enhanced ghost fleet dialogue
    const actDialogues = {
      act1: [
        {
          speaker: '👻 Ghost Signal',
          title: 'Deep Water Transmission',
          text: '…we sailed too close… we thought we were brave… the sea had other ideas… {PLAYER_NAME}… be smarter than we were…',
          faction: 'ghost',
          duration: 7000,
        },
      ],
      act2: [
        {
          speaker: '👻 Ghost Captain',
          title: 'Black Fleet — Unknown Vessel',
          text: 'The Tide comes. The Tide comes. The Admiral sends his regards, Captain {PLAYER_NAME}.',
          faction: 'ghost',
          duration: 6000,
        },
      ],
      act3: [
        {
          speaker: 'Admiral Silas Veynar',
          title: 'Lord Admiral — The Ossuary',
          text: 'Captain {PLAYER_NAME}… I hope you\'ve been sharpening your cannons. The Hollow Deep grows impatient.',
          faction: 'veynar',
          duration: 7000,
        },
      ],
      final: [
        {
          speaker: '👻 Concordat Ghosts',
          title: '— Seven Lords, Speaking as One —',
          text: '…the Crimson Vow\'s seal… after all this time… sailor… do you know what you carry? Do you understand the weight of it…',
          faction: 'ghost',
          duration: 8000,
        },
      ],
    };

    const dialogues = actDialogues[this._currentAct] || actDialogues.act1;
    for (const d of dialogues) {
      EventEmitter.emit('story:dialogue', d);
    }

    // Trigger Blood Moon atmospheric event occasionally in later acts
    if ((this._currentAct === 'act3' || this._currentAct === 'final') && Math.random() < 0.4) {
      setTimeout(() => this._triggerBloodMoon(), 2000);
    }
  }

  _onKrakenEvent() {
    const lines = [
      {
        speaker: '📻 Panicking Sailor',
        title: 'Distress Frequency',
        text: 'Something is UNDER US — the water — it\'s— something enormous— OH GOD—',
        faction: 'merchant',
        duration: 5000,
      },
    ];

    if (this._cassIsDead) {
      lines.push({
        speaker: 'Mira Salthook',
        title: 'Concordat Cartographer',
        text: 'Old Cass\'s notes were right, {PLAYER_NAME}! Train your cannons on the water! Aim for the shadow!',
        faction: 'pirate',
        duration: 7000,
      });
    } else {
      lines.push({
        speaker: 'Old Cass',
        title: 'Veteran Pirate Captain',
        text: 'The sea monster stories were never stories, {PLAYER_NAME}. Get your cannons trained on the water. AIM FOR THE SHADOW.',
        faction: 'pirate',
        duration: 6000,
      });
    }

    for (const d of lines) EventEmitter.emit('story:dialogue', d);
  }

  _onStormEvent() {
    const lines = [
      {
        speaker: '📻 Weather Scout',
        title: 'Scout Ship — Forward Position',
        text: 'Captain {PLAYER_NAME} — storm moving in from the northwest — she\'s a big one — winds above sixty — I\'d recommend— [STATIC] ...I\'d recommend running.',
        faction: 'neutral',
        duration: 6000,
      },
    ];

    // Blood Moon storm in act3+
    if (this._currentAct === 'act3' || this._currentAct === 'final') {
      lines.push({
        speaker: 'Mira Salthook',
        title: 'Concordat Cartographer',
        text: 'Those vents never fired during the Concordat years. Something is disturbing the seafloor, {PLAYER_NAME}. The disruption is coming from the Maw. It\'s GROWING.',
        faction: 'pirate',
        duration: 7000,
      });
      setTimeout(() => this._triggerBloodMoon(), 1000);
    }

    for (const d of lines) EventEmitter.emit('story:dialogue', d);
  }

  _onLegendaryEvent() {
    const lines = [
      {
        speaker: 'Mira Salthook',
        title: 'Concordat Cartographer',
        text: 'A Legendary Captain on the horizon. Someone worth fighting, {PLAYER_NAME}. The sea is watching.',
        faction: 'pirate',
        duration: 5500,
      },
    ];
    for (const d of lines) EventEmitter.emit('story:dialogue', d);
  }

  _onBountyHunterEvent() {
    const lines = [
      {
        speaker: '📻 Intercepted Navy Signal',
        title: 'Royal Navy — Encrypted Channel',
        text: 'Admiral Holt to all fleet units. Captain {PLAYER_NAME} has been sighted in these waters. I don\'t care what it costs. SINK THEM.',
        faction: 'navy',
        duration: 6500,
      },
    ];
    for (const d of lines) EventEmitter.emit('story:dialogue', d);
  }

  // ── Atmospheric Effects ────────────────────────────────────────────────────

  _triggerBloodMoon() {
    EventEmitter.emit('story:blood_moon', { active: true });
    // Auto-clear after 90 seconds
    setTimeout(() => {
      EventEmitter.emit('story:blood_moon', { active: false });
    }, 90000);
  }

  // ── Act Banner ─────────────────────────────────────────────────────────────

  _showActBanner(actId) {
    const act = ACTS.find(a => a.id === actId);
    if (!act) return;

    EventEmitter.emit('story:act_banner', {
      title:    act.title,
      subtitle: act.subtitle,
      color:    act.color,
    });
  }

  // ── Faction Reputation ─────────────────────────────────────────────────────

  _updateReputation(sunkFaction) {
    // Gain rep with Brotherhood when sinking Navy/Black Tide
    if (sunkFaction === Faction.BRITISH || sunkFaction === Faction.SPANISH) {
      this._reputation[STORY_FACTION.ROYAL_NAVY]    -= 20;
      this._reputation[STORY_FACTION.BROTHERHOOD]   += 15;
      this._reputation[STORY_FACTION.MERCHANTS]     += 5;
    }
    // Gain Navy rep if sinking pirates (player is betraying)
    if (sunkFaction === Faction.PIRATE) {
      this._reputation[STORY_FACTION.ROYAL_NAVY]    += 10;
      this._reputation[STORY_FACTION.BROTHERHOOD]   -= 20;
      this._reputation[STORY_FACTION.BLACK_TIDE]    -= 15;
    }
    if (sunkFaction === Faction.MERCHANT) {
      this._reputation[STORY_FACTION.MERCHANTS]     -= 30;
      this._reputation[STORY_FACTION.BLACK_TIDE]    += 10;
    }

    this._updateFactionHUD();
    EventEmitter.emit('story:reputation_changed', {
      reputations: { ...this._reputation },
      tier: this.getReputationTier(),
    });
  }

  _updateFactionHUD() {
    EventEmitter.emit('story:faction_hud_update', {
      reputations: { ...this._reputation },
      tier: this.getReputationTier(),
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _saveProgress() {
    try {
      const state = {
        act:      this._currentAct,
        actIndex: this._actIndex,
        beats:    Array.from(this._beatsFired),
        kills:    this._killCount,
        captures: this._captureCount,
        rep:      this._reputation,
        joinedBlackFleet: this.game?._joinedBlackFleet || false,
        dialogueHistory: this._dialogueHistory,
        cassIsDead: this._cassIsDead,
      };
      localStorage.setItem('pe_story_progress', JSON.stringify(state));
    } catch {}
  }

  _loadProgress() {
    try {
      const raw = localStorage.getItem('pe_story_progress');
      if (!raw) return;
      const state = JSON.parse(raw);
      this._currentAct   = state.act      ?? 'act1';
      this._actIndex     = state.actIndex ?? 0;
      this._beatsFired   = new Set(state.beats ?? []);
      this._killCount    = state.kills    ?? 0;
      this._captureCount = state.captures ?? 0;
      if (state.rep) this._reputation = { ...this._reputation, ...state.rep };
      this._dialogueHistory = state.dialogueHistory ?? [];
      this._cassIsDead = state.cassIsDead ?? false;
      
      if (state.joinedBlackFleet && this.game) {
        this.game._joinedBlackFleet = true;
        // set sky system blood moon intensity
        setTimeout(() => {
          if (this.game.sky) this.game.sky.setBloodMoonIntensity(1.0);
        }, 1200);
      }
    } catch {}
  }

  /** Reset all story progress. */
  reset() {
    this._currentAct   = 'act1';
    this._actIndex     = 0;
    this._beatsFired   = new Set();
    this._killCount    = 0;
    this._captureCount = 0;
    this._gameTime     = 0;
    this._dialogueHistory = [];
    this._cassIsDead = false;
    if (this.game) {
      this.game._joinedBlackFleet = false;
      if (this.game.sky) this.game.sky.setBloodMoonIntensity(0);
      const overlay = document.getElementById('blood-moon-overlay');
      if (overlay) overlay.classList.add('hidden');
    }
    localStorage.removeItem('pe_story_progress');
    EventEmitter.emit('story:reset');
  }
}

export default StorySystem;
