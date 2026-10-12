/**
 * HUD — manages the top bar resources, health bar, prompts,
 * floating damage numbers, and toast notifications.
 */
import EventEmitter from '../utils/EventEmitter.js';
import { worldToScreen, dist2D } from '../utils/MathUtils.js';
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

    // Combat Juice & Kill feedback
    this._streakCount = 0;
    this._lastKillTime = 0;
    this._killBannerTimeout = null;
    this._hitmarkerTimeout = null;
    this._hitmarkerEl = document.getElementById('hitmarker');
    this._killBannerEl = document.getElementById('kill-banner');
    this._kbTitleEl = document.getElementById('kb-title');
    this._kbSubEl = document.getElementById('kb-sub');
    this._kbStreakEl = document.getElementById('kb-streak');
    this._killFeedEl = document.getElementById('kill-feed');

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
    EventEmitter.on('combat:hitmarker', ({ isCrit, isRake, isKill }) => {
      this.showHitmarker(isCrit, isRake, isKill);
    });
    EventEmitter.on('ship:rammed', ({ rammer, victim, damage }) => {
      const pos = victim?.group?.position || rammer?.group?.position;
      if (pos) {
        this.spawnDamageNumber(damage, pos.clone().setY(4), 'crit');
      }
      if (rammer === window.__game?.playerShip || victim === window.__game?.playerShip) {
        this.toast(`💥 RAM IMPACT! -${damage} damage!`, 'danger');
      }
    });
    EventEmitter.on('ship:destroyed', ({ ship }) => {
      if (ship.faction !== 'PLAYER') {
        const playerName = window.__game?.playerName || 'Captain';
        this.showKillBanner(ship, playerName);
      }
    });
    EventEmitter.on('island:under_attack', () =>
      this.toast('⚔️ Island under attack!', 'danger'));
    EventEmitter.on('island:lost', ({ island }) =>
      this.toast(`💥 Island #${island.id} has fallen!`, 'danger'));
    EventEmitter.on('ship:hit', ({ ship, damage }) => {
      if (ship?.group?.position) {
        const isPlayer = ship.faction === 'PLAYER' || ship === window.__game?.playerShip;
        const type = isPlayer ? 'player' : 'enemy';
        this.spawnDamageNumber(Math.ceil(damage), ship.group.position.clone(), type);
        if (isPlayer) {
          this.showDamageFlash();
        }
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

  _initDamageVignette() {
    let el = document.getElementById('damage-vignette');
    if (!el) {
      el = document.createElement('div');
      el.id = 'damage-vignette';
      document.body.appendChild(el);
    }
    this._damageVignetteEl = el;
  }

  showDamageFlash() {
    if (!this._damageVignetteEl) this._initDamageVignette();
    const el = this._damageVignetteEl;
    if (!el) return;
    el.classList.remove('active');
    void el.offsetWidth; // force reflow
    el.classList.add('active');
    clearTimeout(this._vignetteTimeout);
    this._vignetteTimeout = setTimeout(() => {
      el.classList.remove('active');
    }, 280);
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

  // ── Partner Overhead Marker ──────────────────────────────────────────────────

  /**
   * Render a floating overhead HUD marker above the co-op partner ship.
   * Shows captain name, green health bar, HP text, and distance.
   * When partner is off-screen, renders a directional edge arrow.
   *
   * @param {string}      partnerName  — captain name of the partner
   * @param {THREE.Vector3|null} playerPos — local player position for distance calc
   */
  updatePartnerMarker(partnerShip, partnerName, playerPos) {
    // Lazy-create the container once
    if (!this._partnerMarkerEl) {
      const el = document.createElement('div');
      el.id = 'partner-overhead-marker';
      el.className = 'partner-marker';
      el.innerHTML = `
        <div class="partner-marker-name">🤝 <span id="pmk-name"></span></div>
        <div class="partner-marker-hpbar">
          <div class="partner-marker-hpfill" id="pmk-hpfill"></div>
        </div>
        <div class="partner-marker-hptext" id="pmk-hptext"></div>
        <div class="partner-marker-dist" id="pmk-dist"></div>
      `;
      document.body.appendChild(el);
      this._partnerMarkerEl = el;

      // Edge arrow indicator (shown when partner is off-screen)
      const arrow = document.createElement('div');
      arrow.id = 'partner-edge-arrow';
      arrow.className = 'partner-edge-arrow hidden';
      arrow.innerHTML = `<span class="pea-icon">🤝</span><span class="pea-arrow">▶</span>`;
      document.body.appendChild(arrow);
      this._partnerEdgeEl = arrow;
    }

    if (!partnerShip || !partnerShip.group) {
      this._partnerMarkerEl.classList.add('hidden');
      this._partnerEdgeEl?.classList.add('hidden');
      return;
    }

    const worldPos = partnerShip.group.position.clone();
    worldPos.y += 12; // raise above the mast
    const screen = worldToScreen(worldPos, this._camera, this._canvas);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const onScreen = screen.x > 60 && screen.x < W - 60 &&
                     screen.y > 60 && screen.y < H - 60;

    // Update HP data
    const hp  = partnerShip.health    ?? 100;
    const mhp = partnerShip.maxHealth ?? 100;
    const hpPct = mhp > 0 ? Math.max(0, hp / mhp) : 0;

    const nameEl   = document.getElementById('pmk-name');
    const fillEl   = document.getElementById('pmk-hpfill');
    const hpTextEl = document.getElementById('pmk-hptext');
    const distEl   = document.getElementById('pmk-dist');

    if (nameEl)   nameEl.textContent   = partnerName || 'First Mate';
    if (fillEl) {
      fillEl.style.width       = `${(hpPct * 100).toFixed(0)}%`;
      // green → yellow → red based on HP
      fillEl.style.background  = hpPct > 0.5 ? '#00ff66'
                                : hpPct > 0.25 ? '#ffcc00' : '#ff3030';
    }
    if (hpTextEl) hpTextEl.textContent = `${Math.ceil(hp)} / ${Math.ceil(mhp)}`;

    if (distEl && playerPos) {
      const dx = partnerShip.group.position.x - playerPos.x;
      const dz = partnerShip.group.position.z - playerPos.z;
      distEl.textContent = `${Math.round(Math.sqrt(dx*dx + dz*dz))}m away`;
    }

    if (onScreen) {
      this._partnerMarkerEl.classList.remove('hidden');
      this._partnerMarkerEl.style.left      = `${screen.x}px`;
      this._partnerMarkerEl.style.top       = `${screen.y}px`;
      this._partnerMarkerEl.style.transform = 'translate(-50%, -100%)';
      this._partnerEdgeEl?.classList.add('hidden');
    } else {
      // Off-screen: hide main marker, show edge arrow
      this._partnerMarkerEl.classList.add('hidden');
      const arrow = this._partnerEdgeEl;
      if (!arrow) return;
      arrow.classList.remove('hidden');

      // Clamp to screen edge
      const cx = W / 2, cy = H / 2;
      const dx = screen.x - cx;
      const dy = screen.y - cy;
      const angle = Math.atan2(dy, dx);
      const MARGIN = 52;
      const ex = cx + Math.cos(angle) * (Math.min(cx, cy) - MARGIN);
      const ey = cy + Math.sin(angle) * (Math.min(cx, cy) - MARGIN);

      arrow.style.left      = `${Math.round(ex)}px`;
      arrow.style.top       = `${Math.round(ey)}px`;
      arrow.style.transform = `translate(-50%,-50%) rotate(${Math.round(angle * 180 / Math.PI)}deg)`;
    }
  }

  /** Display hitmarker over center of screen */
  showHitmarker(isCrit = false, isRake = false, isKill = false) {
    if (!this._hitmarkerEl) this._hitmarkerEl = document.getElementById('hitmarker');
    if (!this._hitmarkerEl) return;
    this._hitmarkerEl.classList.remove('hidden');
    this._hitmarkerEl.classList.toggle('crit', isCrit || isRake);
    this._hitmarkerEl.classList.toggle('kill', isKill);
    clearTimeout(this._hitmarkerTimeout);
    this._hitmarkerTimeout = setTimeout(() => {
      this._hitmarkerEl?.classList.add('hidden');
    }, 180);
  }

  /** Display central cinematic kill banner with streak tracker */
  showKillBanner(ship, playerName = 'Captain') {
    if (!this._killBannerEl) this._killBannerEl = document.getElementById('kill-banner');
    if (!this._killBannerEl) return;

    const now = performance.now();
    if (now - this._lastKillTime < 18000) {
      this._streakCount++;
    } else {
      this._streakCount = 1;
    }
    this._lastKillTime = now;

    const factionName = (ship.faction || 'Enemy').replace('_', ' ');
    if (this._kbTitleEl) this._kbTitleEl.textContent = `${factionName} SHIP SUNK!`;
    if (this._kbSubEl) this._kbSubEl.textContent = `+Loot Claimed • +15% Hull Siphoned`;

    if (this._kbStreakEl) {
      if (this._streakCount >= 2) {
        let streakText = '⚡ DOUBLE SINK!';
        if (this._streakCount === 3) streakText = '🔥 TRIPLE BROADSIDE!';
        else if (this._streakCount === 4) streakText = '☠️ QUADRA CANNON!';
        else if (this._streakCount >= 5) streakText = `👑 ${this._streakCount}X UNSTOPPABLE REAPER!`;
        this._kbStreakEl.textContent = streakText;
        this._kbStreakEl.classList.remove('hidden');
      } else {
        this._kbStreakEl.classList.add('hidden');
      }
    }

    this._killBannerEl.classList.remove('hidden');
    clearTimeout(this._killBannerTimeout);
    this._killBannerTimeout = setTimeout(() => {
      this._killBannerEl?.classList.add('hidden');
    }, 2400);

    // Live Killfeed
    this.addKillFeedEntry(playerName, `${factionName} Ship`);
  }

  /** Add an entry to the top-right kill feed */
  addKillFeedEntry(killer, victim) {
    if (!this._killFeedEl) this._killFeedEl = document.getElementById('kill-feed');
    if (!this._killFeedEl) return;
    const item = document.createElement('div');
    item.className = 'kf-item';
    item.innerHTML = `<span class="kf-killer">${killer}</span> <span class="kf-icon">💣</span> <span class="kf-victim">${victim}</span>`;
    this._killFeedEl.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity 0.4s ease';
      setTimeout(() => item.remove(), 400);
    }, 4500);
  }

  // ── Overhead Health Bars for Damaged / Combat Ships ─────────────────────────

  /**
   * Render overhead health bars above ships that have taken damage or are in battle.
   * @param {import('../systems/ShipSystem.js').Ship[]} ships
   * @param {THREE.Vector3|null} playerPos
   * @param {boolean} isTeamBattle
   */
  updateShipHealthBars(ships, playerPos, isTeamBattle = false) {
    if (!this._shipBarsContainer) {
      const container = document.createElement('div');
      container.id = 'ship-overhead-bars';
      document.body.appendChild(container);
      this._shipBarsContainer = container;
      this._shipBars = new Map();
    }

    const now = performance.now();
    const activeShipIds = new Set();
    const W = window.innerWidth;
    const H = window.innerHeight;

    for (const ship of ships) {
      if (!ship || !ship.isAlive || !ship.group) continue;
      // Skip the local player's own ship — they have the main bottom-right HUD hull bar
      if (ship === window.__game?.playerShip) continue;
      // Skip co-op partner if they already have the dedicated partner marker
      if (!isTeamBattle && ship._isPartnerGhost) continue;

      const recentlyHit = ship._lastHitTime && (now - ship._lastHitTime < 8000);
      const isDamaged = ship.health < ship.maxHealth;

      // Show bar if damaged, recently hit, or in Team Battle combat range (< 120m)
      let shouldShow = isDamaged || recentlyHit;
      if (isTeamBattle && playerPos) {
        const dx = ship.group.position.x - playerPos.x;
        const dz = ship.group.position.z - playerPos.z;
        if (dx * dx + dz * dz < 12100) shouldShow = true;
      }
      if (!shouldShow) continue;

      activeShipIds.add(ship.id);

      let barData = this._shipBars.get(ship.id);
      if (!barData) {
        const el = document.createElement('div');
        el.className = 'ship-overhead-marker';
        el.innerHTML = `
          <div class="som-name"></div>
          <div class="som-hpbar">
            <div class="som-hpfill"></div>
          </div>
          <div class="som-hptext"></div>
        `;
        this._shipBarsContainer.appendChild(el);
        barData = {
          el,
          nameEl: el.querySelector('.som-name'),
          fillEl: el.querySelector('.som-hpfill'),
          textEl: el.querySelector('.som-hptext'),
        };
        this._shipBars.set(ship.id, barData);
      }

      // World to screen projection
      const worldPos = ship.group.position.clone();
      worldPos.y += (ship.shipClass?.includes('LARGE') ? 13 : 9);
      const screen = worldToScreen(worldPos, this._camera, this._canvas);

      const onScreen = screen.x > 30 && screen.x < W - 30 &&
                       screen.y > 30 && screen.y < H - 30;

      if (!onScreen) {
        barData.el.classList.add('hidden');
        continue;
      }

      barData.el.classList.remove('hidden');
      barData.el.style.left = `${Math.round(screen.x)}px`;
      barData.el.style.top  = `${Math.round(screen.y)}px`;

      // HP calculation
      const hp = Math.max(0, ship.health);
      const mhp = Math.max(1, ship.maxHealth || 100);
      const pct = Math.min(1, Math.max(0, hp / mhp));

      barData.fillEl.style.width = `${(pct * 100).toFixed(0)}%`;

      // Team battle styling or faction styling
      if (ship.team) {
        const localTeam = window.__game?.playerShip?.team || 'CRIMSON';
        const isAlly = ship.team === localTeam;
        const isCrimson = ship.team === 'CRIMSON';
        barData.el.className = `ship-overhead-marker ${isCrimson ? 'team-crimson' : 'team-blacktide'}`;

        const badge = isAlly
          ? `<span class="som-badge-tag ally">ALLY</span>`
          : `<span class="som-badge-tag enemy">ENEMY</span>`;

        let captainName = ship.playerName || ship.name;
        if (!captainName && window.__game?.teamBattle?.participants) {
          const part = window.__game.teamBattle.participants.find(p => p.ship === ship || (ship.participantId && p.id === ship.participantId));
          if (part) {
            captainName = part.name;
            ship.playerName = part.name;
            if (part.isBot !== undefined) ship.isBot = part.isBot;
          }
        }

        let displayName = '';
        if (captainName) {
          const isBot = ship.isBot || captainName.includes('[BOT]') || captainName.includes('[AI]');
          const icon = isCrimson ? '🔴' : '🔵';
          const symbol = isBot ? '🤖' : '👑';
          displayName = `${icon} ${symbol} ${captainName}`;
        } else {
          displayName = isCrimson ? '🔴 Crimson Corsair' : '🔵 Black Tide Raider';
        }

        barData.nameEl.className = `som-name ${isAlly ? 'ally' : 'enemy'}`;
        barData.nameEl.innerHTML = `${badge}${displayName}`;
        barData.fillEl.style.background = isAlly
          ? (pct > 0.5 ? '#36d399' : pct > 0.25 ? '#ffb300' : '#ff3d00')
          : (isCrimson ? '#ff3b3b' : '#3895e6');
      } else {
        const fac = (ship.faction || 'ENEMY').replace('_', ' ');
        barData.nameEl.textContent = `☠️ ${fac} Ship`;
        barData.fillEl.style.background = pct > 0.5 ? '#00e676' : pct > 0.25 ? '#ffb300' : '#ff3d00';
      }

      barData.textEl.textContent = `${Math.ceil(hp)} / ${mhp}`;
    }

    // Hide and prune bars for inactive/sunk ships
    for (const [id, barData] of this._shipBars) {
      if (!activeShipIds.has(id)) {
        barData.el.classList.add('hidden');
      }
    }
  }

  // ── Team Battle In-Game HUD ──────────────────────────────────────────────────

  /**
   * Update the pirate-themed Team Battle top HUD elements.
   */
  updateTeamBattleHUD(state) {
    let hudEl = document.getElementById('teambattle-hud');
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'teambattle-hud';
      hudEl.className = 'tb-hud';
      hudEl.innerHTML = `
        <div class="tb-top-bar">
          <!-- Crimson Corsairs Island Fortress -->
          <div class="tb-fort-card crimson">
            <div class="tb-fort-header">
              <span class="tb-fort-flag">🔴</span>
              <span class="tb-fort-name">CRIMSON FORTRESS</span>
            </div>
            <div class="tb-fort-track">
              <div class="tb-fort-fill" id="tb-fill-a"></div>
            </div>
            <div class="tb-fort-hp" id="tb-hp-a">1000 / 1000</div>
          </div>

          <!-- Central Flag & Match Info -->
          <div class="tb-center-card">
            <div class="tb-timer" id="tb-timer">08:00</div>
            <div class="tb-flag-banner" id="tb-flag-status">
              <span class="tb-flag-icon">🚩</span>
              <span class="tb-flag-label" id="tb-flag-label">FLAG: NEUTRAL</span>
            </div>
            <div class="tb-flag-track">
              <div class="tb-flag-fill" id="tb-flag-fill" style="width: 50%;"></div>
            </div>
            <div class="tb-scores">
              <span class="tb-score-a" id="tb-score-a">CC: 0</span>
              <span class="tb-score-sep">⚔️</span>
              <span class="tb-score-b" id="tb-score-b">BTR: 0</span>
            </div>
          </div>

          <!-- Black Tide Raiders Island Fortress -->
          <div class="tb-fort-card blacktide">
            <div class="tb-fort-header">
              <span class="tb-fort-flag">🔵</span>
              <span class="tb-fort-name">BLACK TIDE FORTRESS</span>
            </div>
            <div class="tb-fort-track">
              <div class="tb-fort-fill" id="tb-fill-b"></div>
            </div>
            <div class="tb-fort-hp" id="tb-hp-b">1000 / 1000</div>
          </div>
        </div>
      `;
      document.body.appendChild(hudEl);
    }

    hudEl.classList.remove('hidden');

    // Update Fortress A (Crimson)
    const pctA = Math.max(0, state.islandHpA / state.maxIslandHp);
    const fillA = document.getElementById('tb-fill-a');
    const hpA = document.getElementById('tb-hp-a');
    const cardA = hudEl.querySelector('.tb-fort-card.crimson');
    if (fillA) fillA.style.width = `${(pctA * 100).toFixed(0)}%`;
    if (hpA) hpA.textContent = `${Math.ceil(state.islandHpA)} / ${state.maxIslandHp}`;
    if (cardA) cardA.classList.toggle('critical', state.islandHpA <= 300);

    // Update Fortress B (Black Tide)
    const pctB = Math.max(0, state.islandHpB / state.maxIslandHp);
    const fillB = document.getElementById('tb-fill-b');
    const hpB = document.getElementById('tb-hp-b');
    const cardB = hudEl.querySelector('.tb-fort-card.blacktide');
    if (fillB) fillB.style.width = `${(pctB * 100).toFixed(0)}%`;
    if (hpB) hpB.textContent = `${Math.ceil(state.islandHpB)} / ${state.maxIslandHp}`;
    if (cardB) cardB.classList.toggle('critical', state.islandHpB <= 300);

    // Update Timer
    const mins = Math.floor(state.timeRemaining / 60);
    const secs = Math.floor(state.timeRemaining % 60);
    const timerEl = document.getElementById('tb-timer');
    if (timerEl) timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    // Update Scores
    const scA = document.getElementById('tb-score-a');
    const scB = document.getElementById('tb-score-b');
    if (scA) scA.textContent = `CC: ${state.scoreA}`;
    if (scB) scB.textContent = `BTR: ${state.scoreB}`;

    // Update Flag status & progress
    const flagLabel = document.getElementById('tb-flag-label');
    const flagFill = document.getElementById('tb-flag-fill');

    if (flagLabel) {
      if (state.isContested) {
        flagLabel.textContent = '⚔️ CONTESTED!';
        flagLabel.style.color = '#ffaa00';
      } else if (state.flagOwner === 'CRIMSON') {
        flagLabel.textContent = '🔴 CRIMSON HELD';
        flagLabel.style.color = '#ff6b6b';
      } else if (state.flagOwner === 'BLACK_TIDE') {
        flagLabel.textContent = '🔵 BLACK TIDE HELD';
        flagLabel.style.color = '#5cb8ff';
      } else {
        flagLabel.textContent = '🚩 NEUTRAL FLAG';
        flagLabel.style.color = '#d8c49a';
      }
    }

    if (flagFill) {
      // Map progress [-100..+100] to [0%..100%]
      // 0% = full Black Tide, 50% = Neutral, 100% = full Crimson
      const normalized = (state.flagProgress + 100) / 2;
      flagFill.style.width = `${normalized.toFixed(0)}%`;
      if (state.flagProgress > 5) flagFill.style.background = '#8e3434';
      else if (state.flagProgress < -5) flagFill.style.background = '#142b3a';
      else flagFill.style.background = '#d8c49a';
    }
  }

  hideTeamBattleHUD() {
    const hudEl = document.getElementById('teambattle-hud');
    if (hudEl) hudEl.classList.add('hidden');
    const announceEl = document.getElementById('tb-announcement');
    if (announceEl) announceEl.remove();
    this.hideRespawnCountdown();
  }

  // ── Respawn Countdown UI ──────────────────────────────────────────────────

  _initRespawnOverlay() {
    let overlay = document.getElementById('respawn-countdown-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'respawn-countdown-overlay';
      overlay.className = 'respawn-overlay hidden';
      overlay.innerHTML = `
        <div class="respawn-card">
          <div class="respawn-skull">☠</div>
          <h2 class="respawn-title">SHIP DESTROYED</h2>
          <p class="respawn-sub">Your vessel has been sunk to the depths.</p>
          <div class="respawn-badge">RESPAWNING IN</div>
          <div class="respawn-counter" id="respawn-timer-num">8</div>
          <div class="respawn-ready-banner hidden" id="respawn-ready-txt">⚔️ YOUR SHIP IS READY</div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    this._respawnOverlay = overlay;
  }

  /**
   * Display prominent respawn countdown overlay when player's ship sinks.
   * @param {number} [initialSeconds=8]
   */
  showRespawnCountdown(initialSeconds = 8) {
    if (!this._respawnOverlay) this._initRespawnOverlay();
    const overlay = this._respawnOverlay;
    const numEl = document.getElementById('respawn-timer-num');
    const readyEl = document.getElementById('respawn-ready-txt');

    if (numEl) {
      numEl.textContent = Math.max(1, Math.ceil(initialSeconds));
      numEl.style.display = 'block';
    }
    if (readyEl) readyEl.classList.add('hidden');

    overlay.classList.remove('hidden');
  }

  /**
   * Update countdown numbers directly from authoritative respawn queue timer.
   * @param {number} remainingSeconds
   */
  updateRespawnCountdown(remainingSeconds) {
    if (!this._respawnOverlay || this._respawnOverlay.classList.contains('hidden')) {
      if (remainingSeconds > 0) this.showRespawnCountdown(remainingSeconds);
      else return;
    }

    const numEl = document.getElementById('respawn-timer-num');
    const readyEl = document.getElementById('respawn-ready-txt');
    const safeSecs = Math.max(0, Math.ceil(remainingSeconds));

    if (safeSecs > 0) {
      if (numEl) {
        numEl.textContent = safeSecs;
        numEl.style.display = 'block';
      }
      if (readyEl) readyEl.classList.add('hidden');
    } else {
      if (numEl) numEl.style.display = 'none';
      if (readyEl) readyEl.classList.remove('hidden');
    }
  }

  /**
   * Hide respawn countdown overlay once player respawns or match ends.
   */
  hideRespawnCountdown() {
    if (this._respawnOverlay) {
      this._respawnOverlay.classList.add('hidden');
    }
  }

  /**
   * Pirate-themed central battle announcement banner.
   */
  showTeamBattleAnnouncement(text, type = 'gold') {
    let el = document.getElementById('tb-announcement');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tb-announcement';
      el.className = 'tb-announcement';
      document.body.appendChild(el);
    }
    el.className = `tb-announcement ${type}`;
    el.textContent = text;
    el.classList.remove('hidden');

    clearTimeout(this._announcementTimeout);
    this._announcementTimeout = setTimeout(() => {
      el?.classList.add('hidden');
    }, 3200);
  }

  /**
   * Victory Modal for Team Battle.
   */
  showTeamBattleVictory(result) {
    let modal = document.getElementById('tb-victory-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'tb-victory-modal';
      modal.className = 'tb-victory-modal';
      document.body.appendChild(modal);
    }

    const isCrimson = result.winningTeam === 'CRIMSON';
    const isBlackTide = result.winningTeam === 'BLACK_TIDE';
    const title = isCrimson ? '🔴 CRIMSON CORSAIRS VICTORY!'
      : isBlackTide ? '🔵 BLACK TIDE RAIDERS VICTORY!' : '⚖️ HONOURABLE DRAW!';

    modal.innerHTML = `
      <div class="tb-victory-card">
        <div class="tb-vic-skull">☠</div>
        <h2 class="tb-vic-title">${title}</h2>
        <p class="tb-vic-reason">${result.reason}</p>

        <div class="tb-vic-stats">
          <div class="tb-vic-stat-col crimson">
            <span class="tb-vic-team-name">Crimson Corsairs</span>
            <div class="tb-vic-stat-val">Score: ${result.scoreA}</div>
            <div class="tb-vic-stat-val">Fortress HP: ${Math.ceil(result.islandHpA)} / 1000</div>
          </div>
          <div class="tb-vic-vs">VS</div>
          <div class="tb-vic-stat-col blacktide">
            <span class="tb-vic-team-name">Black Tide Raiders</span>
            <div class="tb-vic-stat-val">Score: ${result.scoreB}</div>
            <div class="tb-vic-stat-val">Fortress HP: ${Math.ceil(result.islandHpB)} / 1000</div>
          </div>
        </div>

        <div class="tb-vic-actions">
          <button class="mm-btn mm-btn-play" id="tb-btn-rematch" data-testid="tb-rematch-btn">⚔️ &nbsp;Rematch</button>
          <button class="mm-btn" id="tb-btn-menu">⚓ &nbsp;Return to Menu</button>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');

    const rematchBtn = document.getElementById('tb-btn-rematch') || document.getElementById('tb-rematch-btn');
    rematchBtn?.addEventListener('click', () => {
      modal.classList.add('hidden');
      window.__game?.startTeamBattleRematch?.();
    });

    document.getElementById('tb-btn-menu')?.addEventListener('click', () => {
      modal.classList.add('hidden');
      window.__game?.returnToMainMenu?.();
    });
  }

  update(_delta) { /* event-driven */ }
}

export default HUD;
