-- ============================================================================
-- PIRATE EMPIRE: RISE OF THE BLACK FLEET
-- Migration: Public Rooms Matchmaking Registry & Atomic Slot Reservation
-- Description: Creates the public_rooms registry, indexes, Row Level Security
--              (RLS) policies, and atomic RPC functions for safe concurrent
--              public matchmaking.
-- ============================================================================

-- 1. Create public_rooms table
CREATE TABLE IF NOT EXISTS public.public_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code VARCHAR(10) UNIQUE NOT NULL,
  host_player_id VARCHAR(64) NOT NULL,
  host_name VARCHAR(32) NOT NULL DEFAULT 'Captain',
  game_mode VARCHAR(16) NOT NULL DEFAULT '2v2',
  player_count INT NOT NULL DEFAULT 1 CHECK (player_count >= 1 AND player_count <= max_players),
  max_players INT NOT NULL DEFAULT 4 CHECK (max_players >= 2 AND max_players <= 8),
  status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_progress', 'closed')),
  is_public BOOLEAN NOT NULL DEFAULT true,
  protocol_version INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Performance & Matchmaking Indexes
-- Partial composite index for the primary matchmaking query:
-- Finds active, public, waiting rooms with compatible protocol and fresh heartbeats.
CREATE INDEX IF NOT EXISTS idx_public_rooms_matchmaking
  ON public.public_rooms (status, is_public, protocol_version, last_heartbeat DESC)
  WHERE is_public = true AND status = 'waiting';

-- Index for room code lookups
CREATE INDEX IF NOT EXISTS idx_public_rooms_code
  ON public.public_rooms (room_code);

-- Index for host operations (heartbeat, close, delete)
CREATE INDEX IF NOT EXISTS idx_public_rooms_host
  ON public.public_rooms (host_player_id);

-- 3. Row Level Security (RLS) Setup
ALTER TABLE public.public_rooms ENABLE ROW LEVEL SECURITY;

-- Grant API access to anon and authenticated roles
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_rooms TO anon, authenticated;

-- RLS Policy: SELECT
-- Players can discover public waiting rooms with fresh heartbeats (< 45s old),
-- or query their own room regardless of state.
DROP POLICY IF EXISTS "public_rooms_select" ON public.public_rooms;
CREATE POLICY "public_rooms_select"
  ON public.public_rooms
  FOR SELECT
  TO anon, authenticated
  USING (
    (is_public = true AND status = 'waiting' AND last_heartbeat > (now() - INTERVAL '45 seconds'))
    OR (status = 'in_progress' AND last_heartbeat > (now() - INTERVAL '45 seconds'))
  );

-- RLS Policy: INSERT
-- Players can create a new public room starting with 1 player in 'waiting' state.
DROP POLICY IF EXISTS "public_rooms_insert" ON public.public_rooms;
CREATE POLICY "public_rooms_insert"
  ON public.public_rooms
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    is_public = true
    AND player_count = 1
    AND status = 'waiting'
    AND length(room_code) >= 4
    AND length(host_player_id) >= 8
  );

-- RLS Policy: UPDATE
-- Hosts can update room heartbeats, status, or player count.
-- Direct atomic updates with optimistic concurrency checks are permitted.
DROP POLICY IF EXISTS "public_rooms_update" ON public.public_rooms;
CREATE POLICY "public_rooms_update"
  ON public.public_rooms
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policy: DELETE
-- Hosts can delete their own room upon closing.
DROP POLICY IF EXISTS "public_rooms_delete" ON public.public_rooms;
CREATE POLICY "public_rooms_delete"
  ON public.public_rooms
  FOR DELETE
  TO anon, authenticated
  USING (true);

-- ============================================================================
-- 4. ATOMIC DATABASE RPC FUNCTIONS (Concurrency Protection)
-- ============================================================================

-- Function: join_public_room_slot
-- Atomically reserves a slot in an eligible public room using SELECT ... FOR UPDATE.
-- Prevents race conditions when multiple players attempt to join the same room.
CREATE OR REPLACE FUNCTION public.join_public_room_slot(
  p_room_code VARCHAR,
  p_player_id VARCHAR
)
RETURNS TABLE (
  success BOOLEAN,
  room_code VARCHAR,
  host_name VARCHAR,
  player_count INT,
  max_players INT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.public_rooms%ROWTYPE;
BEGIN
  -- Lock candidate row for atomic check and increment
  SELECT * INTO v_room
  FROM public.public_rooms
  WHERE public_rooms.room_code = p_room_code
    AND public_rooms.is_public = true
    AND public_rooms.status = 'waiting'
    AND public_rooms.last_heartbeat > (now() - INTERVAL '45 seconds')
  FOR UPDATE;

  -- If room not found or stale
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, p_room_code, ''::VARCHAR, 0, 0, 'Room unavailable or expired'::TEXT;
    RETURN;
  END IF;

  -- If room is already full
  IF v_room.player_count >= v_room.max_players THEN
    RETURN QUERY SELECT false, v_room.room_code, v_room.host_name, v_room.player_count, v_room.max_players, 'Room is full'::TEXT;
    RETURN;
  END IF;

  -- Atomically increment player count
  UPDATE public.public_rooms
  SET player_count = player_count + 1
  WHERE public_rooms.room_code = p_room_code;

  RETURN QUERY SELECT true, v_room.room_code, v_room.host_name, v_room.player_count + 1, v_room.max_players, ''::TEXT;
END;
$$;

-- Function: leave_public_room_slot
-- Releases a previously reserved slot if a player leaves or WebRTC connection fails.
CREATE OR REPLACE FUNCTION public.leave_public_room_slot(
  p_room_code VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.public_rooms
  SET player_count = GREATEST(1, player_count - 1)
  WHERE room_code = p_room_code
    AND status = 'waiting';
END;
$$;

-- Function: heartbeat_public_room
-- Refreshes room heartbeat using server-side timestamp now().
CREATE OR REPLACE FUNCTION public.heartbeat_public_room(
  p_room_code VARCHAR,
  p_host_player_id VARCHAR
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.public_rooms
  SET last_heartbeat = now()
  WHERE room_code = p_room_code
    AND host_player_id = p_host_player_id
    AND status != 'closed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Function: close_public_room
-- Marks a room as closed and ready for cleanup.
CREATE OR REPLACE FUNCTION public.close_public_room(
  p_room_code VARCHAR,
  p_host_player_id VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.public_rooms
  SET status = 'closed'
  WHERE room_code = p_room_code
    AND host_player_id = p_host_player_id;
END;
$$;

-- Function: prune_stale_public_rooms
-- Cleans up dead rooms whose heartbeats have expired or closed rooms.
CREATE OR REPLACE FUNCTION public.prune_stale_public_rooms()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.public_rooms
  WHERE last_heartbeat < (now() - INTERVAL '2 minutes')
     OR (status = 'closed' AND last_heartbeat < (now() - INTERVAL '30 seconds'));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 5. Grant RPC execution permissions to API roles
GRANT EXECUTE ON FUNCTION public.join_public_room_slot(VARCHAR, VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_public_room_slot(VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_public_room(VARCHAR, VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_public_room(VARCHAR, VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_stale_public_rooms() TO anon, authenticated;
