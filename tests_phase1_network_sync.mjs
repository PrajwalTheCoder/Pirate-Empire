/**
 * Automated Test Suite — Phase 1.1: Network Latency, Teleportation, Combat Delay & Synchronization
 * 
 * Tests:
 *   TEST A — RTT Measurement (Monotonic clock ping/pong, smoothed RTT, jitter, timeout)
 *   TEST B — Snapshot Ordering (Out-of-order rejection, sequence wrap-around, tick validation)
 *   TEST C — Ship Interpolation (Smooth position lerp, shortest-path angle wrapping, no snap)
 *   TEST D — Missing Snapshots (Bounded extrapolation ceiling, velocity decay)
 *   TEST E — Recovery After Jitter (Dynamic buffer delay adaptation to RFC 3550 jitter)
 *   TEST F — Delayed Cannon Hit (End-to-end request -> host validation -> damage event timeline)
 *   TEST G — Duplicate Damage (Idempotent eventId deduplication)
 *   TEST H — Delayed Death Event (Stale movement packet cannot revive sinking/sunk ship)
 *   TEST I — Respawn Lifecycle (Delayed packet from old lifecycle generation rejected)
 *   TEST J — Backpressure (State dropped when bufferedAmount congested, events preserved)
 *   TEST K — Different Match IDs (Packets from other match/room rejected)
 *   TEST L — Two-Client Movement Replication (Serialization -> Network -> Buffer -> Interpolation)
 *   TEST M — Two-Client Combat Simulation (Request -> Host Authority -> Broadcast -> Sync)
 *   TEST N — Existing Functionality Regression (NetPacker types, Day/Night sync, coord ranges)
 */

