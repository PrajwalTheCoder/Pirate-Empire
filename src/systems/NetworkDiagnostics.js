/**
 * NetworkDiagnostics — Real-time WebRTC latency, jitter, bandwidth, and simulation metrics.
 *
 * Implements:
 * - Application-level ping/pong using monotonic clocks (performance.now())
 * - RFC 3550 jitter calculation and EWMA smoothed RTT
 * - Snapshot frequency and byte rate accounting
 * - Diagnostic overlay panel toggleable via F3 or HUD button
 * - Clear labeling of estimated vs measured metrics
 */

export class NetworkDiagnostics {
  /**
   * @param {import('./MultiplayerSystem.js').MultiplayerSystem} mp
   */
  constructor(mp) {
    this.mp = mp;

    // Ping / RTT tracking
    this.pingIntervalMs = 1500;  // sample every 1.5 seconds
    this._pingTimer = 0;
    this._nextPingId = 1;
    this._pendingPings = new Map(); // pingId -> sendTime

    this.currentRttMs = 0;
    this.smoothedRttMs = 0;
    this.jitterEstimateMs = 0;
    this.recentRttSamples = [];    // last 8 samples (numbers)
    this.lastPongReceiveTime = 0;
    this.lastSuccessfulHeartbeat = 0;

    // Traffic rates (1-second sliding counter)
    this._bytesSentWindow = 0;
    this._bytesRecvWindow = 0;
    this._snapshotsSentWindow = 0;
    this._snapshotsRecvWindow = 0;
    this._rateTimer = 0;

    this.bytesSentPerSec = 0;
    this.bytesRecvPerSec = 0;
    this.snapshotSendRateHz = 0;
    this.snapshotRecvRateHz = 0;
    this.lastReceivedSnapshotTime = 0;

    // Frame times
    this.clientFrameTimeMs = 16.6;
    this.hostFrameTimeMs = 16.6;
    this._lastFrameTs = performance.now();

    // Ticks & Simulation
    this.hostSimulationTick = 0;
    this.latestAuthoritativeTick = 0;
    this.activeShipCount = 0;

    // Channel stats
    this.pendingDataChannelBytes = 0;
    this.backpressureDrops = 0;

    // UI state
    this.visible = false;
    this._overlayEl = null;

    if (typeof window !== 'undefined') {
      this._createOverlay();
      this._bindKeyboard();
    }
  }

  // ── PING / PONG MEASUREMENT ──────────────────────────────────────────────────

  /** Send an application-level ping packet. */
  sendPing() {
    if (!this.mp?.connected) return;
    const pingId = this._nextPingId++;
    const sendTime = performance.now();
    this._pendingPings.set(pingId, sendTime);

    // Timeout cleanup for dropped pings after 4.0s
    setTimeout(() => {
      if (this._pendingPings.has(pingId)) {
        this._pendingPings.delete(pingId);
      }
    }, 4000);

    this.mp._sendPingPacket(pingId, sendTime);
  }

  /**
   * Handle incoming pong response.
   * Calculates RTT using ONLY local monotonic performance.now().
   *
   * @param {number} pingId
   * @param {number} sendTime — original client send timestamp
   * @param {number} [receiverTick]
   */
  onPongReceived(pingId, sendTime, receiverTick = 0, now = performance.now()) {
    const localNow = now;
    if (!this._pendingPings.has(pingId)) return;
    this._pendingPings.delete(pingId);

    const rtt = Math.max(0, localNow - sendTime);
    this.currentRttMs = parseFloat(rtt.toFixed(1));
    this.lastPongReceiveTime = localNow;
    this.lastSuccessfulHeartbeat = localNow;

    if (receiverTick) {
      if (this.mp.isClient) {
        this.hostSimulationTick = receiverTick;
      }
    }

    // Smoothed RTT (EWMA: 80% history, 20% sample)
    if (this.smoothedRttMs === 0) {
      this.smoothedRttMs = this.currentRttMs;
    } else {
      this.smoothedRttMs = parseFloat((this.smoothedRttMs * 0.80 + this.currentRttMs * 0.20).toFixed(1));
    }

    // Jitter calculation (RFC 3550 style: D(i, j) = |D_i - D_j|)
    const diff = Math.abs(this.currentRttMs - this.smoothedRttMs);
    if (this.jitterEstimateMs === 0) {
      this.jitterEstimateMs = parseFloat(diff.toFixed(1));
    } else {
      this.jitterEstimateMs = parseFloat((this.jitterEstimateMs * 0.875 + diff * 0.125).toFixed(1));
    }

    // Circular buffer of last 8 samples
    this.recentRttSamples.push(this.currentRttMs);
    if (this.recentRttSamples.length > 8) {
      this.recentRttSamples.shift();
    }
  }

