/**
 * DialogueSystem — Cinematic radio-style dialogue popups with pirate portrait.
 *
 * Features:
 *  - Queues messages so they never overlap
 *  - Animated typewriter text effect
 *  - Speaker name + title display
 *  - Faction-coloured accent
 *  - Auto-dismiss with progress bar
 *  - Click-to-skip
 *  - Pirate captain portrait image
 *
 * Usage (via EventEmitter):
 *   EventEmitter.emit('story:dialogue', {
 *     speaker: 'Old Cass',
 *     title:   'Veteran Pirate Captain',
 *     text:    'Captain {PLAYER_NAME}, I\'ve been watching you...',
 *     faction: 'pirate',   // 'pirate' | 'navy' | 'ghost' | 'merchant' | 'veynar' | 'neutral'
 *     duration: 6000,      // ms — default 6000
 *     portrait: 'default'  // future: portrait variants
 *   });
 */
import EventEmitter from '../utils/EventEmitter.js';

// Faction colour accents
const FACTION_COLORS = {
  pirate:   { border: '#c8a415', name: '#f0c040', bg: 'rgba(30,18,5,0.97)' },
  navy:     { border: '#2255cc', name: '#4488ff', bg: 'rgba(5,10,30,0.97)'  },
  ghost:    { border: '#00d4aa', name: '#00ffcc', bg: 'rgba(0,8,15,0.97)'   },
  merchant: { border: '#aa8833', name: '#ddb855', bg: 'rgba(20,16,5,0.97)'  },
  veynar:   { border: '#6600cc', name: '#cc44ff', bg: 'rgba(8,0,20,0.97)'   },
  neutral:  { border: '#555566', name: '#aaaacc', bg: 'rgba(10,10,15,0.97)' },
};