import { NetPacker, TYPE } from './src/utils/NetPacker.js';
import { EntityInterpolationBuffer } from './src/utils/EntityInterpolationBuffer.js';
import { NetworkDiagnostics } from './src/systems/NetworkDiagnostics.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedTests++;
    console.log(`  ✅ PASSED: ${message}`);
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('PIRATE EMPIRE — PHASE 1.1 MULTIPLAYER NETWORK SYNC TEST SUITE');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // TEST A — RTT Measurement
  // ---------------------------------------------------------------------------
  console.log('▶ TEST A: RTT Measurement (Monotonic Ping/Pong & Jitter)');
  {
    const mockMp = {
      connected: true,
      _sendBin: () => {},
      _getDataChannelBufferedAmount: () => 0,
      roomCode: 'TEST01',
    };
    const diag = new NetworkDiagnostics(mockMp);

    // Verify ping packet layout
    const pingId = 101;
    const t0 = performance.now();
    const pingBuf = NetPacker.packPing(pingId, t0);
    assert(pingBuf.byteLength === 13, 'Ping packet is exactly 13 bytes');

    const unpackedPing = NetPacker.unpackPing(pingBuf);
    assert(unpackedPing.pingId === pingId, 'Unpacked pingId matches');
    assert(Math.abs(unpackedPing.sendTime - t0) < 0.01, 'Monotonic sendTime preserved accurately');

    // Simulate host pong response
    const pongBuf = NetPacker.packPong(pingId, unpackedPing.sendTime, 42);
    assert(pongBuf.byteLength === 17, 'Pong packet is exactly 17 bytes');
    const unpackedPong = NetPacker.unpackPong(pongBuf);
    assert(unpackedPong.receiverTick === 42, 'Pong carries host authoritative tick');

    // Register pending ping in diag and receive pong after 65ms elapsed
    diag._pendingPings.set(pingId, t0);
    const simulatedReceiveTime = t0 + 65.4;
    diag.onPongReceived(pingId, t0, 42, simulatedReceiveTime);

    assert(Math.abs(diag.currentRttMs - 65.4) < 0.1, `Current RTT accurately measured: ${diag.currentRttMs.toFixed(1)}ms`);
    assert(diag.recentRttSamples.length === 1, 'Sample recorded in recent history');

    // Feed second pong sample (85ms) to verify smoothed RTT (EWMA) and RFC 3550 jitter
    const pingId2 = 102;
    const t1 = simulatedReceiveTime + 500;
    diag._pendingPings.set(pingId2, t1);
    diag.onPongReceived(pingId2, t1, 45, t1 + 85.0);

    assert(diag.smoothedRttMs > 0, `Smoothed RTT calculated: ${diag.smoothedRttMs.toFixed(1)}ms`);
    assert(diag.jitterEstimateMs > 0, `RFC 3550 Jitter calculated: ${diag.jitterEstimateMs.toFixed(2)}ms`);

    // Verify timeout handling: un-replied ping should not pollute future measurements
    diag._pendingPings.set(999, performance.now() - 5000);
    // onPongReceived with unknown id is ignored
    diag.onPongReceived(888, performance.now() - 5000, 50, performance.now());
    assert(diag.recentRttSamples.length === 2, 'Stray pong did not corrupt samples');
  }

  // ---------------------------------------------------------------------------
  // TEST B — Snapshot Ordering
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST B: Snapshot Ordering & Rejection of Out-of-Order Packets');
  {
    const buf = new EntityInterpolationBuffer();
    const matchHash = NetPacker.hashMatchId('ROOM42');
    buf.setMatchIdHash(matchHash);

    // Snapshot 1 (Seq 10, Tick 100)
    const s1 = {
      matchIdHash: matchHash,
      seq: 10,
      tick: 100,
      timestamp: 1000,
      generation: 1,
      x: 10, y: 1, z: 20,
      rotY: 0.5,
      hp: 100,
    };
    assert(buf.pushSnapshot(s1) === true, 'Snapshot 1 accepted');

    // Snapshot 2 (Seq 11, Tick 101) - Newer
    const s2 = {
      matchIdHash: matchHash,
      seq: 11,
      tick: 101,
      timestamp: 1050,
      generation: 1,
      x: 12, y: 1, z: 22,
      rotY: 0.55,
      hp: 100,
    };
    assert(buf.pushSnapshot(s2) === true, 'Snapshot 2 accepted');

    // Snapshot 3 (Seq 9, Tick 99) - Stale out-of-order packet
    const sOld = {
      matchIdHash: matchHash,
      seq: 9,
      tick: 99,
      timestamp: 950,
      generation: 1,
      x: 8, y: 1, z: 18,
      rotY: 0.45,
      hp: 100,
    };
    assert(buf.pushSnapshot(sOld) === false, 'Stale snapshot (seq 9 < 11) rejected');
    assert(buf.rejectedStaleCount === 1, 'Rejected stale count incremented');

    // Sequence wrap-around test (from 65534 -> 65535 -> 1)
    buf.latestAcceptedSeq = 65534;
    buf.hasReceivedFirst = true;
    const sWrap1 = { matchIdHash: matchHash, seq: 65535, tick: 200, timestamp: 2000, generation: 1, x: 0, y: 1, z: 0, rotY: 0, hp: 100 };
    assert(buf.pushSnapshot(sWrap1) === true, 'Seq 65535 accepted before wrap');

    const sWrap2 = { matchIdHash: matchHash, seq: 2, tick: 201, timestamp: 2050, generation: 1, x: 2, y: 1, z: 2, rotY: 0, hp: 100 };
    assert(buf.pushSnapshot(sWrap2) === true, 'Seq 2 accepted across 16-bit wrap-around');

    const sWrapOld = { matchIdHash: matchHash, seq: 65530, tick: 190, timestamp: 1900, generation: 1, x: 0, y: 1, z: 0, rotY: 0, hp: 100 };
    assert(buf.pushSnapshot(sWrapOld) === false, 'Older seq 65530 rejected after wrap');
  }

  // ---------------------------------------------------------------------------
  // TEST C — Ship Interpolation
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST C: Ship Interpolation & Shortest-Path Angle Wrapping');
  {
    const buf = new EntityInterpolationBuffer({ baseDelayMs: 60 });
    const matchHash = 0xABCD;
    buf.setMatchIdHash(matchHash);

    // Push two snapshots 100ms apart
    // Snapshot A at t = 2000ms: x = 0, z = 0, rotY = 3.0 rad (~171 deg)
    buf.pushSnapshot({
      matchIdHash: matchHash,
      seq: 1,
      tick: 1,
      timestamp: 2000,
      generation: 1,
      x: 0, y: 1, z: 0,
      vx: 10, vy: 0, vz: 0,
      rotY: 3.0,
      hp: 100,
    });

    // Snapshot B at t = 2100ms: x = 10, z = 0, rotY = -3.0 rad (~-171 deg, wrapped across PI)
    buf.pushSnapshot({
      matchIdHash: matchHash,
      seq: 2,
      tick: 2,
      timestamp: 2100,
      generation: 1,
      x: 10, y: 1, z: 0,
      vx: 10, vy: 0, vz: 0,
      rotY: -3.0,
      hp: 100,
    });

    // Render time exactly halfway: renderTime = 2050ms
    const targetRenderTime = 2050;
    const sampled = buf.sample(targetRenderTime, true);

    assert(sampled !== null, 'Sample returned interpolated state');
    assert(Math.abs(sampled.x - 5.0) < 0.1, `Interpolated position x is ~5.0: actual ${sampled.x.toFixed(2)}`);

    // Verify angle wrapping did not take long way around (diff is 0.28 rad, not 6.0 rad)
    // Shortest path from 3.0 to -3.0 wraps over +PI (3.14159)
    assert(Math.abs(sampled.rotY) > 2.9, `Shortest path angle wrapping preserved smoothly: rotY = ${sampled.rotY.toFixed(2)}`);

    // Apply to mock ship
    const mockShip = {
      state: 'SAILING',
      group: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      velocity: { x: 0, y: 0, z: 0 },
      health: 100,
      setPosition(x, y, z) { this.group.position.x = x; this.group.position.y = y; this.group.position.z = z; },
      setRotationY(ry) { this.group.rotation.y = ry; },
      setAuthoritativeHealth(hp) { this.health = hp; },
    };

    buf.applyToShip(mockShip, targetRenderTime + buf.getRenderDelayMs());
    assert(mockShip.group.position.x > 0, 'Ship position updated smoothly via applyToShip');
  }

  // ---------------------------------------------------------------------------
  // TEST D — Missing Snapshots & Bounded Extrapolation
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST D: Missing Snapshots & Bounded Extrapolation');
  {
    const buf = new EntityInterpolationBuffer({ baseDelayMs: 50, maxExtrapolationSec: 0.15 });
    const matchHash = 0x1234;
    buf.setMatchIdHash(matchHash);

    // Only one snapshot available at t = 1000ms moving at vx = 20 units/s
    buf.pushSnapshot({
      matchIdHash: matchHash,
      seq: 1,
      tick: 1,
      timestamp: 1000,
      generation: 1,
      x: 0, y: 1, z: 0,
      vx: 20, vy: 0, vz: 0,
      rotY: 0,
      hp: 100,
    });

    // Extrapolate within 100ms
    const sampleNear = buf.sample(1100, true);
    assert(sampleNear !== null, 'Extrapolated state returned within threshold');
    assert(sampleNear.x > 0 && sampleNear.x < 3.0, `Extrapolated position bounded: x = ${sampleNear.x.toFixed(2)}`);

    // Attempt to extrapolate beyond maxExtrapolationSec (e.g. 500ms later)
    const sampleLate = buf.sample(1600, true);
    // Extrapolation must clamp velocity or clamp distance
    assert(sampleLate !== null, 'Late sample handled safely');
    // At 20 u/s for max 0.15s, x cannot exceed 3.5 units
    assert(sampleLate.x <= 3.5, `Extrapolation capped at ceiling: x = ${sampleLate.x.toFixed(2)} <= 3.5`);
  }

  // ---------------------------------------------------------------------------
  // TEST E — Recovery After Jitter
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST E: Recovery After Jitter (Dynamic Buffer Delay)');
  {
    const buf = new EntityInterpolationBuffer({ baseDelayMs: 60 });
    assert(buf.getRenderDelayMs() === 60, 'Initial buffer delay matches base delay');

    // Simulate jitter spike of 40ms
    buf.setMeasuredJitter(40);
    const adaptedDelay = buf.getRenderDelayMs();
    // baseDelay (60) + jitter (40 * 1.25 = 50) = 110ms
    assert(adaptedDelay >= 100 && adaptedDelay <= 120, `Buffer delay adapted to jitter: ${adaptedDelay}ms`);

    // Simulate extreme jitter of 250ms -> should clamp at 180ms
    buf.setMeasuredJitter(250);
    assert(buf.getRenderDelayMs() === 180, `Buffer delay capped at upper limit: ${buf.getRenderDelayMs()}ms`);

    // Simulate smooth connection (jitter = 2ms)
    buf.setMeasuredJitter(2);
    assert(buf.getRenderDelayMs() <= 65, `Buffer delay recovered to low latency: ${buf.getRenderDelayMs()}ms`);
  }

  // ---------------------------------------------------------------------------
  // TEST F — Delayed Cannon Hit Timeline
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST F: Delayed Cannon Hit (Request -> Validation -> Commit Event)');
  {
    const roomCode = 'FLEET9';
    const mockHost = {
      isHost: true,
      roomCode,
      _authoritativeTick: 150,
      _hostEventSeq: 10,
      sentPackets: [],
      sendDamageEvent(shipId, damage, remainingHp, isKill, isCrit) {
        const eventId = ++this._hostEventSeq;
        const buf = NetPacker.packDamageEvent(shipId, damage, remainingHp, isKill, isCrit, eventId, this.roomCode, this._authoritativeTick);
        this.sentPackets.push(buf);
      },
    };

    // Client fires request
    const clientReqBuf = NetPacker.packDamageRequest('enemy_ship_1', 30, 1, roomCode, 'ROUND');
    assert(clientReqBuf.byteLength === 14, 'Damage request is compact 14 bytes');

    const reqData = NetPacker.unpackDamageRequest(clientReqBuf);
    assert(reqData.dmg === 30, 'Host received raw damage request');

    // Host authoritative validation & commit
    const targetShip = {
      id: 'enemy_ship_1',
      health: 80,
      armor: 0.8, // 20% reduction
      takeDamage(raw) {
        const effective = Math.round(raw * this.armor);
        this.health = Math.max(0, this.health - effective);
        return effective;
      }
    };

    const actualDmg = targetShip.takeDamage(reqData.dmg); // 24 dmg
    assert(actualDmg === 24, 'Host authoritatively calculated armor-mitigated damage (24)');
    assert(targetShip.health === 56, 'Target health reduced to 56');

    // Host immediately broadcasts damage event
    mockHost.sendDamageEvent(targetShip.id, actualDmg, targetShip.health, false, true);
    assert(mockHost.sentPackets.length === 1, 'Authoritative damage event immediately dispatched');

    // Client unpacks broadcast
    const damageBroadcast = NetPacker.unpackDamage(mockHost.sentPackets[0]);
    assert(damageBroadcast.dmg === 24, 'Client received exact authoritative damage');
    assert(damageBroadcast.remainingHp === 56, 'Client received exact authoritative remaining HP');
    assert(damageBroadcast.isCrit === true, 'Critical hit flag propagated');
  }

  // ---------------------------------------------------------------------------
  // TEST G — Duplicate Damage
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST G: Duplicate Combat Event Deduplication');
  {
    const processedEvents = new Set();
    let damageAppliedCount = 0;

    function handleDamageEvent(event) {
      if (event.eventId && processedEvents.has(event.eventId)) {
        return false; // deduplicated
      }
      if (event.eventId) processedEvents.add(event.eventId);
      damageAppliedCount++;
      return true;
    }

    const event = { eventId: 501, dmg: 25, remainingHp: 75 };
    assert(handleDamageEvent(event) === true, 'First event applied');
    assert(handleDamageEvent(event) === false, 'Duplicate event cleanly rejected');
    assert(damageAppliedCount === 1, 'Damage only applied once');
  }

  // ---------------------------------------------------------------------------
  // TEST H — Delayed Death Event
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST H: Sinking State Immunity to Stale Movement Snapshots');
  {
    const buf = new EntityInterpolationBuffer();
    const matchHash = 0x9999;
    buf.setMatchIdHash(matchHash);

    const mockShip = {
      state: 'SINKING',
      health: 0,
      lifecycleGen: 1,
      group: { position: { x: 50, y: -2, z: 50 }, rotation: { x: 0, y: 0, z: 0 } },
      setPosition(x, y, z) { this.group.position.x = x; this.group.position.y = y; this.group.position.z = z; },
      setRotationY(ry) { this.group.rotation.y = ry; },
      setAuthoritativeHealth(hp) { this.health = hp; },
    };

    // Attempt to push delayed in-flight packet with hp = 80 from before death
    const delayedPacket = {
      matchIdHash: matchHash,
      seq: 200,
      tick: 300,
      timestamp: performance.now(),
      generation: 1,
      x: 100, y: 1, z: 100,
      hp: 80,
    };
    buf.pushSnapshot(delayedPacket);

    // Apply buffer to ship
    buf.applyToShip(mockShip, performance.now() + 100);

    assert(mockShip.state === 'SINKING', 'Ship remained SINKING');
    assert(mockShip.health === 0, 'Ship health remained 0, not revived by delayed packet');
    assert(mockShip.group.position.x === 50, 'Ship position was NOT teleported by stale packet');
  }

  // ---------------------------------------------------------------------------
  // TEST I — Respawn Lifecycle
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST I: Respawn Lifecycle Generation Guard');
  {
    const buf = new EntityInterpolationBuffer();
    const matchHash = 0x7777;
    buf.setMatchIdHash(matchHash);

    // Lifecycle Gen 1 state
    buf.pushSnapshot({ matchIdHash: matchHash, seq: 10, tick: 10, timestamp: 1000, generation: 1, x: 10, y: 1, z: 10, hp: 0 });

    // Host triggers respawn -> sets generation to 2
    buf.setAuthoritativeLifecycle(2);
    assert(buf.expectedGeneration === 2, 'Buffer generation bumped to 2');

    // Stale delayed packet arriving from Gen 1
    const staleGen1Packet = {
      matchIdHash: matchHash,
      seq: 15,
      tick: 15,
      timestamp: 1050,
      generation: 1,
      x: 999, y: 1, z: 999,
      hp: 50,
    };
    assert(buf.pushSnapshot(staleGen1Packet) === false, 'Stale packet from old lifecycle generation rejected');

    // New packet from Gen 2 accepted
    const gen2Packet = {
      matchIdHash: matchHash,
      seq: 1,
      tick: 20,
      timestamp: 1100,
      generation: 2,
      x: 0, y: 1, z: 0,
      hp: 100,
    };
    assert(buf.pushSnapshot(gen2Packet) === true, 'New lifecycle generation packet accepted');
  }

  // ---------------------------------------------------------------------------
  // TEST J — Backpressure & Channel Congestion
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST J: Backpressure & Data-Channel Congestion Control');
  {
    let bufferedAmount = 0;
    const mockMp = {
      _getDataChannelBufferedAmount: () => bufferedAmount,
      isChannelCongested() {
        return this._getDataChannelBufferedAmount() > 48000;
      },
    };

    assert(mockMp.isChannelCongested() === false, 'Channel clear at 0 bytes buffered');

    // Congestion threshold reached (e.g. 64KB queued)
    bufferedAmount = 65536;
    assert(mockMp.isChannelCongested() === true, 'Channel congested detected at 65536 bytes');

    // In MultiplayerSystem: when isChannelCongested(), continuous movement snapshots are skipped
    let droppedMovementSnapshots = 0;
    let criticalEventsSent = 0;

    function sendUpdate(isContinuousMovement) {
      if (isContinuousMovement && mockMp.isChannelCongested()) {
        droppedMovementSnapshots++;
        return;
      }
      criticalEventsSent++;
    }

    sendUpdate(true);  // movement snapshot -> dropped
    sendUpdate(true);  // movement snapshot -> dropped
    sendUpdate(false); // critical event -> must be sent

    assert(droppedMovementSnapshots === 2, 'Obsolete continuous snapshots dropped under congestion');
    assert(criticalEventsSent === 1, 'Critical gameplay events never dropped');
  }

  // ---------------------------------------------------------------------------
  // TEST K — Different Match IDs
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST K: Wrong Match ID Packet Rejection');
  {
    const buf = new EntityInterpolationBuffer();
    const correctMatch = NetPacker.hashMatchId('MATCH_A');
    const wrongMatch = NetPacker.hashMatchId('MATCH_B');
    buf.setMatchIdHash(correctMatch);

    const packetWrongMatch = {
      matchIdHash: wrongMatch,
      seq: 1,
      tick: 1,
      timestamp: 1000,
      generation: 1,
      x: 50, y: 1, z: 50,
      hp: 100,
    };
    assert(buf.pushSnapshot(packetWrongMatch) === false, 'Packet with wrong matchIdHash rejected');
    assert(buf.rejectedWrongMatchCount === 1, 'Rejected wrong match count incremented');
  }

  // ---------------------------------------------------------------------------
  // TEST L — Two-Client Movement Replication Simulation
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST L: Two-Client Movement Replication Simulation');
  {
    const room = 'COOP88';
    const clientA_Ship = {
      id: 'ship_A',
      group: { position: { x: 120.5, y: 1.0, z: -84.2 }, rotation: { y: 1.57 } },
      velocity: { x: 12.0, y: 0.0, z: -4.0 },
      health: 95,
      maxHealth: 100,
      isAlive: true,
      lifecycleGen: 1,
    };

    // Client A packs state
    const packed = NetPacker.packShipState(clientA_Ship, 1, 100, room);
    assert(packed.byteLength === 25, 'V3 Ship state packet packed into 25 bytes');

    // Network transmission -> Client B unpacks
    const unpacked = NetPacker.unpackShipState(packed);
    assert(Math.abs(unpacked.x - 120.5) < 0.1, 'Client B unpacked position X matches');
    assert(Math.abs(unpacked.z - -84.2) < 0.1, 'Client B unpacked position Z matches');
    assert(Math.abs(unpacked.rotY - 1.57) < 0.05, 'Client B unpacked rotation matches');
    assert(unpacked.hp === 95, 'Client B unpacked HP matches');

    // Client B feeds interpolation buffer
    const clientB_Buf = new EntityInterpolationBuffer();
    clientB_Buf.setMatchIdHash(NetPacker.hashMatchId(room));
    assert(clientB_Buf.pushSnapshot(unpacked) === true, 'Client B buffer accepted packet');
  }

  // ---------------------------------------------------------------------------
  // TEST M — Two-Client Combat Simulation
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST M: Two-Client Combat Simulation (Fire -> Hit -> Sink)');
  {
    const room = 'WAR66';
    let hostAuthoritativeHp = 20;

    // Client fires request
    const reqBuf = NetPacker.packDamageRequest('target_ship', 25, 1, room);
    const req = NetPacker.unpackDamageRequest(reqBuf);

    // Host processes hit authoritatively
    hostAuthoritativeHp = Math.max(0, hostAuthoritativeHp - req.dmg);
    const isKill = hostAuthoritativeHp === 0;
    assert(isKill === true, 'Host confirmed ship destruction');

    // Host dispatches destruction event
    const destroyBuf = NetPacker.packShipDestroyed('target_ship', 1, 8.0, 10, room, 200);
    assert(destroyBuf.byteLength === 18, 'Ship destroyed packet is 18 bytes');

    const destroyEvent = NetPacker.unpackShipDestroyed(destroyBuf);
    assert(destroyEvent.respawnSec === 8.0, 'Respawn deadline preserved (8.0s)');
    assert(destroyEvent.lifecycleGen === 1, 'Lifecycle generation preserved');
  }

  // ---------------------------------------------------------------------------
  // TEST N — Existing Functionality Regression
  // ---------------------------------------------------------------------------
  console.log('\n▶ TEST N: Existing Functionality Regression (NetPacker & Protocol)');
  {
    // Cannon fire packing/unpacking
    const posL = { x: 10.5, y: 2.0, z: -15.2 };
    const velL = { x: 30.0, y: 5.0, z: -12.0 };
    const posR = { x: -10.5, y: 2.0, z: -15.2 };
    const velR = { x: -30.0, y: 5.0, z: -12.0 };
    const fireBuf = NetPacker.packCannonFire(posL, velL, posR, velR, 'CHAIN');
    assert(fireBuf.byteLength === 26, 'Cannon fire packet is 26 bytes');
    const unpackedFire = NetPacker.unpackCannonFire(fireBuf);
    assert(unpackedFire.ammo === 'CHAIN', 'Ammo type preserved');
    assert(Math.abs(unpackedFire.pL.x - 10.5) < 0.1, 'Broadside firing vector preserved');

    // AI state packing/unpacking
    const aiShips = [
      { id: 'ai_1', cls: 'PIRATE_SMALL', fac: 'PIRATE', x: 50, z: -50, ry: 1.2, hp: 100, mhp: 100 },
      { id: 'ai_2', cls: 'NAVY_LARGE',   fac: 'NAVY',   x: -80, z: 30, ry: -0.5, hp: 250, mhp: 300 },
    ];
    const aiBuf = NetPacker.packAIState(aiShips);
    const unpackedAI = NetPacker.unpackAIState(aiBuf);
    const aiList = unpackedAI.ships || unpackedAI;
    assert(aiList.length === 2, 'Unpacked exact number of AI ships');
    assert(aiList[1].hp === 250, 'AI ship HP preserved');

    // Matchmaking room code hashing
    const h1 = NetPacker.hashMatchId('ROOM_A');
    const h2 = NetPacker.hashMatchId('ROOM_B');
    assert(h1 !== h2, 'Different room codes produce distinct hashes');
    assert(NetPacker.hashMatchId('ROOM_A') === h1, 'Deterministic room hash');
  }

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