  // ── TRAFFIC ACCOUNTING ───────────────────────────────────────────────────────

  recordBytesSent(bytes) {
    this._bytesSentWindow += bytes;
  }

  recordBytesReceived(bytes) {
    this._bytesRecvWindow += bytes;
  }

  recordSnapshotSent() {
    this._snapshotsSentWindow++;
  }

  recordSnapshotReceived() {
    this._snapshotsRecvWindow++;
    this.lastReceivedSnapshotTime = performance.now();
  }

  // ── PER-FRAME UPDATE ─────────────────────────────────────────────────────────

  /**
   * @param {number} delta
   * @param {number} [activeShips=0]
   */
  update(delta, activeShips = 0) {
    const now = performance.now();
    this.clientFrameTimeMs = parseFloat((now - this._lastFrameTs).toFixed(1));
    this._lastFrameTs = now;
    this.activeShipCount = activeShips;

    // Ping loop
    this._pingTimer += delta * 1000;
    if (this._pingTimer >= this.pingIntervalMs) {
      this._pingTimer = 0;
      this.sendPing();
    }

    // Rate calculations updated once per second
    this._rateTimer += delta;
    if (this._rateTimer >= 1.0) {
      this.bytesSentPerSec = this._bytesSentWindow;
      this.bytesRecvPerSec = this._bytesRecvWindow;
      this.snapshotSendRateHz = this._snapshotsSentWindow;
      this.snapshotRecvRateHz = this._snapshotsRecvWindow;

      this._bytesSentWindow = 0;
      this._bytesRecvWindow = 0;
      this._snapshotsSentWindow = 0;
      this._snapshotsRecvWindow = 0;
      this._rateTimer = 0;
    }

    // Query data channel bufferedAmount if available
    this.pendingDataChannelBytes = this.mp?._getDataChannelBufferedAmount?.() ?? 0;

    // Render UI overlay if open
    if (this.visible) {
      this._renderOverlay();
    }
  }

  // ── UI OVERLAY ───────────────────────────────────────────────────────────────

