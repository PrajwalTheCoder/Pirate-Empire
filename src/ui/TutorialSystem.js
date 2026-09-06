/**
 * TutorialSystem - Interactive controls guide for new players.
 *
 * Auto-shows on first voyage (checks localStorage 'pirate_tutorial_completed').
 * Can be re-opened via the control button in the HUD.
 */

const STORAGE_KEY = 'pirate_tutorial_completed';

const TUTORIAL_CARDS = [
  {
    icon: '⛵',
    title: 'Sailing & Speed',
    controls: [
      { key: 'W', desc: 'Full Sails - accelerate forward' },
      { key: 'S', desc: 'Slow Down / Reverse - reduce speed or back up' },
    ],
  },
  {
    icon: '⚓',
    title: 'Steering & Drift',
    controls: [
      { key: 'A', desc: 'Turn Rudder left' },
      { key: 'D', desc: 'Turn Rudder right' },
      { key: 'Q', desc: 'Anchor Brake / High-speed Drift - emergency stop or drift slide' },
    ],
  },
  {
    icon: '💣',
    title: 'Cannons & Ammo',
    controls: [
      { key: 'SPACE', desc: 'Fire Broadside Cannons (both sides)' },
      { key: 'Click', desc: 'Fire toward clicked direction' },
      { key: '1', desc: 'Round Shot - standard cannonball' },
      { key: '2', desc: 'Chain Shot - tears sails, slows enemies' },
      { key: '3', desc: 'Fire Shot - ignites hull for burn damage' },
    ],
  },
  {
    icon: '⚔️',
    title: 'Boarding & Plunder',
    controls: [
      { key: 'B', desc: 'Board nearby crippled enemy ship - capture it into your fleet' },
    ],
  },
  {
    icon: '🏝️',
    title: 'Capture & Repairs',
    controls: [
      { key: 'E', desc: 'Capture island - sail close and press to claim it' },
      { key: 'R', desc: 'Repair hull - press near your own island to restore HP' },
    ],
  },
  {
    icon: '🤝',
    title: 'Co-op Mode',
    controls: [
      { key: 'G', desc: 'Ping Map - alert partner on the minimap' },
      { key: 'Partner', desc: 'Partner ship renders in green with Captain name overhead' },
    ],
  },
];

export class TutorialSystem {
  constructor() {
    this._overlay = null;
    this._built   = false;
  }

  checkAndShow() {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setTimeout(() => this.show(), 1000);
    }
  }

  show() {
    if (!this._built) this._build();
    this._overlay.classList.remove('tutorial-hidden');
    this._overlay.classList.add('tutorial-visible');
  }

  hide() {
    if (!this._overlay) return;
    this._overlay.classList.remove('tutorial-visible');
    this._overlay.classList.add('tutorial-hidden');
  }

  _build() {
    this._built = true;

    const overlay = document.createElement('div');
    overlay.id        = 'tutorial-overlay';
    overlay.className = 'tutorial-modal tutorial-hidden';

    const backdrop = document.createElement('div');
    backdrop.className = 'tutorial-backdrop';
    overlay.appendChild(backdrop);

    const box = document.createElement('div');
    box.className = 'tutorial-box';

    // Header
    const header = document.createElement('div');
    header.className = 'tutorial-header';
    header.innerHTML = `
      <span class="tutorial-logo">☠️</span>
      <h2 class="tutorial-title">Captain's Handbook — Controls</h2>
      <button class="tutorial-close-btn" id="tut-x-btn" title="Close">✕</button>
    `;
    box.appendChild(header);

    // Content rows
    const content = document.createElement('div');
    content.className = 'tutorial-content';
    content.style.maxHeight = '60vh';
    content.style.overflowY = 'auto';
    content.style.paddingRight = '6px';

    for (const card of TUTORIAL_CARDS) {
      const cardTitle = document.createElement('div');
      cardTitle.style.cssText = 'color: #f0c040; font-weight: bold; margin-top: 8px; margin-bottom: 4px; font-size: 0.95rem; font-family: "MedievalSharp", Georgia, serif;';
      cardTitle.innerHTML = `${card.icon} ${card.title}`;
      content.appendChild(cardTitle);

      for (const c of card.controls) {
        const row = document.createElement('div');
        row.className = 'tutorial-row';
        row.innerHTML = `
          <kbd class="tutorial-key">${c.key}</kbd>
          <span class="tutorial-desc">${c.desc}</span>
        `;
        content.appendChild(row);
      }
    }
    box.appendChild(content);

    // Tip Box
    const tipBox = document.createElement('div');
    tipBox.className = 'tutorial-tip-box';
    tipBox.innerHTML = `💡 <b>Pirate Tip:</b> You can re-open this handbook anytime during your voyage by clicking the <b>❓ Controls</b> button in the top HUD!`;
    box.appendChild(tipBox);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'tutorial-footer';
    footer.innerHTML = `
      <label class="tutorial-skip-label">
        <input type="checkbox" id="tut-dontshow-cb">
        <span>Don't show again on voyage start</span>
      </label>
      <button class="tutorial-btn primary sail" id="tut-close-btn">Got it, Captain! Set Sail! ⚓</button>
    `;
    box.appendChild(footer);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    const closeHandler = () => {
      const cb = document.getElementById('tut-dontshow-cb');
      if (cb && cb.checked) {
        localStorage.setItem(STORAGE_KEY, '1');
      }
      this.hide();
    };

    document.getElementById('tut-close-btn')?.addEventListener('click', closeHandler);
    document.getElementById('tut-x-btn')?.addEventListener('click', closeHandler);

    backdrop.addEventListener('click', closeHandler);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._overlay && !this._overlay.classList.contains('tutorial-hidden')) {
        this.hide();
      }
    });
  }
}

export default TutorialSystem;
