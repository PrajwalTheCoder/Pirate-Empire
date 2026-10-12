/**
 * MultiplayerSystem — PeerJS WebRTC peer-to-peer networking.
 *
 * Roles:
 *   HOST   — runs world simulation (AI, events, economy).
 *            Broadcasts world state to client.
 *   CLIENT — sends own ship inputs, receives world state.
 *
 * Transport (v2 — AAA binary protocol):
 *   High-frequency messages (SS, AI, CF, DE, DR) are packed as compact
 *   ArrayBuffer binary packets via NetPacker (~16 bytes vs ~150 bytes JSON).
 *   Infrequent/complex messages (PP, PM, FL, QC, RQ, RR, WE, SY, WL) use
 *   a JSON envelope wrapped in a binary container (type byte 0xFF).
 *
 *   Binary type IDs are defined in NetPacker.TYPE.
 *   JSON message codes:
 *     PP  — PerkPickup    (orb collected)
 *     PM  — PingMap       (map ping from partner)
 *     FL  — Flare         (distress flare)
 *     QC  — QuickChat     (radial message)
 *     RQ  — RescueRequest (partner sinking, start timer)
 *     RR  — RescueResolve (rescued / failed)
 *     WE  — WorldEvent    (host→client world log message)
 *     SY  — SyncWorld     (full world state snapshot on join)
 *     WL  — WorldLayout   (host→client island/loot positions, once on join)
 *     VH  — VersionHello  (first packet after connection open — version check)
 */

import EventEmitter from '../utils/EventEmitter.js';
import * as NetPacker from '../utils/NetPacker.js';
import { EntityInterpolationBuffer } from '../utils/EntityInterpolationBuffer.js';
import { NetworkDiagnostics } from './NetworkDiagnostics.js';

// ── Protocol version ─────────────────────────────────────────────────────────
// Increment when the binary packet layout changes so incompatible clients
// display a clear error instead of silently corrupting state.
export const PROTOCOL_VERSION = NetPacker.PROTOCOL_VERSION;

// ── Message type constants (JSON envelope codes) ──────────────────────────────
// High-frequency messages now use binary typeIds (see NetPacker.TYPE).
// These string codes are only used in the JSON_ENVELOPE fallback path.
export const MSG = {
  PERK_PICKUP:      'PP',
  PING_MAP:         'PM',
  FLARE:            'FL',
  QUICK_CHAT:       'QC',
  RESCUE_REQUEST:   'RQ',
  RESCUE_RESOLVE:   'RR',
  WORLD_EVENT:      'WE',
  SYNC_WORLD:       'SY',
  WORLD_LAYOUT:     'WL',
  VERSION_HELLO:    'VH',
  // Team Battle messages
  TB_STATE:         'TBS',
  TB_LOBBY:         'TBL',
  TB_ACTION:        'TBA',
  TB_FLAG_EVENT:    'TBF',
  TB_ISLAND_HIT:    'TBI',
  // Legacy aliases kept so external callers don't break
  SHIP_STATE:       'SS',
  CANNON_FIRE:      'CF',
  DAMAGE_EVENT:     'DE',
  AI_STATE:         'AI',
  DMG_REQUEST:      'DR',
};

// ── Quick-chat messages ───────────────────────────────────────────────────────
export const QUICK_CHAT = [
  { id: 0, icon: '⚓', text: 'With you!' },
  { id: 1, icon: '🎯', text: 'Shoot that one!' },
  { id: 2, icon: '🚨', text: "I'm in trouble!" },
  { id: 3, icon: '💥', text: 'Nice shot!' },
  { id: 4, icon: '⚠️', text: 'Retreat!' },
  { id: 5, icon: '😂', text: 'Hahaha' },
  { id: 6, icon: '🔥', text: "Let's go!" },
  { id: 7, icon: '🗺️', text: 'Follow me!' },
];

// ── Sync rates ────────────────────────────────────────────────────────────────
const SHIP_SYNC_RATE    = 1 / 20;   // 20Hz position sync (sufficient with dead reckoning)
const WORLD_SYNC_RATE   = 5.0;      // Full world snapshot every 5 seconds
const AI_SYNC_RATE      = 1 / 10;   // 10Hz enemy state sync (positions lerped on client)

