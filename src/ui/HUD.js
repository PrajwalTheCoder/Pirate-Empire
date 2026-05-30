/**
 * HUD — manages the top bar resources, health bar, prompts,
 * floating damage numbers, and toast notifications.
 */
import EventEmitter from '../utils/EventEmitter.js';
import { worldToScreen } from '../utils/MathUtils.js';
import * as THREE from 'three';

export class HUD {
  /**
   * @param {THREE.Camera}        camera
   * @param {HTMLCanvasElement}   canvas
   */
  constructor(camera, canvas) {
    this._camera = camera;
    this._canvas = canvas;

    // DOM refs
    this._goldEl    = document.getElementById('gold-value');
    this._crewEl    = document.getElementById('crew-value');
    this._woodEl    = document.getElementById('wood-value');
    this._fleetEl   = document.getElementById('fleet-value');
    this._islandsEl = document.getElementById('islands-value');
    this._healthFill = document.getElementById('player-health-fill');
    this._healthText = document.getElementById('player-health-text');
    this._prompt     = document.getElementById('prompt');
    this._promptText = document.getElementById('prompt-text');
    this._toastCont  = document.getElementById('toast-container');
    this._windArrow  = document.getElementById('wind-arrow');

    /** @type {{ text: string, type: string, timer: number, el: HTMLElement }[]} */
    this._toasts = [];

    // Subscribe to events
    EventEmitter.on('economy:changed', (res) => this._onEconomyChanged(res));
    EventEmitter.on('island:capturable', ({ island }) =>
      this._showPrompt(`Press E to Capture Island`));
    EventEmitter.on('island:outofrange', () => this._hidePrompt());
    EventEmitter.on('island:captured', ({ island }) => {
      this._hidePrompt();
      this.toast(`⚓ Island Captured! +${island.id}`, 'success');
    });
    EventEmitter.on('loot:collected', ({ gold, wood, crew, source }) => {
      const parts = [];
      if (gold) parts.push(`+${gold} Gold`);
      if (wood) parts.push(`+${wood} Wood`);
      if (crew) parts.push(`+${crew} Crew`);
      const label = parts.join(', ') || '+Loot';
      const suffix = source ? ` (${source})` : '';
      this.toast(`🪙 ${label}${suffix}`, 'gold');
    });
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== 'PLAYER')
        this.toast(`💀 Enemy ship sunk!`, 'danger');
    });
    EventEmitter.on('island:under_attack', () =>
      this.toast('⚔️ Island under attack!', 'danger'));
    EventEmitter.on('island:lost', ({ island }) =>
      this.toast(`💥 Island #${island.id} has fallen!`, 'danger'));
    EventEmitter.on('ship:hit', ({ ship, damage }) => {
      if (ship?.group?.position) {
        const type = ship.faction === 'PLAYER' ? 'player' : 'enemy';
        this.spawnDamageNumber(Math.ceil(damage), ship.group.position.clone(), type);
      }
    });
    EventEmitter.on('upgrade:purchased', ({ upgrade }) =>
      this.toast(`⬆️ ${upgrade.label} unlocked!`, 'success'));
    EventEmitter.on('build:completed', ({ building }) =>
      this.toast(`🏗️ ${building.replace('_', ' ')} built!`, 'success'));
    EventEmitter.on('mission:complete', ({ mission }) =>
      this.toast(`✅ Mission Complete: ${mission.title}  ${mission.rewardText}`, 'success'));
    EventEmitter.on('game:victory', () =>
      this.toast('☠️ YOU ARE THE PIRATE KING! ☠️', 'gold'));
  }

  // ── Economy ────────────────────────────────────────────────────────────────

  _onEconomyChanged(res) {
    if (this._goldEl)    this._goldEl.textContent    = res.gold  ?? 0;
    if (this._crewEl)    this._crewEl.textContent    = res.crew  ?? 0;
    if (this._woodEl)    this._woodEl.textContent    = res.wood  ?? 0;
  }

  /** Call each frame with player ship reference. */
  updateShipInfo(playerShip, fleetSize, islandCount) {
    if (!playerShip) return;
    const pct = playerShip.health / playerShip.maxHealth;

    if (this._healthFill) {
      this._healthFill.style.width = `${pct * 100}%`;
      this._healthFill.className   = 'health-fill' +
        (pct < 0.33 ? ' low' : pct < 0.66 ? ' medium' : '');
    }
    if (this._healthText) {
      this._healthText.textContent =
        `${Math.ceil(playerShip.health)} / ${playerShip.maxHealth}`;
    }
    if (this._fleetEl)   this._fleetEl.textContent   = fleetSize;
    if (this._islandsEl) this._islandsEl.textContent = islandCount;
  }

  // ── Prompt ─────────────────────────────────────────────────────────────────

  _showPrompt(text) {
    if (this._prompt) {
      this._promptText.textContent = text;
      this._prompt.classList.remove('hidden');
    }
  }

  _hidePrompt() {
    if (this._prompt) this._prompt.classList.add('hidden');
  }

  // ── Floating Damage Numbers ───────────────────────────────────────────────

  /**
   * @param {number} damage
   * @param {THREE.Vector3} worldPos
   * @param {'enemy'|'player'|'heal'|'gold'} type
   */
  spawnDamageNumber(damage, worldPos, type = 'enemy') {
    const screen = worldToScreen(worldPos, this._camera, this._canvas);
    if (screen.x < 0 || screen.y < 0 ||
        screen.x > window.innerWidth || screen.y > window.innerHeight) return;

    const el = document.createElement('div');
    el.className = `damage-number ${type}`;
    el.textContent = type === 'gold' ? `+${damage}💰` : type === 'heal' ? `+${damage}💚` : `-${damage}`;
    el.style.left = `${screen.x + (Math.random() - 0.5) * 30}px`;
    el.style.top  = `${screen.y}px`;
    document.body.appendChild(el);

    // Remove after animation
    setTimeout(() => el.remove(), 1000);
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  /**
   * Show a toast notification.
   * @param {string} text
   * @param {'gold'|'success'|'danger'|'info'|''} type
   */
  toast(text, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = text;
    this._toastCont.appendChild(el);

    // Remove after CSS animation (3s)
    setTimeout(() => el.remove(), 3200);
  }

  // ── Island HP Bars ────────────────────────────────────────────────────────

  /**
   * Project player-owned damaged islands to screen and render floating HP bars.
   * @param {IslandData[]} islands
   */
  updateIslandHPBars(islands) {
    let container = document.getElementById('island-hp-bars');
    if (!container) {
      container = document.createElement('div');
      container.id = 'island-hp-bars';
      document.body.appendChild(container);
    }
    container.innerHTML = '';
    for (const island of islands) {
      if (!island.captured || island.owner !== 'PLAYER') continue;
      if (!island.hp || !island.maxHp || island.hp >= island.maxHp) continue;
      const screen = worldToScreen(island.position, this._camera, this._canvas);
      if (screen.x < 0 || screen.y < 0 ||
          screen.x > window.innerWidth || screen.y > window.innerHeight) continue;
      const pct = island.hp / island.maxHp;
      const bar = document.createElement('div');
      bar.className = 'island-hp-bar';
      bar.style.left = `${screen.x - 30}px`;
      bar.style.top  = `${screen.y - 30}px`;
      bar.innerHTML  = `<div class="island-hp-fill" style="width:${pct * 100}%"></div>`;
      container.appendChild(bar);
    }
  }

  /**
   * Rotate wind arrow relative to player's heading.
   * @param {number} windAngle
   * @param {number} playerRotation
   */
  updateWind(windAngle, playerRotation) {
    if (!this._windArrow) return;
    const relativeAngle = windAngle - playerRotation;
    const degrees = (relativeAngle * 180 / Math.PI) + 180;
    this._windArrow.style.transform = `rotate(${degrees}deg)`;
  }

  update(_delta) { /* event-driven */ }
}

export default HUD;
