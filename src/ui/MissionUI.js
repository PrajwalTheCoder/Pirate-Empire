/**
 * MissionUI — renders the active mission list in the right panel.
 */
import EventEmitter from '../utils/EventEmitter.js';

export class MissionUI {
  /**
   * @param {MissionSystem} missionSystem
   */
  constructor(missionSystem) {
    this._missions = missionSystem;
    this._container = document.getElementById('mission-list');

    EventEmitter.on('mission:progress', () => this._render());
    EventEmitter.on('mission:complete', () => this._render());
    EventEmitter.on('mission:new',      () => this._render());

    this._render();
  }

  _render() {
    if (!this._container) return;

    const current  = this._missions.currentMission;
    const progress = this._missions.currentProgress;
    const index    = this._missions.currentIndex;
    const all      = this._missions.allMissions;

    let html = '';

    all.forEach((m, i) => {
      const isActive   = i === index;
      const isDone     = i < index;
      const isLocked   = i > index;

      let pct = 0;
      if (isActive && m.target > 0) pct = Math.min(1, progress / m.target) * 100;
      if (isDone) pct = 100;

      const cardClass = isDone
        ? 'mission-card mission-complete'
        : isActive
          ? 'mission-card'
          : 'mission-card';

      const titlePrefix = isDone ? '✅ ' : isActive ? '▶ ' : '🔒 ';
      const opacity     = isLocked ? '0.4' : '1';

      html += `
        <div class="${cardClass}" style="opacity:${opacity}">
          <div class="mission-title">${titlePrefix}${m.title}</div>
          ${!isLocked ? `<div class="mission-desc">${m.desc}</div>` : ''}
          ${!isLocked ? `
            <div class="mission-progress-track">
              <div class="mission-progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="mission-reward">Reward: ${m.rewardText}</div>
          ` : ''}
        </div>`;
    });

    this._container.innerHTML = html;
  }

  update(_delta) { /* event-driven */ }
}

export default MissionUI;