export class MultiplayerSystem {
  /**
   * @param {string} role — 'HOST' | 'CLIENT'
   * @param {string} [roomCode] — join code (CLIENT only)
   * @param {string} [localPlayerName] — local player's captain name
   */
  constructor(role, roomCode = null, localPlayerName = '') {
    this.role       = role;    // 'HOST' or 'CLIENT'
    this.roomCode   = roomCode;
    this._localPlayerName = localPlayerName || '';
    this.isHost     = role === 'HOST';
    this.isClient   = role === 'CLIENT';

    this._peer      = null;   // PeerJS Peer instance
    this._conn      = null;   // DataConnection to partner
    this._connections = new Map(); // peerId -> conn (for multi-peer star topology)
    this.connected  = false;

    this._syncTimer      = 0;
    this._worldSyncTimer = 0;
    this._aiSyncTimer    = 0;

    // Dead-reckoning state for partner ship
    this.partnerState = {
      x: 0, y: 1, z: 0,
      rotY: 0,
      vx: 0, vy: 0, vz: 0,
      health: 100, maxHealth: 100,
      faction: 'PLAYER',
      name: '',  // partner captain name
    };

    // Partner name (latest received from VERSION_HELLO)
    this.partnerName = '';

    // Rescue state
    this._rescueTimer   = 0;
    this._rescueActive  = false;

    // Multi-peer state map (peerId -> latest state)
    this.peerStates = new Map();

    // Authoritative sequencing & event tracking (v3 protocol)
    this._localShipSeq     = 0;
    this._localShipGen     = 1;
    this._authoritativeTick = 0;
    this._hostEventSeq     = 0;
    this._processedEventIds = new Set();

    // Interpolation buffers
    this._partnerInterpBuffer = new EntityInterpolationBuffer();
    this._interpBuffers = new Map(); // peerId -> EntityInterpolationBuffer

    // Network Diagnostics & Latency Measurement
    this.diagnostics = new NetworkDiagnostics(this);

    // Callbacks set by Game
    this.onConnected        = null;   // () => void
    this.onDisconnected     = null;   // () => void
    this.onPartnerShipState = null;   // (state) => void
    this.onPeerShipState    = null;   // (peerId, state) => void
    this.onCannonFire       = null;   // (data) => void
    this.onDamageEvent      = null;   // (data) => void
    this.onShipDestroyed    = null;   // (data) => void
    this.onShipRespawned    = null;   // (data) => void
    this.onPerkPickup       = null;   // (data) => void
    this.onPingMap          = null;   // (data) => void
    this.onFlare            = null;   // () => void
    this.onQuickChat        = null;   // (msgId) => void
    this.onRescueRequest    = null;   // (timer) => void
    this.onRescueResolve    = null;   // (success) => void
    this.onWorldEvent       = null;   // (text) => void
    this.onSyncWorld        = null;   // (snapshot) => void
    this.onAIState          = null;   // (stateArray) => void  — client receives enemy positions
    this.onDamageRequest    = null;   // ({id, dmg, requestId, ammo}) => void — host receives hit request
    this.onWorldLayout      = null;   // (layoutData) => void  — client receives island/loot layout
    this.onWorldLayoutAck   = null;   // () => void            — host receives client ACK for world layout
    this.onTeamBattleIslandHit = null; // (data) => void       — host receives fortress damage from client

    // Version mismatch flag — set when partner runs an incompatible protocol version
    this._versionMismatch = false;
  }

  getPrimaryInterpolationBuffer() {
    return this._partnerInterpBuffer;
  }

  getInterpolationBuffer(peerId) {
    if (!peerId) return this._partnerInterpBuffer;
    if (!this._interpBuffers.has(peerId)) {
      const buf = new EntityInterpolationBuffer();
      if (this.roomCode) {
        buf.setMatchIdHash(NetPacker.hashMatchId(this.roomCode));
      }
      this._interpBuffers.set(peerId, buf);
    }
    return this._interpBuffers.get(peerId);
  }

  _getDataChannelBufferedAmount() {
    if (this._conn?.dataChannel?.bufferedAmount !== undefined) {
      return this._conn.dataChannel.bufferedAmount;
    }
    if (this.isHost && this._connections.size > 0) {
      let maxBuf = 0;
      for (const [_, conn] of this._connections) {
        if (conn.dataChannel?.bufferedAmount > maxBuf) {
          maxBuf = conn.dataChannel.bufferedAmount;
        }
      }
      return maxBuf;
    }
    return 0;
  }

  isChannelCongested() {
    return this._getDataChannelBufferedAmount() > 48000;
  }

  _sendPingPacket(pingId, sendTime) {
    this._sendBin(NetPacker.packPing(pingId, sendTime));
  }