  _createOverlay() {
    if (document.getElementById('pe-net-diagnostics-panel')) {
      this._overlayEl = document.getElementById('pe-net-diagnostics-panel');
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'pe-net-diagnostics-panel';
    panel.style.cssText = `
      position: fixed;
      top: 54px;
      right: 12px;
      z-index: 999999;
      background: rgba(10, 20, 32, 0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 215, 0, 0.35);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: 'JetBrains Mono', 'Courier New', monospace;
      font-size: 11px;
      line-height: 1.45;
      color: #e2e8f0;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      min-width: 290px;
      pointer-events: none;
      display: none;
      user-select: none;
    `;
    document.body.appendChild(panel);
    this._overlayEl = panel;
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      // F3 toggles the Network Diagnostics overlay
      if (e.key === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle() {
    this.visible = !this.visible;
    if (this._overlayEl) {
      this._overlayEl.style.display = this.visible ? 'block' : 'none';
      if (this.visible) this._renderOverlay();
    }
  }

  setVisible(show) {
    this.visible = !!show;
    if (this._overlayEl) {
      this._overlayEl.style.display = this.visible ? 'block' : 'none';
      if (this.visible) this._renderOverlay();
    }
  }

  _renderOverlay() {
    if (!this._overlayEl) return;

    const mp = this.mp;
    const connected = mp?.connected;
    const role = mp?.role || 'OFFLINE';
    const roomCode = mp?.roomCode || '---';
    const peerId = mp?._peer?.id || mp?.roomCode || '---';

    // Interpolation metrics
    const interp = mp?.getPrimaryInterpolationBuffer?.();
    const staleRejected = interp?.staleRejectedCount ?? 0;
    const sequenceGaps = interp?.sequenceGaps ?? 0;
    const missedUpdates = interp?.missedUpdates ?? 0;
    const interpDelay = interp?.getInterpolationDelayMs?.() ?? 70;
    const isExtrapolating = interp?.lastExtrapolating ?? false;

    // Snapshot age
    const now = performance.now();
    const snapAgeMs = this.lastReceivedSnapshotTime > 0
      ? Math.max(0, Math.round(now - this.lastReceivedSnapshotTime))
      : 0;

    const rttColor = this.currentRttMs < 70 ? '#4ade80' : this.currentRttMs < 150 ? '#facc15' : '#f87171';
    const samplesStr = this.recentRttSamples.length > 0 ? this.recentRttSamples.slice(-5).join(', ') : 'none';

    this._overlayEl.innerHTML = `
      <div style="font-weight: bold; border-bottom: 1px solid rgba(255,215,0,0.3); padding-bottom: 4px; margin-bottom: 6px; display: flex; justify-content: space-between;">
        <span>🌐 NET DIAGNOSTICS <span style="font-size: 9px; color: #94a3b8;">[F3]</span></span>
        <span style="color: ${connected ? '#4ade80' : '#ef4444'};">${connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
      </div>
      <div><b>Role / Room:</b> <span style="color: #67e8f9;">${role}</span> | <b>Match:</b> ${roomCode}</div>
      <div style="font-size: 10px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        <b>Peer:</b> ${peerId}
      </div>

      <div style="margin-top: 5px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
        <div><b>RTT:</b> <span style="color: ${rttColor}; font-weight: bold;">${this.currentRttMs > 0 ? this.currentRttMs + ' ms' : 'Measuring...'}</span> (avg: ${this.smoothedRttMs} ms)</div>
        <div><b>Jitter:</b> ±${this.jitterEstimateMs} ms <span style="font-size: 9px; color: #94a3b8;">(est.)</span></div>
        <div style="font-size: 10px; color: #94a3b8;"><b>Recent:</b> [${samplesStr}] ms</div>
      </div>

      <div style="margin-top: 5px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
        <div><b>Snapshots:</b> Tx: ${this.snapshotSendRateHz} Hz | Rx: ${this.snapshotRecvRateHz} Hz</div>
        <div><b>Snapshot Age:</b> ${snapAgeMs} ms | <b>Interp Delay:</b> ${Math.round(interpDelay)} ms</div>
        <div><b>Status:</b> ${isExtrapolating ? '<span style="color: #f59e0b;">EXTRAPOLATING</span>' : '<span style="color: #10b981;">INTERPOLATING</span>'}</div>
        <div><b>Bandwidth:</b> Tx: ~${(this.bytesSentPerSec / 1024).toFixed(1)} KB/s | Rx: ~${(this.bytesRecvPerSec / 1024).toFixed(1)} KB/s <span style="font-size: 9px; color: #94a3b8;">(est.)</span></div>
        <div><b>DC Buffer:</b> ${this.pendingDataChannelBytes} B ${this.backpressureDrops > 0 ? `<span style="color: #f87171;">(drops: ${this.backpressureDrops})</span>` : ''}</div>
      </div>

      <div style="margin-top: 5px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
        <div><b>Packet Quality:</b> Stale Rej: ${staleRejected} | Gaps: ${sequenceGaps}</div>
        <div><b>Missed Updates:</b> ${missedUpdates} <span style="font-size: 9px; color: #94a3b8;">(est.)</span></div>
        <div><b>Ticks:</b> Host: ${this.hostSimulationTick} | Local: ${this.latestAuthoritativeTick}</div>
        <div><b>Frame Time:</b> ${this.clientFrameTimeMs} ms (${Math.round(1000 / Math.max(1, this.clientFrameTimeMs))} FPS)</div>
        <div><b>Synced Ships:</b> ${this.activeShipCount} active</div>
      </div>
    `;
  }
}

export default NetworkDiagnostics;