export class DialogueSystem {
  /**
   * @param {string} playerName  — used to replace {PLAYER_NAME} tokens
   */
  constructor(playerName = 'Captain') {
    this.playerName = playerName;

    /** @type {Array<object>} */
    this._queue   = [];
    this._active  = false;
    this._typeTimer = null;
    this._autoTimer = null;

    this._buildDOM();
    this._bindEvents();

    EventEmitter.on('story:dialogue', (data) => this.queue(data));
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  _buildDOM() {
    // Root overlay
    this._overlay = document.getElementById('dialogue-overlay');
    if (!this._overlay) {
      // fallback if HTML hasn't been updated yet
      this._overlay = document.createElement('div');
      this._overlay.id = 'dialogue-overlay';
      this._overlay.className = 'dialogue-overlay hidden';
      document.body.appendChild(this._overlay);
    }

    this._portrait    = document.getElementById('dialogue-portrait');
    this._speakerName = document.getElementById('dialogue-speaker-name');
    this._speakerTitle= document.getElementById('dialogue-speaker-title');
    this._textEl      = document.getElementById('dialogue-text');
    this._progressBar = document.getElementById('dialogue-progress');
    this._skipHint    = document.getElementById('dialogue-skip-hint');
    this._transmission= document.getElementById('dialogue-transmission-label');
  }

  _bindEvents() {
    // Click anywhere on overlay to skip
    if (this._overlay) {
      this._overlay.addEventListener('click', () => this._skipCurrent());
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Update player name (called if player renames mid-session). */
  setPlayerName(name) {
    this.playerName = name;
  }

  /**
   * Queue a dialogue entry.
   * @param {{speaker:string, title?:string, text:string, faction?:string, duration?:number}} data
   */
  queue(data) {
    this._queue.push(data);
    if (!this._active) this._showNext();
  }

  /** Show a dialogue immediately, bypassing queue. */
  showImmediate(data) {
    this._clearTimers();
    this._queue.unshift(data);
    this._active = false;
    this._showNext();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _showNext() {
    if (this._queue.length === 0) {
      this._active = false;
      this._hideOverlay();
      return;
    }
    this._active = true;
    const entry = this._queue.shift();
    this._display(entry);
  }

  _display(entry) {
    const {
      speaker   = '📻 Transmission',
      title     = '',
      text      = '',
      faction   = 'neutral',
      duration  = 6500,
      choices   = null,
      npcShip   = null,
    } = entry;

    this._currentChoices = choices;
    const colors = FACTION_COLORS[faction] || FACTION_COLORS.neutral;

    // Replace {PLAYER_NAME} token
    const resolvedText = text.replace(/\{PLAYER_NAME\}/g, this.playerName);
    this._resolvedText = resolvedText;

    // Apply faction colours
    if (this._overlay) {
      this._overlay.style.setProperty('--dialogue-border', colors.border);
      this._overlay.style.setProperty('--dialogue-name-color', colors.name);
      this._overlay.style.setProperty('--dialogue-bg', colors.bg);
    }

    // Set speaker info
    if (this._speakerName)  this._speakerName.textContent  = speaker;
    if (this._speakerTitle) this._speakerTitle.textContent = title;
    if (this._textEl)       this._textEl.textContent       = '';

    // Transmission label changes by faction
    if (this._transmission) {
      const labels = {
        ghost:   '👻 SPECTRAL TRANSMISSION',
        navy:    '⚓ ROYAL NAVY COMMUNICATION',
        veynar:  '☠️ UNKNOWN DEEP TRANSMISSION',
        merchant:'📦 MERCHANT SIGNAL',
        pirate:  '📻 PIRATE RADIO',
        neutral: '📻 INCOMING TRANSMISSION',
      };
      this._transmission.textContent = labels[faction] || '📻 INCOMING TRANSMISSION';
    }

    // Hide choices by default
    const choicesEl = document.getElementById('dialogue-choices');
    if (choicesEl) choicesEl.classList.add('hidden');

    // Show overlay
    this._showOverlay();

    // Focus camera on speaking NPC ship if present
    if (npcShip && window.__game?.cameraSystem) {
      window.__game.cameraSystem.focusCinematic(npcShip, duration);
    }

    // Typewriter effect
    this._typeText(resolvedText, () => {
      if (choices && choices.length) {
        this._showChoices(choices);
      } else {
        // After typing done, animate progress bar
        this._startProgressBar(duration, () => {
          if (window.__game?.cameraSystem) {
            window.__game.cameraSystem.clearFocus();
          }
          this._showNext();
        });
      }
    });
  }

  _typeText(text, onComplete) {
    if (!this._textEl) { onComplete?.(); return; }
    let idx = 0;
    const chars = text.split('');
    const speed = Math.max(18, Math.min(42, Math.floor(4200 / chars.length))); // adaptive speed

    // Start glitching portrait
    if (this._portrait) {
      this._portrait.classList.add('glitching');
    }

    const oscPath = document.getElementById('oscilloscope-path');
    const leds = Array.from({ length: 5 }, (_, i) => document.getElementById(`voice-led-${i + 1}`));

    const tick = () => {
      if (idx >= chars.length) {
        // Stop glitching portrait
        if (this._portrait) {
          this._portrait.classList.remove('glitching');
          this._portrait.style.display = 'block';
        }
        // Flatline oscilloscope
        if (oscPath) {
          oscPath.setAttribute('d', 'M 0 10 L 100 10');
        }
        // Deactivate LEDs
        leds.forEach(led => led?.classList.remove('active'));

        onComplete?.();
        return;
      }
      this._textEl.textContent += chars[idx++];

      // Randomize LEDs
      leds.forEach(led => {
        if (led) {
          if (Math.random() < 0.65) led.classList.add('active');
          else led.classList.remove('active');
        }
      });

      // Update oscilloscope path with active wave
      if (oscPath) {
        let d = 'M 0 10 ';
        for (let x = 10; x < 100; x += 10) {
          const y = 10 + (Math.random() - 0.5) * 16;
          d += `L ${x} ${y} `;
        }
        d += 'L 100 10';
        oscPath.setAttribute('d', d);
      }

      // Slightly rotate the knobs left/right on radio deck for vintage animation feel
      if (idx % 3 === 0) {
        const knobs = document.querySelectorAll('.radio-knob');
        knobs.forEach(k => {
          const deg = 20 + Math.random() * 40;
          k.style.transform = `rotate(${deg}deg)`;
        });
      }

      this._typeTimer = setTimeout(tick, speed);
    };
    tick();
  }

  _showChoices(choices) {
    const choicesEl = document.getElementById('dialogue-choices');
    if (!choicesEl) return;
    choicesEl.innerHTML = '';
    choicesEl.classList.remove('hidden');

    // Hide skip hint / progress bar during choices
    if (this._skipHint) this._skipHint.style.visibility = 'hidden';
    if (this._progressBar) this._progressBar.style.width = '0%';

    choices.forEach(c => {
      const btn = document.createElement('button');
      btn.className = `choice-btn ${c.class || ''}`;
      btn.textContent = c.text;
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // prevent skipping dialogue on body click
        choicesEl.classList.add('hidden');
        if (this._skipHint) this._skipHint.style.visibility = 'visible';
        
        // Emit choice selection
        EventEmitter.emit('story:choice_selected', { action: c.action });
        
        // Clear focus if we focus-targeted a ship
        if (window.__game?.cameraSystem) {
          window.__game.cameraSystem.clearFocus();
        }

        this._showNext();
      });
      choicesEl.appendChild(btn);
    });
  }

  _startProgressBar(duration, onComplete) {
    if (!this._progressBar) { 
      this._autoTimer = setTimeout(onComplete, duration);
      return;
    }
    this._progressBar.style.transition = 'none';
    this._progressBar.style.width = '100%';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._progressBar.style.transition = `width ${duration}ms linear`;
        this._progressBar.style.width = '0%';
        this._autoTimer = setTimeout(onComplete, duration);
      });
    });
  }

  _skipCurrent() {
    // If choice overlay is visible, prevent skipping
    const choicesEl = document.getElementById('dialogue-choices');
    if (choicesEl && !choicesEl.classList.contains('hidden')) {
      return;
    }

    this._clearTimers();

    // If typing is still going, complete it immediately
    if (this._typeTimer) {
      this._clearTimers();
      // Complete text
      if (this._textEl && this._resolvedText) {
        this._textEl.textContent = this._resolvedText;
      }
      
      // Stop glitching / flatline oscilloscope / clear LEDs
      if (this._portrait) {
        this._portrait.classList.remove('glitching');
        this._portrait.style.display = 'block';
      }
      const oscPath = document.getElementById('oscilloscope-path');
      if (oscPath) oscPath.setAttribute('d', 'M 0 10 L 100 10');
      for (let i = 1; i <= 5; i++) {
        document.getElementById(`voice-led-${i}`)?.classList.remove('active');
      }

      // Show choices if available, else start progress bar
      if (this._currentChoices && this._currentChoices.length) {
        this._showChoices(this._currentChoices);
      } else {
        this._startProgressBar(1500, () => {
          if (window.__game?.cameraSystem) {
            window.__game.cameraSystem.clearFocus();
          }
          this._showNext();
        });
      }
      return;
    }

    // Otherwise skip to next
    if (window.__game?.cameraSystem) {
      window.__game.cameraSystem.clearFocus();
    }
    this._showNext();
  }

  _clearTimers() {
    if (this._typeTimer) { clearTimeout(this._typeTimer); this._typeTimer = null; }
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
  }

  _showOverlay() {
    if (this._overlay) {
      this._overlay.classList.remove('hidden');
      this._overlay.classList.add('dialogue-visible');
    }
  }

  _hideOverlay() {
    if (this._overlay) {
      this._overlay.classList.remove('dialogue-visible');
      this._overlay.classList.add('hidden');
    }
  }
}

export default DialogueSystem;
