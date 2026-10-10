/**
 * TeamBattleLobbyUI — Pirate-Themed Competitive Lobby & Room Management
 *
 * Provides:
 *   - 2v2 / 4v4 / Solo Test mode selector
 *   - Host Game / Join Game with unique room code and 1-click clipboard copy
 *   - Team Rosters: Crimson Corsairs vs Black Tide Raiders
 *   - Team switching & player readiness
 *   - Bot-fill option so user can test and play immediately alone or with friends
 *   - Clear state feedback & start game triggers
 */

import EventEmitter from '../utils/EventEmitter.js';

export class TeamBattleLobbyUI {
  /**
   * @param {import('../main.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.panelEl = null;
    this.isOpen = false;

    this.selectedMode = '2v2'; // '2v2' | '4v4' | 'TEST'
    this.activeTab = 'host';   // 'host' | 'join'
    this.isReady = false;
    this.localTeam = 'CRIMSON';
    this.botFill = true;

    this._createDOM();
  }

  _createDOM() {
    const existing = document.getElementById('tb-lobby-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'tb-lobby-panel';
    panel.className = 'mm-panel tb-lobby-modal hidden';
    panel.innerHTML = `
      <button class="mm-panel-close" id="tb-lobby-close">✕</button>
      <div class="tb-lobby-header">
        <div class="tb-lobby-skull">☠</div>
        <h2 class="mm-panel-title">PIRATE TEAM BATTLE</h2>
        <p class="coop-subtitle">Symmetrical Naval Warfare • Defend Fortress • Claim Central Flag</p>
      </div>

      <!-- Mode Selector -->
      <div class="tb-mode-selector">
        <button class="tb-mode-btn active" data-mode="2v2">⚔️ 2v2 Battle (4 Ships)</button>
        <button class="tb-mode-btn" data-mode="4v4">🏴‍☠️ 4v4 Fleet War (8 Ships)</button>
        <button class="tb-mode-btn" data-mode="TEST">🎯 Solo Test Match (with Bots)</button>
      </div>

      <!-- Host / Join Tabs -->
      <div class="coop-mode-tabs">
        <button class="coop-tab active" id="tb-tab-host">⚓ Host Battle</button>
        <button class="coop-tab" id="tb-tab-join">🔗 Join Battle</button>
      </div>

      <!-- Host Pane -->
      <div class="coop-pane" id="tb-pane-host">
        <p class="coop-hint">Share this battle code with fellow captains:</p>
        <div class="tb-code-box">
          <div class="coop-code-display" id="tb-room-code">------</div>
          <button class="tb-copy-btn" id="tb-copy-code" title="Copy 1-click invite link">📋 Copy Link</button>
        </div>
        <div class="coop-status" id="tb-host-status">Click Host to generate code</div>
      </div>

      <!-- Join Pane -->
      <div class="coop-pane hidden" id="tb-pane-join">
        <p class="coop-hint">Enter the Admiral's 6-character room code:</p>
        <div class="tb-join-row">
          <input class="coop-code-input" id="tb-join-input" type="text"
                 placeholder="e.g. PX7K2M" maxlength="6" autocomplete="off" spellcheck="false" />
          <button class="mm-btn mm-btn-play" id="tb-join-btn">🔗 &nbsp;Join Fleet</button>
        </div>
        <div class="coop-status" id="tb-join-status"></div>
      </div>

      <!-- Team Rosters Section -->
      <div class="tb-rosters-container">
        <!-- Team A: Crimson Corsairs -->
        <div class="tb-team-column crimson">
          <div class="tb-team-header">
            <span class="tb-team-icon">🔴</span>
            <div class="tb-team-titles">
              <span class="tb-team-title">CRIMSON CORSAIRS</span>
              <span class="tb-team-sub">West Fortress Base</span>
            </div>
            <button class="tb-switch-btn" id="tb-join-crimson">Join Team</button>
          </div>
          <div class="tb-player-list" id="tb-list-crimson">
            <!-- Player cards injected here -->
          </div>
        </div>

        <!-- VS Divider -->
        <div class="tb-roster-vs">
          <span>VS</span>
        </div>

        <!-- Team B: Black Tide Raiders -->
        <div class="tb-team-column blacktide">
          <div class="tb-team-header">
            <span class="tb-team-icon">🔵</span>
            <div class="tb-team-titles">
              <span class="tb-team-title">BLACK TIDE RAIDERS</span>
              <span class="tb-team-sub">East Fortress Base</span>
            </div>
            <button class="tb-switch-btn" id="tb-join-blacktide">Join Team</button>
          </div>
          <div class="tb-player-list" id="tb-list-blacktide">
            <!-- Player cards injected here -->
          </div>
        </div>
      </div>

      <!-- Lobby Controls & Options Footer -->
      <div class="tb-lobby-footer">
        <div class="tb-footer-left">
          <label class="tb-bot-toggle" id="tb-bot-label">
            <input type="checkbox" id="tb-bot-checkbox" checked />
            <span>🤖 Fill Empty Slots with AI Warships</span>
          </label>
        </div>
        <div class="tb-footer-right">
          <button class="mm-btn tb-ready-btn" id="tb-btn-ready">⚓ &nbsp;Ready Up</button>
          <button class="mm-btn mm-btn-play tb-start-btn" id="tb-btn-start">⚔️ &nbsp;Set Sail for Battle!</button>
        </div>
      </div>
    `;

    document.getElementById('main-menu')?.appendChild(panel);
    this.panelEl = panel;
    this._bindEvents();
  }

  _bindEvents() {
    // Close button
    document.getElementById('tb-lobby-close')?.addEventListener('click', () => {
      this.hide();
    });

    // Mode Selector Buttons
    this.panelEl.querySelectorAll('.tb-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.panelEl.querySelectorAll('.tb-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedMode = btn.dataset.mode;
        this.renderRosters();
      });
    });

    // Tab buttons
    const tabHost = document.getElementById('tb-tab-host');
    const tabJoin = document.getElementById('tb-tab-join');
    const paneHost = document.getElementById('tb-pane-host');
    const paneJoin = document.getElementById('tb-pane-join');

    tabHost?.addEventListener('click', () => {
      tabHost.classList.add('active');
      tabJoin.classList.remove('active');
      paneHost.classList.remove('hidden');
      paneJoin.classList.add('hidden');
      this.activeTab = 'host';
    });

    tabJoin?.addEventListener('click', () => {
      tabJoin.classList.add('active');
      tabHost.classList.remove('active');
      paneJoin.classList.remove('hidden');
      paneHost.classList.add('hidden');
      this.activeTab = 'join';
    });

    // Copy Code / 1-Click Invite Link button
    document.getElementById('tb-copy-code')?.addEventListener('click', () => {
      const code = document.getElementById('tb-room-code')?.textContent?.trim();
      if (code && code !== '------') {
        const fullUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
        const copyPromise = (navigator.clipboard && navigator.clipboard.writeText)
          ? navigator.clipboard.writeText(fullUrl)
          : Promise.reject(new Error('No clipboard API'));

        copyPromise.then(() => {
          const btn = document.getElementById('tb-copy-code');
          if (btn) {
            btn.textContent = '✅ Link Copied!';
            setTimeout(() => { btn.textContent = '📋 Copy Link'; }, 2000);
          }
        }).catch(() => {
          // Fallback: copy code text directly
          navigator.clipboard?.writeText?.(code);
          const btn = document.getElementById('tb-copy-code');
          if (btn) {
            btn.textContent = '✅ Code Copied!';
            setTimeout(() => { btn.textContent = '📋 Copy Link'; }, 2000);
          }
        });
      }
    });

    // Join button
    document.getElementById('tb-join-btn')?.addEventListener('click', () => {
      const input = document.getElementById('tb-join-input');
      const code = input?.value.trim().toUpperCase();
      if (!code || code.length !== 6) {
        const st = document.getElementById('tb-join-status');
        if (st) st.textContent = '❌ Room code must be 6 letters/numbers';
        return;
      }
      this.game.joinTeamBattleRoom?.(code);
    });

    // Team switch buttons
    document.getElementById('tb-join-crimson')?.addEventListener('click', () => {
      this.localTeam = 'CRIMSON';
      this.game.switchTeamBattleTeam?.('CRIMSON');
      this.renderRosters();
    });

    document.getElementById('tb-join-blacktide')?.addEventListener('click', () => {
      this.localTeam = 'BLACK_TIDE';
      this.game.switchTeamBattleTeam?.('BLACK_TIDE');
      this.renderRosters();
    });

    // Bot toggle
    document.getElementById('tb-bot-checkbox')?.addEventListener('change', (e) => {
      this.botFill = e.target.checked;
      this.renderRosters();
    });

    // Ready button
    document.getElementById('tb-btn-ready')?.addEventListener('click', () => {
      this.isReady = !this.isReady;
      const btn = document.getElementById('tb-btn-ready');
      if (btn) {
        btn.textContent = this.isReady ? '✅ Ready!' : '⚓ Ready Up';
        btn.classList.toggle('ready-active', this.isReady);
      }
      this.renderRosters();
    });

    // Start battle button
    document.getElementById('tb-btn-start')?.addEventListener('click', () => {
      this.game.startTeamBattleMatch?.(this.selectedMode, this.botFill);
    });
  }

  show() {
    this.isOpen = true;
    this.panelEl?.classList.remove('hidden');
    this.renderRosters();
  }

  open() {
    this.show();
  }

  hide() {
    this.isOpen = false;
    this.panelEl?.classList.add('hidden');
  }

  close() {
    this.hide();
  }

  setRoomCode(code) {
    const codeEl = document.getElementById('tb-room-code');
    if (codeEl) codeEl.textContent = code;
  }

  setHostStatus(msg, isError = false) {
    const st = document.getElementById('tb-host-status');
    if (st) {
      st.textContent = msg;
      st.className = `coop-status ${isError ? 'error' : 'success'}`;
    }
  }

  setJoinStatus(msg, isError = false) {
    const st = document.getElementById('tb-join-status');
    if (st) {
      st.textContent = msg;
      st.className = `coop-status ${isError ? 'error' : 'success'}`;
    }
  }

  /**
   * Render the team player cards for both Crimson Corsairs and Black Tide Raiders.
   */
  renderRosters() {
    const listCrimson = document.getElementById('tb-list-crimson');
    const listBlackTide = document.getElementById('tb-list-blacktide');
    if (!listCrimson || !listBlackTide) return;

    listCrimson.innerHTML = '';
    listBlackTide.innerHTML = '';

    const maxSlots = this.selectedMode === '4v4' ? 4 : this.selectedMode === 'TEST' ? 1 : 2;
    const playerName = this.game.playerName || 'Captain Jack';

    // Local player card
    const localPlayerCard = `
      <div class="tb-player-card local ${this.localTeam.toLowerCase()}">
        <div class="tb-pc-avatar">👑</div>
        <div class="tb-pc-info">
          <span class="tb-pc-name">${playerName} (You)</span>
          <span class="tb-pc-ship">War Sloop • Flagship</span>
        </div>
        <span class="tb-pc-badge ${this.isReady ? 'ready' : ''}">${this.isReady ? 'READY' : 'PREPARING'}</span>
      </div>
    `;

    if (this.localTeam === 'CRIMSON') {
      listCrimson.innerHTML += localPlayerCard;
    } else {
      listBlackTide.innerHTML += localPlayerCard;
    }

    // Multiplayer partner card if connected
    if (this.game.mp?.connected) {
      const partnerName = this.game.mp.partnerName || 'First Mate';
      const partnerTeam = this.localTeam === 'CRIMSON' ? 'BLACK_TIDE' : 'CRIMSON';
      const partnerCard = `
        <div class="tb-player-card partner ${partnerTeam.toLowerCase()}">
          <div class="tb-pc-avatar">🤝</div>
          <div class="tb-pc-info">
            <span class="tb-pc-name">${partnerName}</span>
            <span class="tb-pc-ship">War Brigantine</span>
          </div>
          <span class="tb-pc-badge ready">READY</span>
        </div>
      `;
      if (partnerTeam === 'CRIMSON') listCrimson.innerHTML += partnerCard;
      else listBlackTide.innerHTML += partnerCard;
    }

    // Fill slots with AI bots if enabled
    const crimsonCount = this.localTeam === 'CRIMSON' ? 1 : (this.game.mp?.connected ? 1 : 0);
    const blackTideCount = this.localTeam === 'BLACK_TIDE' ? 1 : (this.game.mp?.connected ? 1 : 0);

    const botPool = [
      'Anne Bonny', 'Blackbeard', 'Calico Jack', 'Bartholomew',
      'Mary Read', 'Henry Morgan', 'Edward Low', 'Grace O\'Malley'
    ];

    let bIdx = 0;
    for (let i = crimsonCount; i < maxSlots; i++) {
      if (this.botFill) {
        listCrimson.innerHTML += `
          <div class="tb-player-card bot crimson">
            <div class="tb-pc-avatar">🤖</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">[BOT] ${botPool[bIdx % botPool.length]}</span>
              <span class="tb-pc-ship">Corsair Escort</span>
            </div>
            <span class="tb-pc-badge ready">AI READY</span>
          </div>
        `;
        bIdx++;
      } else {
        listCrimson.innerHTML += `
          <div class="tb-player-card empty">
            <div class="tb-pc-avatar">⏳</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">Empty Slot</span>
              <span class="tb-pc-ship">Waiting for captain...</span>
            </div>
            <span class="tb-pc-badge empty">OPEN</span>
          </div>
        `;
      }
    }

    for (let i = blackTideCount; i < maxSlots; i++) {
      if (this.botFill) {
        listBlackTide.innerHTML += `
          <div class="tb-player-card bot blacktide">
            <div class="tb-pc-avatar">🤖</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">[BOT] ${botPool[bIdx % botPool.length]}</span>
              <span class="tb-pc-ship">Raider Escort</span>
            </div>
            <span class="tb-pc-badge ready">AI READY</span>
          </div>
        `;
        bIdx++;
      } else {
        listBlackTide.innerHTML += `
          <div class="tb-player-card empty">
            <div class="tb-pc-avatar">⏳</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">Empty Slot</span>
              <span class="tb-pc-ship">Waiting for captain...</span>
            </div>
            <span class="tb-pc-badge empty">OPEN</span>
          </div>
        `;
      }
    }
  }
}

export default TeamBattleLobbyUI;
