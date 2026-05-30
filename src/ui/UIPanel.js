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

    // ── Stable delegated click handler for build cards ──────────────────────
    // Uses event delegation on the PERSISTENT pane element so DOM rebuilds
    // (which replace innerHTML) can never destroy the listener.
    document.getElementById('tab-build')?.addEventListener('click', (e) => {
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

    // ── Stable delegated click handler for recruit button ───────────────────
    document.getElementById('tab-fleet')?.addEventListener('click', (e) => {
      const el = e.target.closest('[data-recruit]');
      if (!el) return;
      EventEmitter.emit('fleet:recruit');
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
    // Click handling is done via the stable delegated listener in the constructor.
  }

  // ── Attack ─────────────────────────────────────────────────────────────────
  _renderAttack() {
    const pane = document.getElementById('tab-attack');
    if (!pane) return;
    pane.innerHTML = `
      <div class="tab-hint" style="padding-top:4px;">
        ⚔️ SPACE → Fire cannons (broadside both sides)<br/>
        Q → Drop anchor (stop ship)<br/>
        Approach enemies within cannon range to engage.
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
        this._economy.purchaseUpgrade(el.dataset.upgrade);
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
