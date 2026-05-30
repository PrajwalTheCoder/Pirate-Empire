/**
 * MissionSystem — tracks sequential missions and rewards player on completion.
 */
import EventEmitter from '../utils/EventEmitter.js';
import { Faction }  from '../config/ShipConfig.js';

// ─── Mission definitions ───────────────────────────────────────────────────────
const MISSIONS = [
  {
    id: 'sink_3',
    title: '⚔️ First Blood',
    desc: 'Sink 3 enemy ships.',
    type: 'SINK_SHIPS',
    target: 3,
    faction: null,   // any faction
    reward: { gold: 200 },
    rewardText: '+200 Gold',
  },
  {
    id: 'capture_1',
    title: '🏝️ Claim the Seas',
    desc: 'Capture your first island.',
    type: 'CAPTURE_ISLAND',
    target: 1,
    reward: { gold: 300 },
    rewardText: '+300 Gold',
  },
  {
    id: 'gold_500',
    title: '💰 War Chest',
    desc: 'Accumulate 500 gold.',
    type: 'EARN_GOLD',
    target: 500,
    reward: { gold: 150 },
    rewardText: '+150 Gold',
  },
  {
    id: 'build_1',
    title: '🗼 Raise the Fort',
    desc: 'Build a structure on a captured island.',
    type: 'BUILD_STRUCTURE',
    target: 1,
    reward: { gold: 400 },
    rewardText: '+400 Gold',
  },
  {
    id: 'sink_5_navy',
    title: '⚡ Navy Nemesis',
    desc: 'Sink 5 Navy ships (British or Spanish).',
    type: 'SINK_SHIPS',
    target: 5,
    faction: [Faction.BRITISH, Faction.SPANISH],
    reward: { gold: 600 },
    rewardText: '+600 Gold',
  },
  {
    id: 'capture_3',
    title: '🌊 King of Islands',
    desc: 'Capture 3 islands.',
    type: 'CAPTURE_ISLAND',
    target: 3,
    reward: { gold: 800 },
    rewardText: '+800 Gold',
  },
  {
    id: 'build_vault',
    title: '💎 Treasure Vault',
    desc: 'Build a Treasure Vault on an island.',
    type: 'BUILD_SPECIFIC',
    buildingType: 'TREASURE_VAULT',
    target: 1,
    reward: { gold: 1000 },
    rewardText: '+1000 Gold',
  },
  {
    id: 'sink_hunter',
    title: '☠️ Hunt the Hunter',
    desc: 'Sink the dreaded Pirate Hunter.',
    type: 'SINK_SHIPS',
    faction: [Faction.PIRATE_HUNTER],
    target: 1,
    reward: { gold: 1500 },
    rewardText: '+1500 Gold',
  },
  {
    id: 'gold_10000',
    title: '☠️ Pirate King',
    desc: 'Amass 10,000 gold. Rule the Caribbean!',
    type: 'EARN_GOLD',
    target: 10000,
    reward: { gold: 2500 },
    rewardText: '+2500 Gold + VICTORY!',
    final: true,
  },
];

export class MissionSystem {
  /**
   * @param {EconomySystem} economy
   * @param {IslandSystem}  islands
   */
  constructor(economy, islands) {
    this._economy    = economy;
    this._islands    = islands;
    this._missionIdx = 0;
    this._progress   = 0;

    // Track sunk count per faction
    this._shipsSunk  = {};

    EventEmitter.on('ship:destroyed', ({ ship }) => {
      this._onShipDestroyed(ship);
    });

    EventEmitter.on('island:captured', ({ island }) => {
      this._onIslandCaptured(island);
    });

    EventEmitter.on('build:completed', ({ island, building }) => {
      this._onBuildCompleted(building);
    });

    // Periodically check gold-based missions
    EventEmitter.on('economy:changed', ({ gold }) => {
      this._checkGoldMission(gold);
    });
  }

  get currentMission() {
    return MISSIONS[this._missionIdx] ?? null;
  }

  get allMissions() { return MISSIONS; }
  get currentIndex() { return this._missionIdx; }
  get currentProgress() { return this._progress; }

  // ── Event handlers ─────────────────────────────────────────────────────────

  _onShipDestroyed(ship) {
    const m = this.currentMission;
    if (!m || m.type !== 'SINK_SHIPS') return;

    const factionMatch = !m.faction ||
      (Array.isArray(m.faction) ? m.faction.includes(ship.faction) : ship.faction === m.faction);

    if (factionMatch) {
      this._progress++;
      EventEmitter.emit('mission:progress', { mission: m, progress: this._progress });
      this._checkCompletion();
    }
  }

  _onIslandCaptured(_island) {
    const m = this.currentMission;
    if (!m || m.type !== 'CAPTURE_ISLAND') return;
    this._progress = this._islands.capturedCount;
    EventEmitter.emit('mission:progress', { mission: m, progress: this._progress });
    this._checkCompletion();
  }

  _onBuildCompleted(buildingType) {
    const m = this.currentMission;
    if (!m) return;
    if (m.type === 'BUILD_STRUCTURE' ||
        (m.type === 'BUILD_SPECIFIC' && m.buildingType === buildingType)) {
      this._progress++;
      EventEmitter.emit('mission:progress', { mission: m, progress: this._progress });
      this._checkCompletion();
    }
  }

  _checkGoldMission(gold) {
    const m = this.currentMission;
    if (!m || m.type !== 'EARN_GOLD') return;
    this._progress = gold;
    EventEmitter.emit('mission:progress', { mission: m, progress: this._progress });
    this._checkCompletion();
  }

  _checkCompletion() {
    const m = this.currentMission;
    if (!m) return;
    if (this._progress >= m.target) {
      this._completeMission(m);
    }
  }

  _completeMission(m) {
    // Advance index FIRST — before any economy.add() that would re-emit
    // economy:changed and call _checkGoldMission() on the same mission again.
    if (!m.final) {
      this._missionIdx++;
      this._progress = 0;
    }

    EventEmitter.emit('mission:complete', { mission: m });

    if (m.final) {
      EventEmitter.emit('game:victory', {});
      return;
    }

    // Award reward after advancing, so any economy:changed re-entry sees the
    // new (different-type) mission, not the just-completed gold mission.
    if (m.reward.gold) {
      this._economy.add('gold', m.reward.gold);
    }

    if (this._missionIdx < MISSIONS.length) {
      EventEmitter.emit('mission:new', { mission: this.currentMission });
    }
  }

  update(_delta) { /* event-driven */ }
}

export default MissionSystem;