  setLocalPlayerName(name) {
    this._localPlayerName = name || '';
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  /**
   * Connect to PeerJS cloud and set up the Peer object.
   * @param {function} [statusCallback] — optional (msg: string) => void for UI progress
   * @returns {Promise<string>} roomCode
   */
  async init(statusCallback = null) {
    this._statusCb = statusCallback;
    await MultiplayerSystem._loadPeerJS();

    // 1. Build optimal ICE server list (fresh Metered creds → DB creds → hardcoded)
    this._reportStatus('🌐 Connecting to relay servers...');
    const iceServers = await MultiplayerSystem._buildIceServers();
    console.log(`[MP] Using ${iceServers.length} ICE servers (${iceServers.filter(s => s.username).length} TURN, ${iceServers.filter(s => !s.username).length} STUN)`);

    return new Promise((resolve, reject) => {
      const peerOptions = {
        debug: 2,
        config: {
          iceServers,
          iceCandidatePoolSize: 4,  // pre-gather candidates for faster connection
        },
      };

      if (this.isHost) {
        const code = MultiplayerSystem._generateCode();
        this.roomCode = code;
        this._peer = new window.Peer(code, peerOptions);

        this._peer.on('open', () => {
          this._reportStatus('✅ Relay connected — share your code!');
          resolve(code);
        });

        this._peer.on('connection', (conn) => {
          this._conn = conn;
          this._connections.set(conn.peer, conn);
          this._setupConnection(conn);
        });

        this._peer.on('error', (err) => {
          console.error('[MP] Host peer error:', err.type, err);
          const msg = MultiplayerSystem._friendlyPeerError(err);
          this._reportStatus(`❌ ${msg}`);
          reject(new Error(msg));
        });

      } else {
        // CLIENT — connect to host's peer ID (which is the room code)
        this._peer = new window.Peer(undefined, peerOptions);

        this._peer.on('open', () => {
          this._reportStatus('🔗 Reaching your captain...');
          // binary serialization mode — PeerJS passes ArrayBuffer directly
          const conn = this._peer.connect(this.roomCode, { reliable: true, serialization: 'binary' });
          this._conn = conn;
          this._setupConnection(conn);

          // Monitor ICE state for better user feedback
          const iceCheck = setInterval(() => {
            const pc = conn.peerConnection;
            if (!pc) return;
            clearInterval(iceCheck);
            pc.addEventListener('iceconnectionstatechange', () => {
              const s = pc.iceConnectionState;
              console.log('[MP] ICE state:', s);
              if (s === 'checking')  this._reportStatus('🔍 Finding connection path...');
              if (s === 'connected' || s === 'completed') this._reportStatus('✅ Relay path established!');
              if (s === 'failed')    this._reportStatus('❌ Relay path failed — check your network');
              if (s === 'disconnected') this._reportStatus('⚠️ Connection unstable...');
            });
          }, 100);

          // 30 seconds — TURN relay gathering can take up to 15s on slow networks
          const timeoutId = setTimeout(() => {
            clearInterval(iceCheck);
            conn.close();
            reject(new Error(
              'Timed out after 30s. Make sure your Captain is on the Host tab waiting, then try again.'
            ));
          }, 30000);

          conn.on('open', () => {
            clearInterval(iceCheck);
            clearTimeout(timeoutId);
            resolve(this.roomCode);
          });
          conn.on('error', (err) => {
            clearInterval(iceCheck);
            clearTimeout(timeoutId);
            reject(new Error(MultiplayerSystem._friendlyPeerError(err)));
          });
          conn.on('close', () => {
            clearInterval(iceCheck);
            clearTimeout(timeoutId);
            reject(new Error('Connection closed — host may have left the lobby. Ask them to refresh and re-host.'));
          });
        });

        this._peer.on('error', (err) => {
          console.error('[MP] Client peer error:', err.type, err);
          const msg = MultiplayerSystem._friendlyPeerError(err);
          this._reportStatus(`❌ ${msg}`);
          reject(new Error(msg));
        });
      }
    });
  }

  _reportStatus(msg) {
    console.log('[MP]', msg);
    if (typeof this._statusCb === 'function') this._statusCb(msg);
  }

  /** Map raw PeerJS error types to player-friendly messages. */
  static _friendlyPeerError(err) {
    switch (err?.type) {
      case 'peer-unavailable':
        return 'Captain not found — make sure they are on the Host tab and the code is correct.';
      case 'disconnected':
        return 'Lost connection to the relay — check your internet and try again.';
      case 'network':
        return 'Network error — you may be behind a very strict firewall.';
      case 'unavailable-id':
        return 'Room code conflict — host should refresh and re-host.';
      case 'browser-incompatible':
        return 'Your browser does not support WebRTC. Try Chrome or Firefox.';
      case 'server-error':
        return 'Relay server error — please try again in a moment.';
      default:
        return err?.message || 'Unknown connection error. Please try again.';
    }
  }

  /**
   * Build a minimal, fast ICE server list.
   * Priority: 1) Metered REST API (fresh short-lived creds)
   *           2) Static creds from Supabase DB
   *           3) Hardcoded fallback
   */
  static async _buildIceServers() {
    const stunOnly = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];

    // Try to get fresh credentials from Metered REST API
    try {
      const { getTurnConfig } = await import('../utils/SupabaseClient.js');
      const configs = await getTurnConfig();

      if (!configs || configs.length === 0) throw new Error('No TURN config in DB');

      // Deduplicate to one set of credentials (first entry wins)
      const cred = configs.find(c => c.username && c.credential);
      if (!cred) throw new Error('No valid TURN credentials in DB');

      const { username, credential } = cred;
      console.log('[MP] Using TURN credentials from DB. Username:', username);

      // Minimal, effective TURN URL list — covers all NAT scenarios
      // Ordered: fastest (UDP 3478) → firewall-bypass (TCP 443) → TLS (strict firewalls)
      return [
        ...stunOnly,
        // Primary: UDP on 3478 — lowest latency
        { urls: 'turn:global.relay.metered.ca:3478?transport=udp', username, credential },
        // Fallback: TCP on 3478
        { urls: 'turn:global.relay.metered.ca:3478?transport=tcp', username, credential },
        // Firewall bypass: TCP on port 443 (looks like HTTPS traffic)
        { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username, credential },
        // Strict firewall bypass: TLS on 443
        { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username, credential },
        // India regional relay (lower latency for Indian users)
        { urls: 'turn:in.relay.metered.ca:3478?transport=udp', username, credential },
        { urls: 'turn:in.relay.metered.ca:443?transport=tcp', username, credential },
      ];
    } catch (err) {
      console.warn('[MP] Could not load TURN config from DB, using hardcoded fallback:', err.message);
    }

    // Last-resort hardcoded fallback — reads from .env.local (VITE_TURN_*)
    // If env vars are missing, STUN-only is used (may fail on strict NATs).
    const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
    const u = env.VITE_TURN_USERNAME  || '';
    const c = env.VITE_TURN_CREDENTIAL || '';
    if (!u || !c) {
      console.warn('[MP] TURN credentials not found in env — using STUN only. Co-op may fail on strict NATs.');
      return stunOnly;
    }
    return [
      ...stunOnly,
      { urls: 'turn:global.relay.metered.ca:3478?transport=udp', username: u, credential: c },
      { urls: 'turn:global.relay.metered.ca:3478?transport=tcp', username: u, credential: c },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp',  username: u, credential: c },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: u, credential: c },
      { urls: 'turn:in.relay.metered.ca:3478?transport=udp',     username: u, credential: c },
      { urls: 'turn:in.relay.metered.ca:443?transport=tcp',      username: u, credential: c },
    ];
  }

