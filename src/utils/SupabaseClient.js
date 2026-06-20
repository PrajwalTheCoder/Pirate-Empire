import { createClient } from '@supabase/supabase-js';

// ── Credentials are stored in .env.local — never hardcode secrets in source. ──
// Vite exposes VITE_* vars via import.meta.env at build time.
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[Supabase] ❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Run a quick connection test on module load so errors appear in DevTools ──
(async () => {
  try {
    const { data, error } = await supabase
      .from('leaderboard')
      .select('id')
      .limit(1);
    if (error) {
      console.error('[Supabase] ❌ CONNECTION TEST FAILED:', error.message, error);
    } else {
      console.log('[Supabase] ✅ Connection OK — leaderboard reachable, rows:', data?.length ?? 0);
    }
  } catch (e) {
    console.error('[Supabase] ❌ CONNECTION TEST THREW:', e);
  }
})();

// ── Wraps a promise with a timeout so requests never hang silently ───────────
function withTimeout(promise, ms = 10000, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[Supabase] ${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Helper to insert a record directly into the leaderboard table (with core fallback).
 */
async function insertToLeaderboardDirect(fullRow) {
  try {
    const { error } = await withTimeout(
      supabase.from('leaderboard').insert([fullRow]),
      10000, 'leaderboard insert'
    );
    if (!error) {
      console.log('[Supabase] ✅ Leaderboard score inserted (full)');
      return true;
    }
    console.warn('[Supabase] ⚠️ Leaderboard full insert failed, trying core fields:', error.message);
    
    const coreRow = {
      player_name:      fullRow.player_name,
      score:            fullRow.score,
      gold:             fullRow.gold,
      ships_destroyed:  fullRow.ships_destroyed,
      islands_captured: fullRow.islands_captured,
      time_survived:    fullRow.time_survived,
      player_id:        fullRow.player_id,
    };
    const { error: coreErr } = await withTimeout(
      supabase.from('leaderboard').insert([coreRow]),
      10000, 'leaderboard core insert'
    );
    if (!coreErr) {
      console.log('[Supabase] ✅ Leaderboard score inserted (core fallback)');
      return true;
    }
    console.error('[Supabase] ❌ Leaderboard core insert also failed:', coreErr.message);
    return false;
  } catch (err) {
    console.error('[Supabase] Leaderboard direct insert threw error:', err.message);
    return false;
  }
}

/**
 * Submit player score and stats to Supabase leaderboard.
 * 1. Increments play_count in the players table
 * 2. Logs run history in player_runs table
 * 3. Updates leaderboard only if it's a new personal high score
 */
export async function submitScore(
  playerName, score, gold, kills, islands, time,
  allies = 0, treasures = 0, bossDefeated = false, outcome = 'defeat',
  playerId = null
) {
  const name = (playerName || 'Anonymous Pirate').trim() || 'Anonymous Pirate';

  const fullRow = {
    player_name:      name,
    score:            Math.round(score),
    gold:             Math.round(gold),
    ships_destroyed:  Math.round(kills),
    islands_captured: Math.round(islands),
    time_survived:    Math.round(time),
    ally_ships:       Math.round(allies),
    treasures_found:  Math.round(treasures),
    boss_defeated:    bossDefeated,
    outcome:          outcome,
    player_id:        playerId,
  };

  console.log('[Supabase] Submitting score workflow for:', name, 'Score:', score);

  // ── Step 1: Increment play_count on player profile ───────────────────────
  if (playerId) {
    try {
      const { data: player, error: fetchErr } = await withTimeout(
        supabase.from('players').select('play_count').eq('id', playerId).maybeSingle(),
        5000, 'fetch play_count'
      );
      if (!fetchErr) {
        const newCount = (player?.play_count ?? 0) + 1;
        await withTimeout(
          supabase.from('players').update({ play_count: newCount }).eq('id', playerId),
          5000, 'update play_count'
        );
        console.log(`[Supabase] Play count incremented to ${newCount} for player ${playerId}`);
      } else {
        console.error('[Supabase] Failed to fetch play_count:', fetchErr.message);
      }
    } catch (err) {
      console.error('[Supabase] Error incrementing play count:', err.message);
    }
  }

  // ── Step 2: Log run details into player_runs history ─────────────────────
  try {
    console.log('[Supabase] Logging run to player_runs history...');
    const { error: runErr } = await withTimeout(
      supabase.from('player_runs').insert([fullRow]),
      10000, 'player_runs insert'
    );
    if (!runErr) {
      console.log('[Supabase] ✅ Run logged to history (fullRow)');
    } else {
      console.warn('[Supabase] ⚠️ player_runs full insert failed, trying core fields:', runErr.message);
      const coreRow = {
        player_id:        fullRow.player_id,
        player_name:      fullRow.player_name,
        score:            fullRow.score,
        gold:             fullRow.gold,
        ships_destroyed:  fullRow.ships_destroyed,
        islands_captured: fullRow.islands_captured,
        time_survived:    fullRow.time_survived,
        outcome:          fullRow.outcome,
      };
      const { error: coreRunErr } = await withTimeout(
        supabase.from('player_runs').insert([coreRow]),
        10000, 'player_runs core insert'
      );
      if (!coreRunErr) {
        console.log('[Supabase] ✅ Run logged to history (coreRow fallback)');
      } else {
        console.error('[Supabase] ❌ player_runs core insert also failed:', coreRunErr.message);
      }
    }
  } catch (err) {
    console.error('[Supabase] Error logging run to history:', err.message);
  }

  // ── Step 3: Update leaderboard only if it's the highest score ─────────────
  if (!playerId) {
    console.log('[Supabase] No playerId provided; submitting as anonymous insert to leaderboard');
    return await insertToLeaderboardDirect(fullRow);
  }

  try {
    console.log(`[Supabase] Checking existing high score in leaderboard for player ${playerId}...`);
    const { data: existingRows, error: existErr } = await withTimeout(
      supabase
        .from('leaderboard')
        .select('score')
        .eq('player_id', playerId)
        .order('score', { ascending: false })
        .limit(1),
      5000, 'get existing leaderboard'
    );

    if (existErr) {
      console.error('[Supabase] Failed to check existing high score:', existErr.message);
      return await insertToLeaderboardDirect(fullRow);
    }

    const existingScore = existingRows && existingRows.length > 0 ? existingRows[0].score : null;

    if (existingScore !== null) {
      console.log(`[Supabase] Existing high score: ${existingScore}, Current run score: ${fullRow.score}`);
      if (fullRow.score > existingScore) {
        console.log('[Supabase] New high score! Inserting into leaderboard...');
        // Due to RLS restrictions blocking UPDATE/DELETE for anonymous users,
        // we insert a new high score entry rather than updating the existing one.
        // The leaderboard will display only the highest score per player via client-side deduplication.
        return await insertToLeaderboardDirect(fullRow);
      } else {
        console.log('[Supabase] Current run is not a new high score. Leaderboard left unchanged.');
        return true;
      }
    } else {
      console.log('[Supabase] No existing high score found. Inserting into leaderboard...');
      return await insertToLeaderboardDirect(fullRow);
    }
  } catch (err) {
    console.error('[Supabase] Error processing leaderboard update:', err.message);
    return false;
  }
}

/**
 * Fetch top high scores from Supabase leaderboard.
 * @param {number} [limit=10]
 * @returns {Promise<Array<object>>}
 */
export async function getLeaderboard(limit = 10) {
  try {
    // Fetch a larger pool of rows to account for duplicate player entries
    const fetchLimit = Math.max(limit * 10, 100);
    const { data, error } = await withTimeout(
      supabase
        .from('leaderboard')
        .select('*')
        .order('score', { ascending: false })
        .limit(fetchLimit),
      10000, 'getLeaderboard'
    );
    if (error) {
      console.error('[Supabase] ❌ getLeaderboard failed:', error.message, error);
      return [];
    }

    // Deduplicate by player_id (or player_name if player_id is null), keeping only the highest score (first occurrence)
    const uniqueScores = [];
    const seenPlayers = new Set();

    for (const row of (data ?? [])) {
      const playerKey = row.player_id || row.player_name;
      if (!seenPlayers.has(playerKey)) {
        seenPlayers.add(playerKey);
        uniqueScores.push(row);
      }
    }

    // Return only the requested number of entries
    const result = uniqueScores.slice(0, limit);
    console.log('[Supabase] ✅ Leaderboard fetched and deduplicated:', result.length, 'entries');
    return result;
  } catch (err) {
    console.error('[Supabase] ❌ getLeaderboard threw:', err.message);
    return [];
  }
}

/**
 * Check if a username is available in the players table.
 * @param {string} name - The username to check
 * @param {string|null} currentUserId - The current player's UUID
 * @returns {Promise<{available: boolean, owned: boolean, error?: string}>}
 */
export async function checkNameAvailability(name, currentUserId) {
  try {
    const cleanName = (name || '').trim();
    if (cleanName.length < 3) {
      return { available: false, owned: false, error: 'Name too short' };
    }

    const { data, error } = await withTimeout(
      supabase
        .from('players')
        .select('id, username')
        .ilike('username', cleanName)
        .maybeSingle(),
      5000,
      'checkName'
    );

    if (error) {
      console.error('[Supabase] ❌ checkNameAvailability failed:', error.message);
      return { available: false, owned: false, error: error.message };
    }

    if (!data) {
      return { available: true, owned: false };
    }

    const owned = !!(currentUserId && data.id === currentUserId);
    return { available: owned, owned };
  } catch (err) {
    console.error('[Supabase] ❌ checkNameAvailability threw:', err.message);
    return { available: false, owned: false, error: err.message };
  }
}

/**
 * Register or update a player's username in the players table.
 * @param {string} name - The username to register
 * @param {string|null} currentUserId - The current player's UUID (if renaming)
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function registerPlayerName(name, currentUserId) {
  try {
    const cleanName = (name || '').trim();
    if (cleanName.length < 3) {
      return { success: false, error: 'Name must be at least 3 characters' };
    }

    const row = { username: cleanName };
    if (currentUserId) {
      row.id = currentUserId;
    }

    const { data, error } = await withTimeout(
      supabase
        .from('players')
        .upsert([row])
        .select('id')
        .single(),
      10000,
      'registerPlayer'
    );

    if (error) {
      console.error('[Supabase] ❌ registerPlayerName failed:', error.message);
      return { success: false, error: error.message };
    }

    return { success: true, id: data.id };
  } catch (err) {
    console.error('[Supabase] ❌ registerPlayerName threw:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Fetch custom TURN configurations from the database.
 * @returns {Promise<Array<object>>}
 */
export async function getTurnConfig() {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('turn_config')
        .select('*'),
      5000, 'getTurnConfig'
    );
    if (error) {
      console.warn('[Supabase] Failed to fetch TURN config:', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.warn('[Supabase] Error fetching TURN config:', err.message);
    return [];
  }
}

/**
 * Search leaderboard entries by name.
 * @param {string} nameQuery
 * @returns {Promise<Array<object>>}
 */
export async function searchLeaderboard(nameQuery) {
  try {
    if (!nameQuery || nameQuery.trim() === '') return [];
    
    const { data, error } = await withTimeout(
      supabase
        .from('leaderboard')
        .select('*')
        .ilike('player_name', `%${nameQuery.trim()}%`)
        .order('score', { ascending: false })
        .limit(100),
      10000, 'searchLeaderboard'
    );
    if (error) {
      console.error('[Supabase] ❌ searchLeaderboard failed:', error.message);
      return [];
    }
    
    const uniqueScores = [];
    const seenPlayers = new Set();

    for (const row of (data ?? [])) {
      const playerKey = row.player_id || row.player_name;
      if (!seenPlayers.has(playerKey)) {
        seenPlayers.add(playerKey);
        uniqueScores.push(row);
      }
    }
    return uniqueScores;
  } catch (err) {
    console.error('[Supabase] ❌ searchLeaderboard threw:', err.message);
    return [];
  }
}

/**
 * Fetch a player's rank and high score statistics.
 * @param {string|null} playerId
 * @param {string} playerName
 * @returns {Promise<object|null>}
 */
export async function getPlayerRank(playerId, playerName) {
  try {
    let query = supabase.from('leaderboard').select('*');
    if (playerId) {
      query = query.eq('player_id', playerId);
    } else {
      query = query.eq('player_name', playerName);
    }
    
    const { data: scoreData, error: scoreErr } = await withTimeout(
      query.order('score', { ascending: false }).limit(1),
      5000, 'getPlayerRankHighScore'
    );
    
    if (scoreErr || !scoreData || scoreData.length === 0) {
      return null;
    }
    
    const record = scoreData[0];
    const highScore = record.score;
    
    const { count, error: countErr } = await withTimeout(
      supabase
        .from('leaderboard')
        .select('*', { count: 'exact', head: true })
        .gt('score', highScore),
      5000, 'getPlayerRankCount'
    );
    
    if (countErr) {
      console.error('[Supabase] ❌ getPlayerRank count failed:', countErr.message);
      return null;
    }
    
    return {
      rank: (count ?? 0) + 1,
      record: record
    };
  } catch (err) {
    console.error('[Supabase] ❌ getPlayerRank threw:', err.message);
    return null;
  }
}


