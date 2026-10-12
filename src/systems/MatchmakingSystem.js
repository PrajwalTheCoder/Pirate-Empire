/**
 * MatchmakingSystem — Supabase-backed Public Matchmaking & Room Management
 *
 * Architecture:
 * - Public Registry: public_rooms table in Supabase
 * - Atomic Slot Reservation: RPC join_public_room_slot (with optimistic CAS fallback)
 * - Safe Heartbeats: 15-second heartbeat loop refreshing server-side timestamp
 * - Room Isolation: Host operations strictly filter by host_player_id === clientId
 * - Controlled Lifecycle: No automated blind timeouts; players remain in honest lobbies
 */

import { supabase } from '../utils/SupabaseClient.js';
import { MultiplayerSystem, PROTOCOL_VERSION } from './MultiplayerSystem.js';

const HEARTBEAT_INTERVAL_MS = 15000;   // 15 seconds
const STALE_ROOM_THRESHOLD_SEC = 45;   // 45 seconds max age for valid heartbeat
const QUERY_TIMEOUT_MS = 4000;          // 4s timeout for DB queries
const WEBRTC_CONNECT_TIMEOUT_MS = 8000; // 8s timeout for WebRTC handshake

/** Wraps a promise with a timeout */
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[Matchmaking] ${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export class MatchmakingSystem {
  /**
   * @param {import('../main.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.clientId = this._getOrCreateClientId();
    this.currentRoomCode = null;
    this.isHosting = false;
    this.isPublicRoom = false;
    this._heartbeatTimer = null;
    this._heartbeatInFlight = false;
    this._windowListenersBound = false;

    this._bindWindowLifecycle();
  }

  _getOrCreateClientId() {
    try {
      const stored = localStorage.getItem('pe_mm_client_id');
      if (stored && stored.length >= 8) return stored;
      const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'cli_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
      localStorage.setItem('pe_mm_client_id', newId);
      return newId;
    } catch {
      return 'cli_' + Math.random().toString(36).substring(2, 12);
    }
  }

  _bindWindowLifecycle() {
    if (this._windowListenersBound || typeof window === 'undefined') return;
    this._windowListenersBound = true;

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isHosting && this.currentRoomCode && this.isPublicRoom) {
        this.sendHeartbeat().catch(() => {});
      }
    });

    window.addEventListener('beforeunload', () => {
      if (this.isHosting && this.currentRoomCode && this.isPublicRoom) {
        this.closeHostedRoom(this.currentRoomCode).catch(() => {});
      }
    });
  }

  // ── SEARCH & JOIN PUBLIC ROOMS ───────────────────────────────────────────

  /**
   * Search for eligible public rooms and attempt to join over WebRTC.
   * Does NOT auto-host or auto-start an AI game on failure.
   *
   * @param {function} [onStatus]
   * @returns {Promise<{success: boolean, role?: 'CLIENT', roomCode?: string, reason?: string, error?: string}>}
   */
  async searchAndJoinPublicRoom(onStatus) {
    const report = (msg) => {
      console.log('[Matchmaking]', msg);
      if (typeof onStatus === 'function') onStatus(msg);
    };

    report('🔍 Scanning public registry for available fleets...');

    let eligibleRooms = [];
    try {
      eligibleRooms = await this.searchPublicRooms();
      console.log(`[Matchmaking] Discovered ${eligibleRooms.length} eligible public room(s).`);
    } catch (err) {
      console.warn('[Matchmaking] Public room query error:', err.message);
      return { success: false, reason: 'REGISTRY_ERROR', error: 'Could not reach registry. Check network connection.' };
    }

    if (eligibleRooms.length === 0) {
      return { success: false, reason: 'NO_ROOMS_FOUND' };
    }

    report(`🔗 Found ${eligibleRooms.length} active fleet(s). Connecting to best match...`);

    // Attempt to join each discovered room in order
    for (const room of eligibleRooms) {
      report(`🔗 Reserving slot in fleet [${room.room_code}] (Admiral ${room.host_name})...`);

      // 1. Atomic reservation in database
      const slotClaimed = await this.claimRoomSlot(room.room_code, room.player_count);
      if (!slotClaimed.success) {
        console.warn(`[Matchmaking] Slot claim rejected in room ${room.room_code}:`, slotClaimed.reason);
        continue;
      }

      report(`🔗 Slot secured! Establishing WebRTC connection to [${room.room_code}]...`);

      // 2. Establish WebRTC connection
      const connectResult = await this._attemptPeerConnection(room.room_code);
      if (connectResult.success) {
        this.currentRoomCode = room.room_code;
        this.isHosting = false;
        this.isPublicRoom = true;
        report(`✅ WebRTC connected to Admiral ${room.host_name}!`);
        return { success: true, role: 'CLIENT', roomCode: room.room_code };
      } else {
        console.warn(`[Matchmaking] WebRTC connection failed to ${room.room_code}:`, connectResult.error);
        // Release the slot since connection failed
        await this.releaseRoomSlot(room.room_code).catch(() => {});
      }
    }

    return { success: false, reason: 'CONNECTION_FAILED', error: 'Could not connect to any open fleets.' };
  }

  /**
   * Search query: is_public = true, status = 'waiting', protocol_version matches,
   * fresh heartbeat (< 45s old), player_count < max_players.
   */
  async searchPublicRooms() {
    const minHeartbeat = new Date(Date.now() - STALE_ROOM_THRESHOLD_SEC * 1000).toISOString();

    const query = supabase
      .from('public_rooms')
      .select('id, room_code, host_player_id, host_name, game_mode, player_count, max_players, status, protocol_version, last_heartbeat')
      .eq('is_public', true)
      .eq('status', 'waiting')
      .in('protocol_version', [2, 3])
      .gt('last_heartbeat', minHeartbeat)
      .order('created_at', { ascending: true })
      .limit(10);

    const { data, error } = await withTimeout(query, QUERY_TIMEOUT_MS, 'searchPublicRooms');

    if (error) throw error;

    const now = Date.now();
    return (data || []).filter(room => {
      if (room.player_count >= room.max_players) return false;
      const hbTime = new Date(room.last_heartbeat).getTime();
      return (now - hbTime) <= STALE_ROOM_THRESHOLD_SEC * 1000;
    });
  }

  /**
   * Atomic slot claim via PostgreSQL RPC join_public_room_slot, with optimistic CAS fallback.
   */
  async claimRoomSlot(roomCode, currentCount) {
    try {
      const rpcPromise = supabase.rpc('join_public_room_slot', {
        p_room_code: roomCode,
        p_player_id: this.clientId,
      });

      const { data, error } = await withTimeout(rpcPromise, 2500, 'rpc join_public_room_slot');

      if (!error && data) {
        const result = Array.isArray(data) ? data[0] : data;
        if (result && result.success) {
          return { success: true, roomCode: result.room_code };
        }
        return { success: false, reason: result?.error_message || 'Room occupied or full' };
      }
    } catch {
      // Fall through to CAS
    }

    try {
      const casPromise = supabase
        .from('public_rooms')
        .update({ player_count: currentCount + 1 })
        .eq('room_code', roomCode)
        .eq('player_count', currentCount)
        .eq('status', 'waiting')
        .select('room_code, player_count');

      const { data: casData, error: casError } = await withTimeout(casPromise, 2500, 'cas claim slot');

      if (!casError && casData && casData.length > 0) {
        return { success: true, roomCode };
      }
      return { success: false, reason: 'Concurrent slot claim collision' };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  /**
   * Release reserved slot upon WebRTC failure or cancellation.
   */
  async releaseRoomSlot(roomCode) {
    try {
      const rpcPromise = supabase.rpc('leave_public_room_slot', { p_room_code: roomCode });
      await withTimeout(rpcPromise, 2000, 'rpc leave_public_room_slot');
      return;
    } catch {
      // Fallback
    }

    try {
      const { data } = await supabase
        .from('public_rooms')
        .select('player_count')
        .eq('room_code', roomCode)
        .single();

      if (data && data.player_count > 1) {
        await supabase
          .from('public_rooms')
          .update({ player_count: data.player_count - 1 })
          .eq('room_code', roomCode);
      }
    } catch (e) {
      console.warn('[Matchmaking] releaseRoomSlot error:', e.message);
    }
  }

  /**
   * Attempt PeerJS WebRTC connection with timeout.
   */
  async _attemptPeerConnection(roomCode) {
    return new Promise((resolve) => {
      let isSettled = false;
      const cleanupAndResolve = (result) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timerId);
        resolve(result);
      };

      const timerId = setTimeout(() => {
        try { mpInstance?.disconnect?.(); } catch {}
        cleanupAndResolve({ success: false, error: 'WebRTC connection timed out (8s)' });
      }, WEBRTC_CONNECT_TIMEOUT_MS);

      const mpInstance = new MultiplayerSystem('CLIENT', roomCode, this.game.playerName);
      this.game.mp = mpInstance;

      mpInstance.init()
        .then(() => {
          this.game._wireTeamBattleNetworkEvents?.();
          cleanupAndResolve({ success: true, mp: mpInstance });
        })
        .catch((err) => {
          cleanupAndResolve({ success: false, error: err.message });
        });
    });
  }

  // ── HOSTING (PUBLIC OR PRIVATE) ──────────────────────────────────────────

  /**
   * Host a room. Does NOT start the match automatically.
   * The host stays in the waiting lobby until they deliberately start the battle.
   *
   * @param {{ isPublic?: boolean }} options
   * @param {function} [onStatus]
   * @returns {Promise<{success: boolean, role: 'HOST', roomCode: string}>}
   */
  async hostRoom(options = {}, onStatus) {
    const isPublic = options.isPublic !== false;
    const report = (msg) => {
      console.log('[Matchmaking]', msg);
      if (typeof onStatus === 'function') onStatus(msg);
    };

    report('🌐 Initializing WebRTC relay host...');

    // 1. Initialize PeerJS Host
    const mpInstance = new MultiplayerSystem('HOST', null, this.game.playerName);
    this.game.mp = mpInstance;

    const roomCode = await mpInstance.init((statusMsg) => {
      report(statusMsg);
    });

    this.currentRoomCode = roomCode;
    this.isHosting = true;
    this.isPublicRoom = isPublic;
    this.game._wireTeamBattleNetworkEvents?.();

    // 2. Register in Supabase ONLY IF PUBLIC
    if (isPublic) {
      report('⚓ Registering fleet in public registry...');
      const roomRecord = {
        room_code: roomCode,
        host_player_id: this.clientId,
        host_name: this.game.playerName || 'Admiral Jack',
        game_mode: '2v2',
        player_count: 1,
        max_players: 4,
        status: 'waiting',
        is_public: true,
        protocol_version: PROTOCOL_VERSION,
        created_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      };

      let registeredInDb = false;
      try {
        const { error: insertError } = await withTimeout(
          supabase.from('public_rooms').insert([roomRecord]),
          QUERY_TIMEOUT_MS,
          'insert public room'
        );

        if (insertError) {
          console.warn('[Matchmaking] Room registration error:', insertError.message);
        } else {
          console.log('[Matchmaking] ✅ Public room registered:', roomCode);
          registeredInDb = true;
          this.startHeartbeat(roomCode);
        }
      } catch (dbErr) {
        console.warn('[Matchmaking] Room DB insert threw error:', dbErr.message);
      }
      this.isPublicRoom = registeredInDb;
    } else {
      console.log('[Matchmaking] Private room initialized (not listed in public registry):', roomCode);
    }

    report(`✅ Fleet ready! Room: ${roomCode}`);
    return { success: true, role: 'HOST', roomCode, isPublic: this.isPublicRoom, dbRegistered: this.isPublicRoom };
  }

  // ── HEARTBEAT AND CLEANUP ────────────────────────────────────────────────

  startHeartbeat(roomCode) {
    this.stopHeartbeat();
    this.currentRoomCode = roomCode;
    this.isHosting = true;
    this.isPublicRoom = true;

    this._heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((err) => {
        console.warn('[Matchmaking] Heartbeat tick error:', err.message);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  async sendHeartbeat() {
    if (!this.currentRoomCode || !this.isHosting || !this.isPublicRoom || this._heartbeatInFlight) return;
    this._heartbeatInFlight = true;

    try {
      const rpcPromise = supabase.rpc('heartbeat_public_room', {
        p_room_code: this.currentRoomCode,
        p_host_player_id: this.clientId,
      });

      const { data, error } = await withTimeout(rpcPromise, 2500, 'rpc heartbeat');
      if (!error && data) return;
    } catch {
      // Direct update fallback
    }

    try {
      const updatePromise = supabase
        .from('public_rooms')
        .update({ last_heartbeat: new Date().toISOString() })
        .eq('room_code', this.currentRoomCode)
        .eq('host_player_id', this.clientId)
        .neq('status', 'closed');

      await withTimeout(updatePromise, 2500, 'direct heartbeat');
    } catch (e) {
      console.warn('[Matchmaking] Direct heartbeat error:', e.message);
    } finally {
      this._heartbeatInFlight = false;
    }
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._heartbeatInFlight = false;
  }

  async setRoomStatus(roomCode, status) {
    if (!roomCode || !this.clientId || !this.isPublicRoom) return;
    try {
      await withTimeout(
        supabase
          .from('public_rooms')
          .update({ status, last_heartbeat: new Date().toISOString() })
          .eq('room_code', roomCode)
          .eq('host_player_id', this.clientId),
        2500,
        `setRoomStatus ${status}`
      );
    } catch (e) {
      console.warn(`[Matchmaking] setRoomStatus(${status}) error:`, e.message);
    }
  }

  async closeHostedRoom(roomCode = this.currentRoomCode) {
    if (!roomCode || !this.isHosting || !this.isPublicRoom) {
      this.stopHeartbeat();
      this.isHosting = false;
      this.currentRoomCode = null;
      return;
    }

    const code = roomCode;
    const hostId = this.clientId;

    this.stopHeartbeat();
    this.isHosting = false;
    this.currentRoomCode = null;

    try {
      const rpcPromise = supabase.rpc('close_public_room', {
        p_room_code: code,
        p_host_player_id: hostId,
      });
      await withTimeout(rpcPromise, 2000, 'rpc close_public_room');
      return;
    } catch {
      // Fallback
    }

    try {
      await withTimeout(
        supabase
          .from('public_rooms')
          .delete()
          .eq('room_code', code)
          .eq('host_player_id', hostId),
        2000,
        'direct room delete'
      );
    } catch (e) {
      console.warn('[Matchmaking] Room cleanup delete error:', e.message);
    }
  }

  cancel() {
    this.cleanupSession();
  }

  cleanupSession() {
    this.stopHeartbeat();
    if (this.isHosting && this.currentRoomCode && this.isPublicRoom) {
      this.closeHostedRoom(this.currentRoomCode).catch(() => {});
    }
    this.currentRoomCode = null;
    this.isHosting = false;
    this.isPublicRoom = false;
  }
}

export default MatchmakingSystem;