  // ── Connection setup ────────────────────────────────────────────────────────

  _setupConnection(conn) {
    // Intercept RTCPeerConnection to log detailed ICE errors
    let checkCount = 0;
    const checkPC = setInterval(() => {
      checkCount++;
      const pc = conn.peerConnection;
      if (pc) {
        clearInterval(checkPC);
        console.log('[MP] WebRTC RTCPeerConnection intercepted successfully.');
        
        pc.addEventListener('icecandidateerror', (event) => {
          console.warn('[MP] WebRTC ICE Candidate Error:', {
            errorCode: event.errorCode,
            errorText: event.errorText,
            url: event.url
          });
        });

        pc.addEventListener('iceconnectionstatechange', () => {
          console.log('[MP] WebRTC ICE Connection State Changed:', pc.iceConnectionState);
        });
      } else if (checkCount > 50) {
        clearInterval(checkPC);
      }
    }, 100);

    conn.on('open', () => {
      this.connected = true;
      // Send version handshake as the very first packet so both sides can
      // detect a protocol mismatch before any game state is exchanged.
      // Include player name so the partner knows our captain name immediately.
      this._sendJSON(MSG.VERSION_HELLO, { v: PROTOCOL_VERSION, role: this.role, name: this._localPlayerName || '' });
      this.onConnected?.();
      EventEmitter.emit('mp:connected');
    });

    conn.on('data', (raw) => {
      this._handleBinary(raw, conn.peer);
    });

    conn.on('close', () => {
      this._connections.delete(conn.peer);
      this.peerStates.delete(conn.peer);
      if (this._connections.size === 0) {
        this.connected = false;
        this.onDisconnected?.();
        EventEmitter.emit('mp:disconnected');
      }
      EventEmitter.emit('mp:peer_disconnected', { peerId: conn.peer });
    });

    conn.on('error', (err) => {
      console.error('[MP] Connection error:', err);
    });
  }

  // ── Multi-peer relay helper ───────────────────────────────────────────────
  /** Relay a raw binary packet to all connected peers except the sender. */
  _relayBinExcept(buffer, excludePeerId) {
    if (!this.isHost || this._connections.size <= 1) return;
    for (const [peerId, conn] of this._connections) {
      if (peerId !== excludePeerId && conn.open) {
        try { conn.send(buffer); } catch (e) {}
      }
    }
  }

  // ── Message handling (binary dispatch) ────────────────────────────────────

