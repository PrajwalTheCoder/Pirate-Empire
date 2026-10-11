/**
 * UIPanel — bottom panel with tabbed interface.
 * Tabs: Fleet | Build | Attack | Upgrades | Map
 */
import EventEmitter   from '../utils/EventEmitter.js';
import { BuildCatalog } from '../systems/BuildSystem.js';
import GameConfig       from '../config/GameConfig.js';

export class UIPanel {
  /**
   * @param {EconomySystem} economy
   * @param {BuildSystem}   buildSystem
   * @param {IslandSystem}  islandSystem
   * @param {ShipSystem}    shipSystem
   */
  constructor(economy, buildSystem, islandSystem, shipSystem) {
    this._economy     = economy;
    this._build       = buildSystem;
    this._islands     = islandSystem;
    this._ships       = shipSystem;

    this._activeTab   = 'fleet';
    this._targetIslandId = null;

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setTab(btn.dataset.tab);
      });
    });

    // Re-render relevant tabs on data changes
    EventEmitter.on('economy:changed',  () => this._renderActiveTab());
    EventEmitter.on('island:captured',  () => this._renderActiveTab());
    EventEmitter.on('build:completed',  () => this._renderActiveTab());
    EventEmitter.on('upgrade:purchased',() => this._renderActiveTab());
    // island:nearby fires every frame — only re-render build tab when the island ID changes
    EventEmitter.on('island:nearby', ({ island }) => {
      const newId = island ? island.id : null;
      const changed = newId !== this._targetIslandId;
      this._targetIslandId = newId;
      if (changed && this._activeTab === 'build') this._renderBuild();
    });
    // Keep legacy capturable listener so _targetIslandId is also set for enemy islands
    EventEmitter.on('island:capturable', ({ island }) => {
      this._targetIslandId = island.id;
    });
    EventEmitter.on('island:outofrange', () => {
      // Only clear if no owned island is nearby (island:nearby null fires separately)
    });

    // ── Stable delegated click handler for build cards (Solo + Team Battle) ──
    document.getElementById('tab-build')?.addEventListener('click', (e) => {
      const tbEl = e.target.closest('[data-tb-build]');
      if (tbEl) {
        const type = tbEl.dataset.tbBuild;
        const tb = window.__game?.teamBattle;
        if (!tb) return;
        const myTeam = tb.participants.find(p => p.id === 'local_player')?.team || 'CRIMSON';
        if (type === 'fortress') {
          if (this._economy.canAfford({ gold: 100, wood: 150 })) {
            this._economy.spend({ gold: 100, wood: 150 });
            tb.applyIslandDamage(myTeam, -250); // heals fortress!
            window.__game?.hud?.toast('🛡️ Fortress Ramparts Reinforced! +250 HP', 'success');
            if (window.__game?.mp?.isHost) {
              window.__game.mp.sendTeamBattleState?.(tb.getState());
            } else {
              window.__game?.mp?.sendTeamBattleIslandHit?.({ targetTeam: myTeam, damage: -250 });
            }
            this._renderActiveTab();
          } else {
            window.__game?.hud?.toast('❌ Need 100 Gold & 150 Wood!', 'danger');
          }
        } else if (type === 'repair') {
          if (this._economy.canAfford({ gold: 150, wood: 100 })) {
            this._economy.spend({ gold: 150, wood: 100 });
            tb._dockRepairActive = true;
            window.__game?.hud?.toast('🛠️ Dock Repair Station operational!', 'success');
            this._renderActiveTab();
          } else {
            window.__game?.hud?.toast('❌ Need 150 Gold & 100 Wood!', 'danger');
          }
        }
        return;
      }

      const el = e.target.closest('[data-build]');
      if (!el) return;
      const buildingType = el.dataset.build;
      const islandId = this._targetIslandId;
      if (islandId === null) return;
      const island = this._islands.getIsland(islandId);
      if (!island || !island.captured || island.buildings.includes(buildingType)) return;
      const success = this._build.build(islandId, buildingType);
      if (!success) {
        el.style.borderColor = '#ff4040';
        setTimeout(() => el.style.borderColor = '', 600);
      }
    });

    // ── Stable delegated click handler for Fleet commands & recruit ───────────
    document.getElementById('tab-fleet')?.addEventListener('click', (e) => {
      const cmdEl = e.target.closest('[data-fleet-cmd]');
      if (cmdEl) {
        const cmd = cmdEl.dataset.fleetCmd;
        window.__game?.teamBattle?.commandFleet(cmd);
        this._renderActiveTab();
        return;
      }
      const el = e.target.closest('[data-recruit]');
      if (!el) return;
      EventEmitter.emit('fleet:recruit');
    });

    // ── Stable delegated click handler for Attack commands ───────────────────
    document.getElementById('tab-attack')?.addEventListener('click', (e) => {
      const atkEl = e.target.closest('[data-attack]');
      if (atkEl) {
        const action = atkEl.dataset.attack;
        const playerShip = window.__game?.playerShip;
        if (action === 'broadside') {
          if (playerShip && playerShip.cannonCooldown <= 0) {
            window.__game?.combat?.fireCannons(playerShip, 'BOTH');
          } else {
            window.__game?.hud?.toast('⏳ Cannons reloading...', 'danger');
          }
        } else if (action === 'anchor') {
          if (playerShip) {
            playerShip.isAnchored = !playerShip.isAnchored;
            window.__game?.hud?.toast(playerShip.isAnchored ? '⚓ Anchor dropped!' : '⚓ Anchor raised!', 'info');
          }
        } else if (action === 'target') {
          const enemies = window.__game?.ships?.enemies ?? [];
          if (enemies.length > 0 && playerShip) {
            let closest = null;
            let minDist = Infinity;
            for (const en of enemies) {
              if (!en.isAlive || !en.group) continue;
              const d = playerShip.group.position.distanceTo(en.group.position);
              if (d < minDist) { minDist = d; closest = en; }
            }
            if (closest) {
              window.__game?.hud?.toast(`🎯 Nearest Target: ${closest.shipClass.replace('_', ' ')} (${Math.round(minDist)}m)!`, 'gold');
            }
          }
        }
        return;
      }
      const ammoEl = e.target.closest('[data-ammo]');
      if (ammoEl) {
        const ammo = ammoEl.dataset.ammo;
        window.__game?.combat?.setAmmoType(ammo);
        window.__game?.hud?.toast(`💣 Selected Ammo: ${ammo} SHOT`, 'info');
        this._renderActiveTab();
      }
    });

    // Initial render
    this._renderActiveTab();
  }

  _setTab(name) {
    this._activeTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === `tab-${name}`);
    });
    this._renderActiveTab();
  }

  _renderActiveTab() {
    switch (this._activeTab) {
      case 'fleet':    this._renderFleet();    break;
      case 'build':    this._renderBuild();    break;
      case 'attack':   this._renderAttack();   break;
      case 'upgrades': this._renderUpgrades(); break;
      case 'map':      this._renderMap();      break;
    }
  }

  // ── Fleet ──────────────────────────────────────────────────────────────────
  _renderFleet() {
    const pane = document.getElementById('tab-fleet');
    if (!pane) return;

    if (window.__game?.isTeamBattle && window.__game?.teamBattle) {
      const tb = window.__game.teamBattle;
      const myTeam = tb.participants.find(p => p.id === 'local_player')?.team || 'CRIMSON';
      const myFleet = tb.participants.filter(p => p.team === myTeam);

      pane.innerHTML = `
        <div class="fleet-list">
          ${myFleet.map(p => {
            const ship = p.ship;
            const hp = ship ? Math.ceil(ship.health) : 0;
            const mhp = ship?.maxHealth ?? 120;
            const status = !ship || !ship.isAlive ? '💀 SUNK' : '⛵ SAILING';
            return `
              <div class="fleet-ship-card ${p.id === 'local_player' ? 'flagship-card' : ''}">
                ${p.id === 'local_player' ? '👑' : '⛵'} <strong>${p.name}</strong>
                &nbsp;|&nbsp; ❤️ ${hp}/${mhp}
                &nbsp;|&nbsp; <span style="color:${ship?.isAlive ? '#2ecc71' : '#e74c3c'}">${status}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div class="recruit-section" style="display:flex;gap:8px;align-items:center;margin-top:4px;">
          <button class="recruit-btn" data-fleet-cmd="FLAG" title="Order allies to contest central flag">
            🚩 Focus Flag
          </button>
          <button class="recruit-btn" data-fleet-cmd="FORTRESS" title="Order allies to attack enemy fortress">
            🏰 Bombard Fortress
          </button>
          <button class="recruit-btn" data-fleet-cmd="DEFEND" title="Order allies to defend home dock">
            🛡️ Defend Dock
          </button>
        </div>
      `;
      return;
    }

    const playerShips = this._ships.all.filter(s =>
      s.faction === 'PLAYER' && s.isAlive);

    if (playerShips.length === 0) {
      pane.innerHTML = '<div class="tab-hint">No ships in your fleet.</div>';
      return;
    }

    pane.innerHTML = `<div class="fleet-list">
      ${playerShips.map(s => `
        <div class="fleet-ship-card">
          🚢 ${s.shipClass.replace('_', ' ')}
          &nbsp;|&nbsp; ❤️ ${Math.ceil(s.health)}/${s.maxHealth}
          &nbsp;|&nbsp; 👥 ${s.crew}
        </div>
      `).join('')}
    </div>
    ${(() => {
      const si = this._islands.islands.find(isl =>
        isl.captured && isl.owner === 'PLAYER' && isl.buildings.includes('SHIPYARD'));
      if (!si) return '';
      const can = this._economy.resources.crew >= 5;
      return `<div class="recruit-section">
        <button class="recruit-btn${can ? '' : ' cannot-afford'}" data-recruit>
          ⚓ Recruit Ship — 5 👥 Crew
        </button>
      </div>`;
    })()}`;
  }

  // ── Build ──────────────────────────────────────────────────────────────────
  _renderBuild() {
    const pane = document.getElementById('tab-build');
    if (!pane) return;

    if (window.__game?.isTeamBattle) {
      const tb = window.__game?.teamBattle;
      const canFortress = this._economy.canAfford({ gold: 100, wood: 150 });
      const canRepair = this._economy.canAfford({ gold: 150, wood: 100 });
      const isRepActive = tb?._dockRepairActive;

      pane.innerHTML = `
        <div class="tab-hint" style="margin-bottom:4px;">Home Fortress Field Fortifications</div>
        <div class="build-grid">
          <div class="build-card ${canFortress ? '' : 'cannot-afford'}" data-tb-build="fortress">
            🛡️ Reinforce Fortress (+250 HP)
            <span class="cost">🪙100 🪵150</span>
          </div>
          <div class="build-card ${isRepActive || !canRepair ? 'cannot-afford' : ''}" data-tb-build="repair">
            ${isRepActive ? '✅ Repair Station (Active)' : '🛠️ Dock Repair Station'}
            ${!isRepActive ? '<span class="cost">🪙150 🪵100</span>' : ''}
          </div>
        </div>
      `;
      return;
    }

    const islandId = this._targetIslandId;
    const island   = islandId !== null ? this._islands.getIsland(islandId) : null;

    if (!island || !island.captured) {
      pane.innerHTML = '<div class="tab-hint">Sail to a captured island to build.</div>';
      return;
    }

    pane.innerHTML = `
      <div class="tab-hint" style="margin-bottom:4px;">Building on Island #${island.id}</div>
      <div class="build-grid">
        ${BuildCatalog.map(entry => {
          const built    = island.buildings.includes(entry.id);
          const canAfford = this._economy.canAfford(entry.cost);
          const cls = built ? 'build-card cannot-afford' :
                     (!canAfford ? 'build-card cannot-afford' : 'build-card');
          const label = built ? `✅ ${entry.label}` : entry.label;
          const goldCost = entry.cost.gold ?? 0;
          return `<div class="${cls}" data-build="${entry.id}">
            ${label}
            ${!built ? `<span class="cost">🪙${goldCost}</span>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }

  // ── Attack ─────────────────────────────────────────────────────────────────
  _renderAttack() {
    const pane = document.getElementById('tab-attack');
    if (!pane) return;
    const curAmmo = window.__game?.combat?.currentAmmoType || 'ROUND';

    pane.innerHTML = `
      <div class="attack-controls-grid" style="display:flex;gap:8px;flex-wrap:wrap;padding:4px 0;">
        <button class="recruit-btn" data-attack="broadside" style="background:#8b2500;" title="Fire both port and starboard broadsides">
          💥 Fire Broadside [SPACE]
        </button>
        <button class="recruit-btn" data-attack="target" title="Scan and acquire nearest enemy ship">
          🎯 Lock Nearest Target
        </button>
        <button class="recruit-btn" data-attack="anchor" title="Drop or raise ship anchor">
          ⚓ Toggle Anchor [Q]
        </button>
        <button class="recruit-btn ${curAmmo === 'ROUND' ? 'cannot-afford' : ''}" data-ammo="ROUND">
          💣 Round Shot [1]
        </button>
        <button class="recruit-btn ${curAmmo === 'CHAIN' ? 'cannot-afford' : ''}" data-ammo="CHAIN">
          ⛓️ Chain Shot [2]
        </button>
        <button class="recruit-btn ${curAmmo === 'FIRE' ? 'cannot-afford' : ''}" data-ammo="FIRE">
          🔥 Fire Shot [3]
        </button>
      </div>`;
  }

  // ── Upgrades ───────────────────────────────────────────────────────────────
  _renderUpgrades() {
    const pane = document.getElementById('tab-upgrades');
    if (!pane) return;

    pane.innerHTML = `<div class="upgrade-list">
      ${GameConfig.UPGRADES.map(upg => {
        const owned     = this._economy.hasUpgrade?.(upg.id) ?? false;
        const canAfford = this._economy.canAfford(upg.cost);
        const locked    = upg.requires && !(this._economy.hasUpgrade?.(upg.requires) ?? false);
        const goldCost  = upg.cost.gold ?? 0;

        let cls   = 'upgrade-card';
        let label = upg.label;
        if (owned)     { cls += ' cannot-afford'; label = `✅ ${label}`; }
        else if (locked) { cls += ' cannot-afford'; label = `🔒 ${label}`; }
        else if (!canAfford) { cls += ' cannot-afford'; }

        return `<div class="${cls}" data-upgrade="${upg.id}">
          ${label}
          ${!owned ? `<span class="cost"> 🪙${goldCost}</span>` : ''}
        </div>`;
      }).join('')}
    </div>`;

    pane.querySelectorAll('[data-upgrade]').forEach(el => {
      el.addEventListener('click', () => {
        const upgId = el.dataset.upgrade;
        const success = this._economy.purchaseUpgrade(upgId);
        if (success) {
          const upg = GameConfig.UPGRADES.find(u => u.id === upgId);
          window.__game?.hud?.toast(`⚙️ Upgrade Acquired: ${upg?.label}!`, 'success');
          // In multiplayer, broadcast upgraded ship state immediately
          if (window.__game?.mp?.connected && window.__game?.playerShip) {
            window.__game.mp.sendShipState(window.__game.playerShip);
          }
          this._renderActiveTab();
        }
      });
    });
  }

  // ── Map ────────────────────────────────────────────────────────────────────
  _renderMap() {
    const pane = document.getElementById('tab-map');
    if (!pane) return;
    const total    = this._islands.islands.length;
    const captured = this._islands.capturedCount;
    pane.innerHTML = `
      <div class="tab-hint" style="padding-top: 4px;">
        🌊 Caribbean Sea &nbsp;|&nbsp;
        🏝️ Islands: <strong style="color:#f0c040">${captured}/${total}</strong> captured
        &nbsp;|&nbsp;
        👥 Enemy ships: <strong style="color:#ff8080">${
          this._ships.enemies.length
        }</strong>
      </div>`;
  }

  update(_delta) { /* re-renders are event-driven */ }
}

export default UIPanel;
