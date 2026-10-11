/**
 * TeamBattleLobbyUI — Pirate Empire Fleet Command & Waiting Lobby
 *
 * Provides:
 *   1. Fleet Command Screen:
 *      - Public Fleet: Find Public Match, Host Public Fleet, Play with AI
 *      - Private Fleet: Host Private Fleet, Join with Room Code
 *   2. Dedicated Waiting Lobby:
 *      - Synchronized room code, public/private tag, real player count
 *      - Real connected player names, host badges, and open/bot slots
 *      - Host controls: Start Battle, Fill with AI toggle, Copy Link, Leave
 *      - Client controls: Live connection status, Copy Link, Leave
 *   3. Matchmaking Search & Status Feedback:
 *      - Live feedback during search with honest no-room / failure states
 *      - Deliberate choice to host or play with AI
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

    // View state: 'COMMAND' | 'SEARCHING' | 'WAITING'
    this.currentView = 'COMMAND';

    // Match configuration
    this.selectedMode = '2v2'; // '2v2' | '4v4' | 'TEST'
    this.isPublic = true;
    this.isHost = true;
    this.isReady = false;
    this.localTeam = 'CRIMSON';
    this.botFill = true;
    this.roomCode = '------';

    // Authoritative lobby data received from host (if client)
    this.remoteLobbyData = null;

    this._createDOM();
  }

  _createDOM() {
    const existing = document.getElementById('tb-lobby-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'tb-lobby-panel';
    panel.className = 'mm-panel tb-fleet-modal hidden';
    panel.innerHTML = `
      <button class="mm-panel-close" id="tb-lobby-close" title="Close">✕</button>

      <!-- ═══════════════════════════════════════════════════════════
           STAGE 1: FLEET COMMAND SELECTION VIEW
      ═══════════════════════════════════════════════════════════════ -->
      <div id="tb-view-command" class="tb-view-section">
        <div class="tb-lobby-header">
          <div class="tb-lobby-skull">☠</div>
          <h2 class="mm-panel-title">FLEET COMMAND</h2>
          <p class="coop-subtitle">Choose how you want to sail the high seas.</p>
        </div>

        <div class="fleet-command-grid">
          <!-- Option A: PUBLIC FLEET -->
          <div class="fleet-card public-fleet-card">
            <div class="fleet-card-icon">🌐</div>
            <h3 class="fleet-card-title">PUBLIC FLEET</h3>
            <p class="fleet-card-desc">Find captains online across the high seas, or host a public fleet and await challengers.</p>
            
            <div class="fleet-card-actions">
              <button class="mm-btn mm-btn-play fleet-btn" id="fc-btn-find-public">
                🔍 &nbsp;Find Public Match
              </button>
              <button class="mm-btn fleet-btn" id="fc-btn-host-public">
                ⚓ &nbsp;Host Public Fleet
              </button>
              <button class="mm-btn fleet-btn btn-subtle" id="fc-btn-ai-play">
                🤖 &nbsp;Play with AI (2v2)
              </button>
            </div>
          </div>

          <!-- Option B: PRIVATE FLEET -->
          <div class="fleet-card private-fleet-card">
            <div class="fleet-card-icon">🔒</div>
            <h3 class="fleet-card-title">PRIVATE FLEET</h3>
            <p class="fleet-card-desc">Sail with friends using secret 6-character room codes or shareable direct invite links.</p>

            <div class="fleet-card-actions">
              <button class="mm-btn fleet-btn" id="fc-btn-host-private">
                ⚓ &nbsp;Host Private Fleet
              </button>

              <div class="fc-join-row">
                <input class="coop-code-input fc-code-input" id="fc-join-input" type="text"
                       placeholder="ROOM CODE" maxlength="6" autocomplete="off" spellcheck="false" />
                <button class="mm-btn fleet-btn" id="fc-btn-join-private">🔗 Join</button>
              </div>
              <div class="coop-status hidden" id="fc-join-status"></div>
            </div>
          </div>
        </div>

        <div class="fleet-command-footer">
          <button class="mm-btn btn-back" id="fc-btn-back">⚓ Back to Main Menu</button>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           STAGE 2: MATCHMAKING SEARCH STATUS VIEW
      ═══════════════════════════════════════════════════════════════ -->
      <div id="tb-view-searching" class="tb-view-section hidden">
        <div class="tb-lobby-header">
          <div class="tb-lobby-skull">🧭</div>
          <h2 class="mm-panel-title">SEEKING FLEET</h2>
          <p class="coop-subtitle" id="fc-search-sub">Scanning registry for open public battles...</p>
        </div>

        <div class="fc-search-box">
          <div class="fc-search-spinner" id="fc-search-spinner">
            <div class="fc-compass-needle"></div>
          </div>
          <div class="fc-search-status-text" id="fc-search-status-text">Searching for active battle fleets...</div>
          
          <div class="fc-search-controls" id="fc-search-controls">
            <button class="mm-btn btn-back" id="fc-search-cancel">Cancel Search</button>
          </div>

          <!-- Prompt displayed when no public rooms are found -->
          <div class="fc-no-rooms-card hidden" id="fc-no-rooms-card">
            <p class="fc-no-rooms-msg">No captains are currently waiting in public waters.</p>
            <div class="fc-no-rooms-actions">
              <button class="mm-btn mm-btn-play" id="fc-btn-no-rooms-host">⚓ &nbsp;Host Public Fleet</button>
              <button class="mm-btn" id="fc-btn-no-rooms-ai">🤖 &nbsp;Play with AI Instead</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           STAGE 3: WAITING LOBBY VIEW (SYNCHRONIZED ROSTER)
      ═══════════════════════════════════════════════════════════════ -->
      <div id="tb-view-waiting" class="tb-view-section hidden">
        <div class="tb-lobby-header">
          <div class="tb-lobby-skull">☠</div>
          <h2 class="mm-panel-title">FLEET LOBBY</h2>
          <div class="lobby-meta-bar">
            <span class="lobby-badge" id="tb-visibility-badge">🌐 PUBLIC FLEET</span>
            <div class="tb-code-box">
              <span class="tb-code-lbl">ROOM:</span>
              <span class="coop-code-display" id="tb-room-code">------</span>
              <button class="tb-copy-btn" id="tb-copy-code" title="Copy 1-click invite link">📋 Copy Link</button>
            </div>
          </div>
          <div class="coop-status" id="tb-lobby-status">⚓ Waiting for captains to assemble...</div>
        </div>

        <!-- Mode Selector (Host only) -->
        <div class="tb-mode-selector" id="tb-mode-selector">
          <button class="tb-mode-btn active" data-mode="2v2">⚔️ 2v2 Battle (4 Ships)</button>
          <button class="tb-mode-btn" data-mode="4v4">🏴‍☠️ 4v4 Fleet War (8 Ships)</button>
          <button class="tb-mode-btn" data-mode="TEST">🎯 Solo Test Match</button>
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
              <span>🤖 Fill Empty Positions with AI Warships</span>
            </label>
            <div class="tb-player-count-indicator" id="tb-player-count">Players: 1 / 4</div>
          </div>
          <div class="tb-footer-right">
            <button class="mm-btn btn-back" id="tb-btn-leave-lobby">✕ &nbsp;Leave Fleet</button>
            <button class="mm-btn mm-btn-play tb-start-btn" id="tb-btn-start">⚔️ &nbsp;Set Sail for Battle!</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('main-menu')?.appendChild(panel);
    this.panelEl = panel;
    this._bindEvents();
  }

  _bindEvents() {
    // ── Global Close & Back ──────────────────────────────────────────────────
    document.getElementById('tb-lobby-close')?.addEventListener('click', () => {
      this.handleLeaveOrClose();
    });

    document.getElementById('fc-btn-back')?.addEventListener('click', () => {
      this.hide();
    });

    document.getElementById('tb-btn-leave-lobby')?.addEventListener('click', () => {
      this.handleLeaveOrClose();
    });

    // ── Fleet Command Actions ────────────────────────────────────────────────
    // 1. Find Public Match
    document.getElementById('fc-btn-find-public')?.addEventListener('click', () => {
      this.startFindPublicMatch();
    });

    // 2. Host Public Fleet
    document.getElementById('fc-btn-host-public')?.addEventListener('click', () => {
      this.startHostPublicFleet();
    });

    // 3. Play with AI
    document.getElementById('fc-btn-ai-play')?.addEventListener('click', () => {
      this.hide();
      this.game.startTeamBattleMatch?.('2v2', true);
    });

    // 4. Host Private Fleet
    document.getElementById('fc-btn-host-private')?.addEventListener('click', () => {
      this.startHostPrivateFleet();
    });

    // 5. Join Private Fleet with Code
    document.getElementById('fc-btn-join-private')?.addEventListener('click', () => {
      const code = document.getElementById('fc-join-input')?.value?.trim().toUpperCase();
      if (!code || code.length !== 6) {
        this.setJoinStatus('❌ Enter a 6-character room code', true);
        return;
      }
      this.startJoinPrivateFleet(code);
    });

    // ── Search View Controls ────────────────────────────────────────────────
    document.getElementById('fc-search-cancel')?.addEventListener('click', () => {
      this.game.matchmaking?.cancel();
      this.showView('COMMAND');
    });

    document.getElementById('fc-btn-no-rooms-host')?.addEventListener('click', () => {
      this.startHostPublicFleet();
    });

    document.getElementById('fc-btn-no-rooms-ai')?.addEventListener('click', () => {
      this.hide();
      this.game.startTeamBattleMatch?.('2v2', true);
    });

    // ── Waiting Lobby Controls ──────────────────────────────────────────────
    // Copy Code / Link
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
          navigator.clipboard?.writeText?.(code);
          const btn = document.getElementById('tb-copy-code');
          if (btn) {
            btn.textContent = '✅ Code Copied!';
            setTimeout(() => { btn.textContent = '📋 Copy Link'; }, 2000);
          }
        });
      }
    });

    // Mode Selector
    this.panelEl.querySelectorAll('.tb-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.isHost) return; // Only host chooses mode
        this.panelEl.querySelectorAll('.tb-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedMode = btn.dataset.mode;
        this.broadcastLobbySync();
        this.renderRosters();
      });
    });

    // Team Switch buttons
    document.getElementById('tb-join-crimson')?.addEventListener('click', () => {
      this.localTeam = 'CRIMSON';
      this.game.switchTeamBattleTeam?.('CRIMSON');
      this.broadcastLobbySync();
      this.renderRosters();
    });

    document.getElementById('tb-join-blacktide')?.addEventListener('click', () => {
      this.localTeam = 'BLACK_TIDE';
      this.game.switchTeamBattleTeam?.('BLACK_TIDE');
      this.broadcastLobbySync();
      this.renderRosters();
    });

    // Bot toggle
    document.getElementById('tb-bot-checkbox')?.addEventListener('change', (e) => {
      if (!this.isHost) return;
      this.botFill = e.target.checked;
      this.broadcastLobbySync();
      this.renderRosters();
    });

    // Start Battle (Host Only)
    document.getElementById('tb-btn-start')?.addEventListener('click', () => {
      if (!this.isHost) return;
      this.startBattleAsHost();
    });
  }

  // ── VIEW SWITCHING ────────────────────────────────────────────────────────

  showView(viewName) {
    this.currentView = viewName;
    document.getElementById('tb-view-command')?.classList.toggle('hidden', viewName !== 'COMMAND');
    document.getElementById('tb-view-searching')?.classList.toggle('hidden', viewName !== 'SEARCHING');
    document.getElementById('tb-view-waiting')?.classList.toggle('hidden', viewName !== 'WAITING');
  }

  show() {
    this.isOpen = true;
    this.panelEl?.classList.remove('hidden');
    this.showView(this.currentView || 'COMMAND');
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

  showFleetCommand(focusMode = 'ALL') {
    this.show();
    this.showView('COMMAND');
    const joinInput = document.getElementById('fc-join-input');
    if (joinInput) joinInput.value = '';
    const joinStatus = document.getElementById('fc-join-status');
    if (joinStatus) joinStatus.classList.add('hidden');
  }

  // ── MATCHMAKING ACTIONS ───────────────────────────────────────────────────

  /**
   * Action: Search for public rooms and join.
   */
  async startFindPublicMatch() {
    this.showView('SEARCHING');
    const statusText = document.getElementById('fc-search-status-text');
    const noRoomsCard = document.getElementById('fc-no-rooms-card');
    const spinner = document.getElementById('fc-search-spinner');
    if (noRoomsCard) noRoomsCard.classList.add('hidden');
    if (spinner) spinner.style.display = 'block';

    const updateStatus = (msg) => {
      if (statusText) statusText.textContent = msg;
    };

    updateStatus('🔍 Scanning registry for open public fleets...');

    try {
      const result = await this.game.matchmaking?.searchAndJoinPublicRoom((msg) => {
        updateStatus(msg);
      });

      if (result?.success) {
        // Connected to host as Client!
        this.isHost = false;
        this.isPublic = true;
        this.roomCode = result.roomCode;
        this.localTeam = 'BLACK_TIDE'; // Client defaults to opposite team
        this.showWaitingLobby(false, true, result.roomCode);
        this.setLobbyStatus(`🔗 Connected to Admiral! Waiting for battle to begin...`);
      } else if (result?.reason === 'NO_ROOMS_FOUND') {
        if (spinner) spinner.style.display = 'none';
        updateStatus('⚓ No public fleets found waiting.');
        if (noRoomsCard) noRoomsCard.classList.remove('hidden');
      } else {
        if (spinner) spinner.style.display = 'none';
        updateStatus(`❌ ${result?.error || 'Could not join fleet'}. Try hosting or search again.`);
        if (noRoomsCard) noRoomsCard.classList.remove('hidden');
      }
    } catch (err) {
      if (spinner) spinner.style.display = 'none';
      updateStatus(`❌ Network error: ${err.message}`);
      if (noRoomsCard) noRoomsCard.classList.remove('hidden');
    }
  }

  /**
   * Action: Host a public fleet room in Supabase.
   */
  async startHostPublicFleet() {
    this.showView('SEARCHING');
    const statusText = document.getElementById('fc-search-status-text');
    const spinner = document.getElementById('fc-search-spinner');
    if (spinner) spinner.style.display = 'block';
    if (statusText) statusText.textContent = '⚓ Commissioning public war fleet...';

    try {
      const result = await this.game.matchmaking?.hostRoom({ isPublic: true }, (msg) => {
        if (statusText) statusText.textContent = msg;
      });

      if (result?.success) {
        this.isHost = true;
        this.isPublic = true;
        this.roomCode = result.roomCode;
        this.localTeam = 'CRIMSON';
        this.showWaitingLobby(true, true, result.roomCode);
        this.setLobbyStatus('⚓ Fleet open to public! Waiting for captains to join...');
      } else {
        if (statusText) statusText.textContent = `❌ Hosting error: ${result?.error || 'Failed to initialize relay'}`;
      }
    } catch (err) {
      if (statusText) statusText.textContent = `❌ Error hosting: ${err.message}`;
    }
  }

  /**
   * Action: Host a private room (not listed in public registry).
   */
  async startHostPrivateFleet() {
    this.showView('SEARCHING');
    const statusText = document.getElementById('fc-search-status-text');
    const spinner = document.getElementById('fc-search-spinner');
    if (spinner) spinner.style.display = 'block';
    if (statusText) statusText.textContent = '⚓ Commissioning private war fleet...';

    try {
      const result = await this.game.matchmaking?.hostRoom({ isPublic: false }, (msg) => {
        if (statusText) statusText.textContent = msg;
      });

      if (result?.success) {
        this.isHost = true;
        this.isPublic = false;
        this.roomCode = result.roomCode;
        this.localTeam = 'CRIMSON';
        this.showWaitingLobby(true, false, result.roomCode);
        this.setLobbyStatus('🔒 Private fleet ready! Share room code or link with allies.');
      } else {
        if (statusText) statusText.textContent = `❌ Hosting error: ${result?.error || 'Failed'}`;
      }
    } catch (err) {
      if (statusText) statusText.textContent = `❌ Error: ${err.message}`;
    }
  }

  /**
   * Action: Join private room by code.
   */
  async startJoinPrivateFleet(code) {
    this.setJoinStatus('🔗 Reaching Captain...', false);
    try {
      await this.game.joinTeamBattleRoom?.(code);
      this.isHost = false;
      this.isPublic = false;
      this.roomCode = code;
      this.localTeam = 'BLACK_TIDE';
      this.showWaitingLobby(false, false, code);
      this.setLobbyStatus('🔗 Joined private fleet! Waiting for Admiral to start...');
    } catch (err) {
      this.setJoinStatus(`❌ ${err?.message || 'Connection failed'}`, true);
    }
  }

  // ── WAITING LOBBY SETUP & RENDERING ──────────────────────────────────────

  showWaitingLobby(isHost = true, isPublic = true, roomCode = '') {
    this.isHost = isHost;
    this.isPublic = isPublic;
    this.roomCode = roomCode || this.roomCode;
    this.showView('WAITING');

    // Room code and visibility badge
    const codeEl = document.getElementById('tb-room-code');
    if (codeEl) codeEl.textContent = this.roomCode;

    const badge = document.getElementById('tb-visibility-badge');
    if (badge) {
      badge.textContent = isPublic ? '🌐 PUBLIC FLEET' : '🔒 PRIVATE FLEET';
      badge.className = `lobby-badge ${isPublic ? 'public' : 'private'}`;
    }

    // Host controls vs Client view
    const startBtn = document.getElementById('tb-btn-start');
    const botLabel = document.getElementById('tb-bot-label');
    const modeSelector = document.getElementById('tb-mode-selector');

    if (startBtn) {
      startBtn.style.display = isHost ? 'inline-block' : 'none';
    }
    if (botLabel) {
      botLabel.style.display = isHost ? 'flex' : 'none';
    }
    if (modeSelector) {
      modeSelector.style.pointerEvents = isHost ? 'auto' : 'none';
      modeSelector.style.opacity = isHost ? '1.0' : '0.7';
    }

    this.renderRosters();
  }

  setLobbyStatus(msg, isError = false) {
    const el = document.getElementById('tb-lobby-status');
    if (el) {
      el.textContent = msg;
      el.className = `coop-status ${isError ? 'error' : 'success'}`;
    }
  }

  setJoinStatus(msg, isError = false) {
    const el = document.getElementById('fc-join-status');
    if (el) {
      el.textContent = msg;
      el.className = `coop-status ${isError ? 'error' : 'success'}`;
      el.classList.remove('hidden');
    }
  }

  /**
   * Synchronize current lobby state to all connected peers (Host only).
   */
  broadcastLobbySync() {
    if (!this.isHost || !this.game.mp?.connected) return;

    const participants = [
      { id: 'local_player', name: this.game.playerName || 'Admiral Jack', team: this.localTeam, isHost: true },
    ];

    if (this.game.mp._connections?.size > 0) {
      let idx = 0;
      for (const [peerId, conn] of this.game.mp._connections) {
        const peerName = conn.peerName || `Captain ${peerId.slice(-4).toUpperCase()}`;
        const oppositeTeam = this.localTeam === 'CRIMSON' ? 'BLACK_TIDE' : 'CRIMSON';
        participants.push({
          id: peerId,
          name: peerName,
          team: idx % 2 === 0 ? oppositeTeam : this.localTeam,
          isHost: false,
        });
        idx++;
      }
    }

    const payload = {
      roomCode: this.roomCode,
      isPublic: this.isPublic,
      mode: this.selectedMode,
      botFill: this.botFill,
      participants,
    };

    this.game.mp.sendTeamBattleLobby?.(payload);
  }

  /**
   * Handle incoming authoritative lobby payload from host (Client side).
   */
  applyRemoteLobbyData(data) {
    if (!data) return;
    this.remoteLobbyData = data;
    if (data.mode) this.selectedMode = data.mode;
    if (data.botFill !== undefined) this.botFill = data.botFill;
    if (data.isPublic !== undefined) this.isPublic = data.isPublic;
    if (data.roomCode) this.roomCode = data.roomCode;

    this.renderRosters(data);
  }

  /**
   * Start battle as host.
   */
  startBattleAsHost() {
    if (!this.isHost) return;

    const config = {
      mode: this.selectedMode || '2v2',
      botFill: this.botFill,
      localTeam: this.localTeam,
    };

    // Transition room to in_progress in Supabase
    if (this.isPublic && this.game.matchmaking) {
      this.game.matchmaking.setRoomStatus(this.roomCode, 'in_progress').catch(() => {});
    }

    // Send START_MATCH action to all connected peers
    this.game.mp?.sendTeamBattleAction?.('START_MATCH', config);

    // Launch local game
    this.hide();
    this.game.startTeamBattleMatch?.(this.selectedMode, this.botFill);
  }

  /**
   * Leave lobby or close modal safely.
   */
  handleLeaveOrClose() {
    if (this.currentView === 'WAITING') {
      // Disconnect multiplayer session
      if (this.isHost) {
        this.game.mp?.sendTeamBattleAction?.('HOST_LEFT');
        this.game.matchmaking?.closeHostedRoom(this.roomCode).catch(() => {});
      }
      if (this.game.mp) {
        try { this.game.mp.disconnect?.(); } catch {}
        this.game.mp = null;
      }
    }
    this.game.matchmaking?.cleanupSession();
    this.currentView = 'COMMAND';
    this.hide();
  }

  /**
   * Render team player cards for Crimson Corsairs and Black Tide Raiders.
   */
  renderRosters(remoteData = this.remoteLobbyData) {
    const listCrimson = document.getElementById('tb-list-crimson');
    const listBlackTide = document.getElementById('tb-list-blacktide');
    const countEl = document.getElementById('tb-player-count');
    if (!listCrimson || !listBlackTide) return;

    listCrimson.innerHTML = '';
    listBlackTide.innerHTML = '';

    const maxSlots = this.selectedMode === '4v4' ? 4 : this.selectedMode === 'TEST' ? 1 : 2;
    const playerName = this.game.playerName || 'Captain Jack';

    let humanCount = 1;

    if (remoteData && remoteData.participants) {
      // Client view rendering host's authoritative roster
      const participants = remoteData.participants;
      humanCount = participants.filter(p => !p.isBot).length;

      participants.forEach(p => {
        const isMe = p.id === 'local_player' || (this.game.mp && p.id === this.game.mp._peer?.id);
        const cardHtml = `
          <div class="tb-player-card ${isMe ? 'local' : 'partner'} ${p.team.toLowerCase()}">
            <div class="tb-pc-avatar">${p.isHost ? '👑' : '⚓'}</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">${p.name} ${isMe ? '(You)' : ''}</span>
              <span class="tb-pc-ship">${p.isHost ? 'Flagship Admiral' : 'Battle Sloop'}</span>
            </div>
            <span class="tb-pc-badge ready">${p.isHost ? 'HOST' : 'CONNECTED'}</span>
          </div>
        `;
        if (p.team === 'CRIMSON') listCrimson.innerHTML += cardHtml;
        else listBlackTide.innerHTML += cardHtml;
      });

      // Fill remaining slots
      const crimsonSlotsUsed = participants.filter(p => p.team === 'CRIMSON').length;
      const blackTideSlotsUsed = participants.filter(p => p.team === 'BLACK_TIDE').length;

      this._fillRemainingSlots(listCrimson, crimsonSlotsUsed, maxSlots, 'crimson', this.botFill);
      this._fillRemainingSlots(listBlackTide, blackTideSlotsUsed, maxSlots, 'blacktide', this.botFill);

    } else {
      // Host view or local single-player view
      // 1. Local Player Card
      const localCard = `
        <div class="tb-player-card local ${this.localTeam.toLowerCase()}">
          <div class="tb-pc-avatar">👑</div>
          <div class="tb-pc-info">
            <span class="tb-pc-name">${playerName} (You)</span>
            <span class="tb-pc-ship">War Sloop • Flagship</span>
          </div>
          <span class="tb-pc-badge ready">${this.isHost ? 'HOST' : 'READY'}</span>
        </div>
      `;
      if (this.localTeam === 'CRIMSON') listCrimson.innerHTML += localCard;
      else listBlackTide.innerHTML += localCard;

      // 2. Connected Peers
      let crimsonCount = this.localTeam === 'CRIMSON' ? 1 : 0;
      let blackTideCount = this.localTeam === 'BLACK_TIDE' ? 1 : 0;

      if (this.game.mp?.connected) {
        if (this.isHost && this.game.mp._connections?.size > 0) {
          let idx = 0;
          for (const [peerId, conn] of this.game.mp._connections) {
            humanCount++;
            const peerName = conn.peerName || `Captain ${peerId.slice(-4).toUpperCase()}`;
            const targetTeam = idx % 2 === 0
              ? (this.localTeam === 'CRIMSON' ? 'blacktide' : 'crimson')
              : (this.localTeam === 'CRIMSON' ? 'crimson' : 'blacktide');

            const partnerCard = `
              <div class="tb-player-card partner ${targetTeam}">
                <div class="tb-pc-avatar">🤝</div>
                <div class="tb-pc-info">
                  <span class="tb-pc-name">${peerName}</span>
                  <span class="tb-pc-ship">War Brigantine</span>
                </div>
                <span class="tb-pc-badge ready">CONNECTED</span>
              </div>
            `;
            if (targetTeam === 'crimson') {
              listCrimson.innerHTML += partnerCard;
              crimsonCount++;
            } else {
              listBlackTide.innerHTML += partnerCard;
              blackTideCount++;
            }
            idx++;
          }
        } else if (!this.isHost) {
          humanCount = 2;
          const hostName = this.game.mp.partnerName || 'Admiral (Host)';
          const hostTeam = this.localTeam === 'CRIMSON' ? 'blacktide' : 'crimson';
          const hostCard = `
            <div class="tb-player-card partner ${hostTeam}">
              <div class="tb-pc-avatar">👑</div>
              <div class="tb-pc-info">
                <span class="tb-pc-name">${hostName}</span>
                <span class="tb-pc-ship">Flagship Admiral</span>
              </div>
              <span class="tb-pc-badge ready">HOST</span>
            </div>
          `;
          if (hostTeam === 'crimson') {
            listCrimson.innerHTML += hostCard;
            crimsonCount++;
          } else {
            listBlackTide.innerHTML += hostCard;
            blackTideCount++;
          }
        }
      }

      // 3. Fill remaining positions with AI bots or open slots
      this._fillRemainingSlots(listCrimson, crimsonCount, maxSlots, 'crimson', this.botFill);
      this._fillRemainingSlots(listBlackTide, blackTideCount, maxSlots, 'blacktide', this.botFill);
    }

    if (countEl) {
      countEl.textContent = `Human Captains: ${humanCount} / ${maxSlots * 2}`;
    }
  }

  _fillRemainingSlots(container, currentCount, maxSlots, teamClass, fillWithBots) {
    const botPool = [
      'Anne Bonny', 'Blackbeard', 'Calico Jack', 'Bartholomew',
      'Mary Read', 'Henry Morgan', 'Edward Low', 'Grace O\'Malley'
    ];

    let bIdx = 0;
    for (let i = currentCount; i < maxSlots; i++) {
      if (fillWithBots) {
        container.innerHTML += `
          <div class="tb-player-card bot ${teamClass}">
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
        container.innerHTML += `
          <div class="tb-player-card empty">
            <div class="tb-pc-avatar">⏳</div>
            <div class="tb-pc-info">
              <span class="tb-pc-name">Open Slot</span>
              <span class="tb-pc-ship">Awaiting captain...</span>
            </div>
            <span class="tb-pc-badge empty">OPEN</span>
          </div>
        `;
      }
    }
  }
}

export default TeamBattleLobbyUI;