  /**
   * Primary receive handler. Accepts ArrayBuffer (binary packets) or
   * legacy strings/objects (graceful fallback for old clients).
   */
  _handleBinary(raw, senderPeerId = null) {
    try {
      // ── Binary path (v3 protocol) ──────────────────────────────────────────
      if (raw instanceof ArrayBuffer) {
        if (raw.byteLength === 0) return;
        this.diagnostics?.recordBytesReceived(raw.byteLength);
        const { typeId, payload } = NetPacker.unpack(raw);
        if (!payload && typeId !== NetPacker.TYPE.WORLD_LAYOUT_ACK) return;

        switch (typeId) {
          // ── High-frequency ship movement snapshots (20 Hz) ────────────────
          case NetPacker.TYPE.SHIP_STATE: {
            this.diagnostics?.recordSnapshotReceived();
            const interpBuffer = senderPeerId
              ? this.getInterpolationBuffer(senderPeerId)
              : this._partnerInterpBuffer;

            const accepted = interpBuffer.pushSnapshot(payload);
            if (accepted) {
              if (senderPeerId) this.peerStates.set(senderPeerId, payload);
              this.partnerState = payload;
              this.onPartnerShipState?.(payload);
              this.onPeerShipState?.(senderPeerId, payload);
              if (this.isHost && senderPeerId) {
                this._relayBinExcept(raw, senderPeerId);
              }
            }
            break;
          }

          case NetPacker.TYPE.AI_STATE:
            // payload = { ts: number, ships: Array } — include receive timestamp
            // for jitter buffer. Attach receiveTs so AISystem can use it.
            payload.receiveTs = performance.now();
            this.diagnostics?.recordSnapshotReceived();
            this.onAIState?.(payload);
            EventEmitter.emit('mp:ai_state', payload);
            break;

          case NetPacker.TYPE.CANNON_FIRE:
            this.onCannonFire?.(payload);
            if (this.isHost && senderPeerId) {
              this._relayBinExcept(raw, senderPeerId);
            }
            break;

          case NetPacker.TYPE.DAMAGE_EVENT: {
            // Deduplicate: avoid re-applying same damage commit
            if (payload.eventId && this._processedEventIds.has(payload.eventId)) break;
            if (payload.eventId) this._processedEventIds.add(payload.eventId);

            this.onDamageEvent?.(payload);
            EventEmitter.emit('mp:damage_event', payload);
            if (this.isHost && senderPeerId) {
              this._relayBinExcept(raw, senderPeerId);
            }
            break;
          }

          case NetPacker.TYPE.DMG_REQUEST: {
            // Authoritative damage bounds sanity check (anti-cheat)
            const safeDmg = Math.max(1, Math.min(80, Math.round(payload.dmg ?? 15)));
            payload.dmg = safeDmg;
            payload.senderPeerId = senderPeerId;

            // Rate limiting: at most 1 hit per 80ms per sender
            const now = performance.now();
            if (!this._lastDamageRequestTime) this._lastDamageRequestTime = new Map();
            const lastTime = this._lastDamageRequestTime.get(senderPeerId) || 0;
            if (now - lastTime < 80) break;
            this._lastDamageRequestTime.set(senderPeerId, now);

            this.onDamageRequest?.(payload);
            EventEmitter.emit('mp:dmg_request', payload);
            break;
          }

          case NetPacker.TYPE.PING: {
            // Immediately respond with pong carrying client's monotonic sendTime and host's tick
            const pongBuf = NetPacker.packPong(payload.pingId, payload.sendTime, this._authoritativeTick);
            if (senderPeerId && this._connections.has(senderPeerId)) {
              try { this._connections.get(senderPeerId).send(pongBuf); } catch (e) {}
            } else {
              this._sendBin(pongBuf);
            }
            break;
          }

          case NetPacker.TYPE.PONG: {
            // Deliver RTT measurement to diagnostics
            this.diagnostics?.onPongReceived(payload.pingId, payload.sendTime, payload.receiverTick);
            const j = this.diagnostics?.jitterEstimateMs || 0;
            this._partnerInterpBuffer.setMeasuredJitter(j);
            for (const [_, b] of this._interpBuffers) {
              b.setMeasuredJitter(j);
            }
            break;
          }

          case NetPacker.TYPE.SHIP_DESTROYED: {
            if (payload.eventId && this._processedEventIds.has(payload.eventId)) break;
            if (payload.eventId) this._processedEventIds.add(payload.eventId);

            this.onShipDestroyed?.(payload);
            EventEmitter.emit('mp:ship_destroyed', payload);
            if (this.isHost && senderPeerId) {
              this._relayBinExcept(raw, senderPeerId);
            }
            break;
          }

          case NetPacker.TYPE.SHIP_RESPAWNED: {
            if (payload.eventId && this._processedEventIds.has(payload.eventId)) break;
            if (payload.eventId) this._processedEventIds.add(payload.eventId);

            this.onShipRespawned?.(payload);
            EventEmitter.emit('mp:ship_respawned', payload);
            if (this.isHost && senderPeerId) {
              this._relayBinExcept(raw, senderPeerId);
            }
            break;
          }

          case NetPacker.TYPE.WORLD_LAYOUT_ACK:
            console.log('[MP] WORLD_LAYOUT_ACK received from client — stopping retries.');
            this.onWorldLayoutAck?.();
            EventEmitter.emit('mp:world_layout_ack');
            break;

          // ── JSON envelope (infrequent complex messages) ─────────────────────
          case NetPacker.TYPE.JSON_ENVELOPE:
            this._handleJSONEnvelope(payload, senderPeerId);
            break;

          default:
            console.warn('[MP] Unknown binary typeId:', typeId);
        }
        return;
      }

      // ── Legacy fallback path (plain JSON string or object) ─────────────────
      // Handles old clients that haven't updated yet.
      const msg = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      this._handleJSONEnvelope(msg, senderPeerId);

    } catch (e) {
      console.warn('[MP] Bad message:', e);
    }
  }

