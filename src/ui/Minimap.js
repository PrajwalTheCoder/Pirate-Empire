/**
 * Minimap — draws a real-time overhead chart on a fixed canvas.
 *
 * Fog of war: islands are hidden until the player sails within FOG_RADIUS.
 * Discovered islands are remembered per-session.
 *
 * Legend:
 *   Blue bg   — ocean
 *   Brown dot — uncaptured island (discovered)
 *   Gold star — player-captured island
 *   Red  dot  — enemy ship (within visual range)
 *   White▲    — player ship
 *   Red X     — treasure map destination
 */
const FOG_RADIUS = 90;   // world units around player that reveal islands/enemies

export class Minimap {
  /**
   * @param {ShipSystem}   shipSystem
   * @param {IslandSystem} islandSystem
   * @param {number}       worldSize
   */
  constructor(shipSystem, islandSystem, worldSize) {
    this._ships   = shipSystem;
    this._islands = islandSystem;
    this._world   = worldSize;

    this._canvas  = document.getElementById('minimap');
    this._ctx     = this._canvas ? this._canvas.getContext('2d') : null;
    this._W       = 180;
    this._H       = 180;

    // Fog of war: set of island indices the player has sailed near
    this._discovered = new Set();
  }

  /** Convert world XZ to minimap pixel (0..W, 0..H). */
  _toMap(x, z) {
    return {
      px: ( x / this._world + 0.5) * this._W,
      py: ( z / this._world + 0.5) * this._H,
    };
  }

  /**
   * @param {number}              _delta
   * @param {THREE.Vector3|null}  playerPos
   * @param {Array<{x,z,found}>}  treasureMarks
   * @param {Ship|null}           partnerShip   — co-op partner ghost ship
   * @param {string}              [partnerName] — partner captain name
   */
  update(_delta, playerPos = null, treasureMarks = [], partnerShip = null, partnerName = '') {
    const ctx = this._ctx;
    if (!ctx) return;

    const W = this._W, H = this._H;

    // ── Reveal islands near player ──────────────────────────────────────────────
    if (playerPos) {
      this._islands.islands.forEach((island, i) => {
        const dx = island.position.x - playerPos.x;
        const dz = island.position.z - playerPos.z;
        if (dx * dx + dz * dz < FOG_RADIUS * FOG_RADIUS) {
          this._discovered.add(i);
        }
      });
    }

    // ── Ocean background ──────────────────────────────────────────────────────
    ctx.fillStyle = '#0d2a4a';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(30,70,120,0.4)';
    ctx.lineWidth   = 0.5;
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * W;
      const y = (i / 4) * H;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // ── Islands ────────────────────────────────────────────────────────────
    this._islands.islands.forEach((island, i) => {
      // Always show player-captured islands; others only after discovery
      const show = island.captured && island.owner === 'PLAYER'
        ? true
        : this._discovered.has(i);
      if (!show) return;

      const { px, py } = this._toMap(island.position.x, island.position.z);

      if (island.captured && island.owner === 'PLAYER') {
        ctx.fillStyle = '#f0c040';
        ctx.beginPath();
        this._drawStar(ctx, px, py, 4);
        ctx.fill();
      } else {
        ctx.fillStyle = '#8b6030';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // ── Watch Tower Vision Circles ─────────────────────────────────────────────
    const VISION_R_WORLD = 80;
    const visionRpx = (VISION_R_WORLD / this._world) * this._W;
    for (const island of this._islands.islands) {
      if (!island.captured || island.owner !== 'PLAYER') continue;
      if (!island.buildings?.includes('WATCH_TOWER')) continue;
      const { px, py } = this._toMap(island.position.x, island.position.z);
      ctx.strokeStyle = 'rgba(0,220,255,0.4)';
      ctx.fillStyle   = 'rgba(0,180,255,0.08)';
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.arc(px, py, visionRpx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ── Enemy ships (within fog radius or watch-tower range) ────────────────────────
    for (const ship of this._ships.enemies) {
      if (!ship.isAlive) continue;

      const sx = ship.group.position.x;
      const sz = ship.group.position.z;

      // Within player's personal fog radius?
      let visible = false;
      if (playerPos) {
        const dx = sx - playerPos.x;
        const dz = sz - playerPos.z;
        visible = dx * dx + dz * dz < FOG_RADIUS * FOG_RADIUS;
      }

      // Or within a watch-tower circle?
      const inTower = this._islands.islands.some(isl => {
        if (!isl.captured || isl.owner !== 'PLAYER') return false;
        if (!isl.buildings?.includes('WATCH_TOWER')) return false;
        const dx = isl.position.x - sx;
        const dz = isl.position.z - sz;
        return dx * dx + dz * dz < VISION_R_WORLD * VISION_R_WORLD;
      });

      if (!visible && !inTower) continue;

      const { px, py } = this._toMap(sx, sz);
      ctx.fillStyle = inTower ? '#ffe040' : '#ff4040';
      ctx.beginPath();
      ctx.arc(px, py, inTower ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Treasure map destinations ─────────────────────────────────────────────────
    for (const mark of treasureMarks) {
      if (mark.found) continue;
      const { px, py } = this._toMap(mark.x, mark.z);
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth   = 1.5;
      // Draw X
      ctx.beginPath();
      ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4);
      ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4);
      ctx.stroke();
      // Orange dot at centre
      ctx.fillStyle = '#ff9900';
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Co-op Partner Ship ─────────────────────────────────────────────────────
    if (partnerShip && partnerShip.isAlive) {
      const { px: ppx, py: ppy } = this._toMap(
        partnerShip.group.position.x, partnerShip.group.position.z);

      ctx.save();
      ctx.translate(ppx, ppy);
      ctx.rotate(-partnerShip.group.rotation.y);

      // Emerald green arrow (same shape as player but different colour)
      ctx.fillStyle = '#00ff66';
      ctx.shadowColor = '#00ff66';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo( 3.5,  3.5);
      ctx.lineTo(-3.5,  3.5);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.restore();

      // Partner label beside the arrow
      const labelName = partnerName ? partnerName.split(' ').pop() : 'Partner';
      ctx.fillStyle = '#00ff66';
      ctx.font = 'bold 7px sans-serif';
      ctx.fillText(labelName, ppx + 6, ppy - 4);
    }

    // ── Player ship ────────────────────────────────────────────────────────────
    const player = this._ships.all.find(s => s.faction === 'PLAYER' && !s._isPartnerGhost);
    if (player && player.isAlive) {
      const { px, py } = this._toMap(
        player.group.position.x, player.group.position.z);

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-player.group.rotation.y);

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo( 3,  3);
      ctx.lineTo(-3,  3);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    // ── Border ─────────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(139,90,26,0.6)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0, 0, W, H);

    // ── Compass N ────────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(240,192,64,0.7)';
    ctx.font      = 'bold 9px sans-serif';
    ctx.fillText('N', W - 10, 11);
  }

  // ── 5-point star helper ────────────────────────────────────────────────────
  _drawStar(ctx, cx, cy, r) {
    const inner = r * 0.45;
    const pts   = 5;
    for (let i = 0; i < pts * 2; i++) {
      const angle = (i * Math.PI) / pts - Math.PI / 2;
      const rad   = i % 2 === 0 ? r : inner;
      const x     = cx + Math.cos(angle) * rad;
      const y     = cy + Math.sin(angle) * rad;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

export default Minimap;