  /** Handle decoded JSON envelope { t, d }. */
  _handleJSONEnvelope(msg, senderPeerId = null) {
    if (!msg?.t) return;
    switch (msg.t) {
      case MSG.VERSION_HELLO: {
        const theirVersion = msg.d?.v ?? 1;
        // Store partner captain name
        if (msg.d?.name) {
          this.partnerName = msg.d.name;
          this.partnerState.name = msg.d.name;
          if (senderPeerId && this._connections.has(senderPeerId)) {
            const conn = this._connections.get(senderPeerId);
            conn.peerName = msg.d.name;
          }
          EventEmitter.emit('mp:partner_name', { name: msg.d.name, peerId: senderPeerId });
        }
        if (theirVersion !== PROTOCOL_VERSION) {
          this._versionMismatch = true;
          const err = `Protocol mismatch! You are on v${PROTOCOL_VERSION}, partner is on v${theirVersion}. Please both refresh the game.`;
          console.error('[MP]', err);
          EventEmitter.emit('mp:version_mismatch', { ours: PROTOCOL_VERSION, theirs: theirVersion });
        } else {
          console.log('[MP] Protocol version handshake OK — v' + PROTOCOL_VERSION);
        }
        break;
      }
      case MSG.PERK_PICKUP:
        this.onPerkPickup?.(msg.d);
        break;
      case MSG.PING_MAP:
        this.onPingMap?.(msg.d);
        EventEmitter.emit('mp:ping', msg.d);
        break;
      case MSG.FLARE:
        this.onFlare?.();
        EventEmitter.emit('mp:flare', msg.d);
        break;
      case MSG.QUICK_CHAT:
        this.onQuickChat?.(msg.d);
        EventEmitter.emit('mp:quickchat', msg.d);
        break;
      case MSG.RESCUE_REQUEST:
        this._rescueTimer  = msg.d?.timer ?? 60;
        this._rescueActive = true;
        this.onRescueRequest?.(msg.d);
        EventEmitter.emit('mp:rescue_request', msg.d);
        break;
      case MSG.RESCUE_RESOLVE:
        this._rescueActive = false;
        this.onRescueResolve?.(msg.d);
        EventEmitter.emit('mp:rescue_resolve', msg.d);
        break;
      case MSG.WORLD_EVENT:
        this.onWorldEvent?.(msg.d);
        EventEmitter.emit('mp:world_event', msg.d);
        break;
      case MSG.SYNC_WORLD:
        this.onSyncWorld?.(msg.d);
        EventEmitter.emit('mp:sync_world', msg.d);
        break;
      case MSG.WORLD_LAYOUT:
        this.onWorldLayout?.(msg.d);
        EventEmitter.emit('mp:world_layout', msg.d);
        break;
      // Team Battle messages
      case MSG.TB_STATE:
        this.onTeamBattleState?.(msg.d);
        EventEmitter.emit('mp:tb_state', msg.d);
        break;
      case MSG.TB_LOBBY:
        this.onTeamBattleLobby?.(msg.d);
        EventEmitter.emit('mp:tb_lobby', msg.d);
        break;
      case MSG.TB_ACTION:
        this.onTeamBattleAction?.(msg.d);
        EventEmitter.emit('mp:tb_action', msg.d);
        break;
      case MSG.TB_FLAG_EVENT:
        this.onTeamBattleFlagEvent?.(msg.d);
        EventEmitter.emit('mp:tb_flag_event', msg.d);
        break;
      case MSG.TB_ISLAND_HIT:
        this.onTeamBattleIslandHit?.(msg.d);
        EventEmitter.emit('mp:tb_island_hit', msg.d);
        break;
      // Legacy JSON paths for old binary messages (backward compat)
      case 'SS':
        this.partnerState = msg.d;
        this.onPartnerShipState?.(msg.d);
        break;
      case 'AI':
        this.onAIState?.({ ships: msg.d, receiveTs: performance.now() });
        break;
      case 'CF':
        this.onCannonFire?.(msg.d);
        break;
      case 'DE':
        this.onDamageEvent?.(msg.d);
        break;
      case 'DR':
        this.onDamageRequest?.(msg.d);
        break;
      default:
        break;
    }
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  /**
   * Send a raw ArrayBuffer binary packet.
   * Used for high-frequency messages (ship state, AI state, cannon fire, damage).
   */
  _sendBin(buffer) {
    if (!this.connected || !buffer) return;
    this.diagnostics?.recordBytesSent(buffer.byteLength);

    if (this.isHost && this._connections.size > 0) {
      for (const [_, conn] of this._connections) {
        if (conn.open) {
          try { conn.send(buffer); } catch (e) {}
        }
      }
      return;
    }
    if (this._conn && this._conn.open) {
      try { this._conn.send(buffer); } catch (e) {}
    }
  }

  /**
   * Send a JSON-encoded message wrapped in a binary envelope.
   * Used for infrequent/complex messages (world events, perk pickups, chat etc.).
   * @param {string} type  — MSG constant (e.g. MSG.FLARE)
   * @param {*}      data  — JSON-serializable payload
   */
  _sendJSON(type, data) {
    if (!this.connected) return;
    const packed = NetPacker.packJSON(type, data);
    this.diagnostics?.recordBytesSent(packed.byteLength);

    if (this.isHost && this._connections.size > 0) {
      for (const [_, conn] of this._connections) {
        if (conn.open) {
          try { conn.send(packed); } catch (e) {}
        }
      }
      return;
    }
    if (this._conn && this._conn.open) {
      try { this._conn.send(packed); } catch (e) {}
    }
  }

  /**
   * Relay raw binary packet to all other connected peers except the sender (star topology).
   * @param {ArrayBuffer} buffer
   * @param {string} exceptPeerId
   */
  _relayBinExcept(buffer, exceptPeerId) {
    if (!this.isHost || !this._connections || this._connections.size <= 1) return;
    for (const [peerId, conn] of this._connections) {
      if (peerId !== exceptPeerId && conn.open) {
        try { conn.send(buffer); } catch (e) {}
      }
    }
  }

  sendTeamBattleFlagEvent(data)  { this._sendJSON(MSG.TB_FLAG_EVENT, data); }
  sendTeamBattleIslandHit(data)  { this._sendJSON(MSG.TB_ISLAND_HIT, data); }

  /**
   * @deprecated  Use _sendBin() / _sendJSON() directly.
   * Kept for any external callers that still use the old API.
   */
  _send(type, data) { this._sendJSON(type, data); }

  /** Send own ship state to partner — binary packed (25 bytes v3). */
  sendShipState(ship) {
    if (!this.connected || !ship) return;
    if (this.isChannelCongested()) {
      this.diagnostics.backpressureDrops++;
      return;
    }
    this._localShipSeq = (this._localShipSeq + 1) & 0xFFFF;
    const buf = NetPacker.packShipState(
      ship,
      this._localShipSeq,
      this._authoritativeTick,
      this.roomCode,
      ship.lifecycleGen || this._localShipGen
    );
    this._sendBin(buf);
    this.diagnostics?.recordSnapshotSent();
  }

  /** Send cannon fire event — binary packed (26 bytes). */
  sendCannonFire(posL, velL, posR, velR, ammo) {
    this._sendBin(NetPacker.packCannonFire(posL, velL, posR, velR, ammo));
  }

  /** Send a damage event (host-authoritative commit) — binary packed (20 bytes). */
  sendDamageEvent(shipId, damage, remainingHp = 0, isKill = false, isCrit = false) {
    const eventId = ++this._hostEventSeq;
    const buf = NetPacker.packDamageEvent(
      shipId,
      damage,
      remainingHp,
      isKill,
      isCrit,
      eventId,
      this.roomCode,
      this._authoritativeTick
    );
    this._sendBin(buf);
  }

  /** Host: Broadcast authoritative ship destruction event (18 bytes). */
  sendShipDestroyed(shipId, lifecycleGen = 1, respawnSec = 8.0) {
    const eventId = ++this._hostEventSeq;
    const buf = NetPacker.packShipDestroyed(
      shipId,
      lifecycleGen,
      respawnSec,
      eventId,
      this.roomCode,
      this._authoritativeTick
    );
    this._sendBin(buf);
  }

  /** Host: Broadcast authoritative ship respawn event (23 bytes). */
  sendShipRespawned(shipId, newLifecycleGen, spawnX, spawnZ, spawnRy = 0, health = 100) {
    const eventId = ++this._hostEventSeq;
    const buf = NetPacker.packShipRespawned(
      shipId,
      newLifecycleGen,
      spawnX,
      spawnZ,
      spawnRy,
      health,
      eventId,
      this.roomCode,
      this._authoritativeTick
    );
    this._sendBin(buf);
  }

  /** Send perk collected notification — JSON envelope (infrequent). */
  sendPerkPickup(perkId) {
    this._sendJSON(MSG.PERK_PICKUP, { id: perkId });
  }

  /** Send a map ping — JSON envelope. */
  sendPingMap(type, x, z) {
    this._sendJSON(MSG.PING_MAP, { type, x: Math.round(x), z: Math.round(z) });
  }

  /** Send a distress flare — JSON envelope. */
  sendFlare(x, z) {
    this._sendJSON(MSG.FLARE, { x: Math.round(x), z: Math.round(z) });
  }

  /** Send a quick-chat message — JSON envelope. */
  sendQuickChat(msgId) {
    this._sendJSON(MSG.QUICK_CHAT, { id: msgId });
  }

  /** Send rescue request (partner ship sinking) — JSON envelope. */
  sendRescueRequest(x, z, timer = 60) {
    this._sendJSON(MSG.RESCUE_REQUEST, { x: Math.round(x), z: Math.round(z), timer });
  }

  /** Send rescue resolve (rescued or failed) — JSON envelope. */
  sendRescueResolve(success) {
    this._sendJSON(MSG.RESCUE_RESOLVE, { ok: success });
    this._rescueActive = false;
  }

  /** Host → Client: world event text — JSON envelope. */
  sendWorldEvent(text) {
    this._sendJSON(MSG.WORLD_EVENT, { text });
  }

  /**
   * Host → Client: send island positions and loot spawn data so both machines
   * render the same world layout.
   * Called ONCE immediately after the game starts on the host side.
   * @param {Array}  islands   — this._islands from the game
   * @param {Array}  lootPieces — loot._pieces from LootSystem
   */
  sendWorldLayout(islands, lootPieces) {
    const data = {
      islands: islands.map(isl => ({
        id:            isl.id,
        x:             parseFloat(isl.position.x.toFixed(2)),
        z:             parseFloat(isl.position.z.toFixed(2)),
        sandScale:     parseFloat(isl.sandScale.toFixed(3)),
        fortified:     isl.fortified,
        collisionRadius: parseFloat(isl.collisionRadius.toFixed(2)),
      })),
      loot: lootPieces.map(p => ({
        x: parseFloat(p.group.position.x.toFixed(2)),
        z: parseFloat(p.group.position.z.toFixed(2)),
      })),
    };
    this._sendJSON(MSG.WORLD_LAYOUT, data);
  }

  /**
   * Host → Client: broadcast current enemy ship states — binary packed.
   * Each ship takes 12 bytes vs ~50 bytes JSON. For 10 ships: 120B vs 500B.
   * @param {Array<{id,cls,fac,x,z,ry,hp,mhp}>} aiShips — from AISystem.getSerializableState()
   */
  sendAIState(aiShips) {
    this._sendBin(NetPacker.packAIState(aiShips));
  }

  /**
   * Client → Host: request that the host applies damage to an enemy ship — binary packed (14 bytes v3).
   * @param {string} shipId — the ship.id assigned by the host
   * @param {number} damage — raw damage amount (host will re-apply armor)
   * @param {string} [ammo='ROUND'] — ammo type
   */
  sendDamageRequest(shipId, damage, ammo = 'ROUND') {
    const requestId = ++this._localShipSeq;
    this._sendBin(NetPacker.packDamageRequest(shipId, damage, requestId, this.roomCode, ammo));
  }

  /**
   * Client → Host: acknowledge receipt of world layout.
   * Triggers host to stop retrying the WORLD_LAYOUT broadcast.
   */
  sendWorldLayoutAck() {
    this._sendBin(NetPacker.packWorldLayoutAck());
    console.log('[MP] Sent WORLD_LAYOUT_ACK to host.');
  }

  /** Host → Client: full world snapshot (economy, island states, sky time) — JSON envelope. */
  sendWorldSnapshot(economy, islands, dayPhase = 0) {
    const snap = {
      gold:     economy.resources.gold,
      crew:     economy.resources.crew,
      wood:     economy.resources.wood,
      dayPhase: parseFloat(dayPhase.toFixed(4)),  // sync day/night clock
      islands:  islands.map(isl => ({
        id:       isl.id,
        captured: isl.captured,
        owner:    isl.owner,
        hp:       isl.hp,
      })),
    };
    this._sendJSON(MSG.SYNC_WORLD, snap);
  }

  /** Broadcast Team Battle state to peers. */
  sendTeamBattleState(state) {
    this._sendJSON(MSG.TB_STATE, state);
  }

  /** Send Team Battle action (start match, countdown, etc.) */
  sendTeamBattleAction(action, config = null) {
    this._sendJSON(MSG.TB_ACTION, { action, config });
  }

  /** Send Team Battle lobby update. */
  sendTeamBattleLobby(lobbyData) {
    this._sendJSON(MSG.TB_LOBBY, lobbyData);
  }

  /** Client → Host: Send fortress hit event */
  sendTeamBattleIslandHit(hitData) {
    this._sendJSON(MSG.TB_ISLAND_HIT, hitData);
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  /**
   * Call every frame. Handles periodic ship sync and rescue timer.
   * @param {number} delta
   * @param {Ship} playerShip
   * @param {EconomySystem} [economy]    — host only
   * @param {Array} [islands]            — host only
   * @param {Array} [aiSerializedState]  — host only: output of AISystem.getSerializableState()
   * @param {number} [dayPhase]          — host only: sky._dayPhase for day/night sync
   */
  update(delta, playerShip, economy = null, islands = null, aiSerializedState = null, dayPhase = 0) {
    if (!this.connected) return;

    this._authoritativeTick++;
    this.diagnostics.latestAuthoritativeTick = this._authoritativeTick;
    this.diagnostics.update(delta, (this.peerStates?.size || 0) + 1);

    // ── Ship state sync ──────────────────────────────────────────────────────
    this._syncTimer -= delta;
    if (this._syncTimer <= 0) {
      this._syncTimer = SHIP_SYNC_RATE;
      if (playerShip?.isAlive) {
        this.sendShipState(playerShip);
      }
    }

    // ── Host: world snapshot ─────────────────────────────────────────────────
    if (this.isHost && economy && islands) {
      this._worldSyncTimer -= delta;
      if (this._worldSyncTimer <= 0) {
        this._worldSyncTimer = WORLD_SYNC_RATE;
        this.sendWorldSnapshot(economy, islands, dayPhase);
      }
    }

    // ── Host: AI enemy state broadcast (10 Hz) ───────────────────────────────
    if (this.isHost && aiSerializedState) {
      this._aiSyncTimer -= delta;
      if (this._aiSyncTimer <= 0) {
        this._aiSyncTimer = AI_SYNC_RATE;
        this.sendAIState(aiSerializedState);
      }
    }

    // ── Rescue countdown ─────────────────────────────────────────────────────
    if (this._rescueActive) {
      this._rescueTimer -= delta;
      EventEmitter.emit('mp:rescue_tick', { timer: this._rescueTimer });
      if (this._rescueTimer <= 0) {
        this._rescueActive = false;
        EventEmitter.emit('mp:rescue_failed');
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Sample smooth interpolation from entity interpolation buffer. */
  getInterpolatedPartnerState(delta = 0) {
    const sampled = this._partnerInterpBuffer.sample();
    if (sampled) return sampled;
    const s = this.partnerState;
    return {
      x:  s.x  + s.vx * delta,
      y:  s.y,
      z:  s.z  + s.vz * delta,
      ry: s.ry,
      hp: s.hp,
      mhp: s.mhp,
    };
  }

  disconnect() {
    this._conn?.close();
    this._peer?.destroy();
    this.connected = false;
  }

  /**
   * @deprecated Use _buildIceServers() instead.
   * Kept as a thin wrapper in case anything still calls it.
   */
  static _normalizeIceServers(serversList) {
    if (!serversList || serversList.length === 0) return [];
    const cred = serversList.find(s => s.username && s.credential);
    if (!cred) return [];
    const { username, credential } = cred;
    return [
      { urls: 'turn:global.relay.metered.ca:3478?transport=udp', username, credential },
      { urls: 'turn:global.relay.metered.ca:3478?transport=tcp', username, credential },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username, credential },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username, credential },
    ];
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /** Load PeerJS from CDN if not already present. */
  static _loadPeerJS() {
    if (window.Peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      script.onload  = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /** Generate a human-readable 6-character room code. */
  static _generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}

export default MultiplayerSystem;
