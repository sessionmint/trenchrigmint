// ============================================
// CHART SYNC SESSION MANAGEMENT
// ============================================

import {
  ChartSyncSession,
  SessionConfig,
  ModeParams,
  DeviceCommand,
  DerivedMetrics,
  COMMAND_INTERVAL_MS,
  SESSION_DURATION_MS,
  BUFFER_SIZE
} from './types';
import { fetchCandles, computeMetrics, updateBuffer, clamp } from './data';
import { computeMode, getModeName, selectModeFromMetrics } from './modes';
import { applyBooster, getBoosterPatternName } from './booster';
import { applySafetyPipeline, createDeviceCommand } from './safety';
import { loadSession, listSessions, removeSession, saveSession } from './store';

// Seeded random number generator (deterministic)
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  // Simple LCG PRNG
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  // Random float in range
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  // Random integer in range (inclusive)
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

/**
 * Generate deterministic seed from session identifiers
 */
function generateSeed(sessionStateId: string, tokenMint: string, startTime: number): number {
  const str = `${sessionStateId}:${tokenMint}:${Math.floor(startTime / 60000)}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate randomized mode parameters using seeded RNG
 * Lowered caps for better sensitivity to meme coin volatility
 */
function generateModeParams(rng: SeededRandom, modeId: number): ModeParams {
  // Base params with randomized thresholds - LOWERED for meme coins
  const params: ModeParams = {
    trendCap: rng.range(0.003, 0.010),      // 0.3% - 1.0% (was 0.8-2.2%)
    chopCap: rng.range(0.005, 0.020),       // 0.5% - 2.0% (was 1.5-4.0%)
    accelCap: rng.range(0.002, 0.008),      // 0.2% - 0.8% (was 0.6-2.0%)
    devCap: rng.range(0.005, 0.020),        // 0.5% - 2.0% (was 1.0-4.0%)
    liqDropCap: rng.range(0.03, 0.15),      // 3% - 15% (was 5-20%)
    weightTrend: rng.range(0.5, 0.75),      // For Mode 1 (was 0.6-0.85)
    weightChop: 0,                           // Computed below
    emaN: rng.int(2, 4)                     // EMA window (was 3-5)
  };

  params.weightChop = 1 - params.weightTrend;

  // Mode-specific adjustments
  switch (modeId) {
    case 2: // Chop Monster - lower chop cap for more sensitivity
      params.chopCap = rng.range(0.004, 0.015);
      break;
    case 3: // Momentum Bursts - tune accel cap
      params.accelCap = rng.range(0.002, 0.008);
      break;
    case 5: // Liquidity Panic - tune liq drop cap
      params.liqDropCap = rng.range(0.03, 0.12);
      break;
  }

  console.log('[ModeParams] Generated:', {
    trendCap: params.trendCap.toFixed(4),
    chopCap: params.chopCap.toFixed(4),
    accelCap: params.accelCap.toFixed(4),
    devCap: params.devCap.toFixed(4)
  });

  return params;
}

function applyExpressiveVariation(
  session: ChartSyncSession,
  metrics: DerivedMetrics,
  speed: number,
  amplitude: number
): { speed: number; amplitude: number; drift: number } {
  const elapsedSteps = Math.floor((Date.now() - session.startTime) / COMMAND_INTERVAL_MS);
  const rng = new SeededRandom(session.seed + elapsedSteps * 7919 + session.modeId * 3571);

  const volatility = clamp(
    metrics.chop * 25 + metrics.accel * 80 + metrics.volNorm * 0.5,
    0,
    1
  );

  const swing = Math.sin((elapsedSteps + rng.next()) * (1.2 + session.modeId * 0.18));
  const pulse = Math.cos((elapsedSteps + rng.next()) * (0.7 + session.modeId * 0.12));

  const speedVariance = (4 + volatility * 12) * swing + rng.range(-3, 3);
  const amplitudeVariance = (2 + volatility * 10) * pulse + rng.range(-2, 2);
  const directionalBias = metrics.trend >= 0 ? 1 : -1;
  const drift = Math.round(
    clamp(directionalBias * (3 + volatility * 8) + metrics.deviation * 15, -12, 12)
  );

  return {
    speed: Math.round(speed + speedVariance),
    amplitude: Math.round(amplitude + amplitudeVariance),
    drift
  };
}

function applyRangeDrift(command: DeviceCommand, drift: number): DeviceCommand {
  if (drift === 0) {
    return command;
  }

  const minShifted = clamp(command.minY + drift, 0, 95);
  const maxShifted = clamp(command.maxY + drift, minShifted + 5, 100);

  return {
    speed: command.speed,
    minY: Math.round(minShifted),
    maxY: Math.round(maxShifted)
  };
}

/**
 * Create a new chart sync session
 */
export async function createSession(config: SessionConfig): Promise<ChartSyncSession> {
  const startTime = config.startTime || Date.now();
  const durationMs = config.durationMs || SESSION_DURATION_MS;
  const seed = generateSeed(config.sessionStateId, config.tokenMint, startTime);
  const rng = new SeededRandom(seed);

  // Start with Trend Rider as default - will be dynamically updated based on chart data
  const modeId = config.initialModeId || 1;

  // Generate mode parameters (randomized thresholds for variety)
  const modeParams = generateModeParams(rng, modeId);

  const session: ChartSyncSession = {
    sessionId: `${config.sessionStateId}-${startTime}`,
    tokenMint: config.tokenMint,
    startTime,
    endTime: startTime + durationMs,
    modeId,
    modeParams,
    seed,
    lastSpeed: config.initialSpeed ?? 40,      // Starting defaults - higher for immediate activity
    lastAmplitude: config.initialAmplitude ?? 25,
    boosterStep: 0,
    candleBuffer: [],
    isActive: true
  };

  // Persist session to Redis (primary) + Firestore (fallback mirror)
  await saveSession(session);

  console.log(`[ChartSync] Session created:`, {
    sessionId: session.sessionId,
    initialMode: getModeName(modeId),
    note: 'Mode will adapt dynamically based on chart conditions',
    duration: `${Math.round(durationMs / 60000)} minutes`,
    configuredDurationMs: durationMs,
    seed
  });

  return session;
}

/**
 * Get session by ID
 */
export async function getSession(sessionId: string): Promise<ChartSyncSession | undefined> {
  return loadSession(sessionId);
}

/**
 * Get active session for a token
 */
export async function getActiveSessionForToken(tokenMint: string): Promise<ChartSyncSession | undefined> {
  const sessions = await listSessions();
  for (const session of sessions) {
    if (session.tokenMint === tokenMint && session.isActive && !isSessionExpired(session)) {
      return session;
    }
  }
  return undefined;
}

/**
 * Check if session has expired
 */
export function isSessionExpired(session: ChartSyncSession): boolean {
  return Date.now() >= session.endTime;
}

/**
 * End a session
 */
export async function endSession(sessionId: string): Promise<void> {
  const session = await loadSession(sessionId);
  if (session) {
    session.isActive = false;
    await saveSession(session);
    console.log(`[ChartSync] Session ended: ${sessionId}`);
  }
}

/**
 * Process a session tick - the main computation loop
 * Called every 60 seconds
 */
export async function processSessionTick(sessionId: string): Promise<DeviceCommand | null> {
  const session = await loadSession(sessionId);

  if (!session) {
    console.error(`[ChartSync] Session not found: ${sessionId}`);
    return null;
  }

  // Check if session has expired
  if (isSessionExpired(session)) {
    console.log(`[ChartSync] Session expired: ${sessionId}`);
    await endSession(sessionId);
    return { speed: 0, minY: 50, maxY: 50 }; // Stop command
  }

  try {
    // 1. Fetch latest candle data
    const newCandles = await fetchCandles(session.tokenMint);

    if (newCandles.length > 0) {
      // Update buffer
      session.candleBuffer = updateBuffer(session.candleBuffer, newCandles[0], BUFFER_SIZE);
    }

    // 2. Compute derived metrics
    const prevVolume = session.candleBuffer.length > 1
      ? session.candleBuffer[session.candleBuffer.length - 2].volume
      : undefined;
    const metrics = computeMetrics(session.candleBuffer, prevVolume);

    // Log raw metrics for debugging
    console.log('[ChartSync] Raw metrics:', {
      trend: metrics.trend.toFixed(5),
      chop: metrics.chop.toFixed(5),
      accel: metrics.accel.toFixed(5),
      deviation: metrics.deviation.toFixed(5),
      liqDrop: metrics.liqDrop.toFixed(5),
      bufferSize: session.candleBuffer.length
    });

    // 3. Dynamically select mode based on current chart conditions
    const selectedModeId = selectModeFromMetrics(metrics, session.modeParams);
    session.modeId = selectedModeId; // Update session's current mode

    // 4. Compute mode output using the dynamically selected mode
    const modeResult = computeMode(selectedModeId, metrics, session.modeParams);

    // 5. Apply booster if needed
    const boosterResult = applyBooster(
      modeResult.intensity,
      modeResult.speed,
      modeResult.amplitude,
      session.boosterStep
    );
    session.boosterStep = boosterResult.newStep;

    // 6. Add expressive variation so consecutive commands are less repetitive
    const expressive = applyExpressiveVariation(
      session,
      metrics,
      boosterResult.speed,
      boosterResult.amplitude
    );

    // 7. Apply safety pipeline
    const safetyResult = applySafetyPipeline(
      expressive.speed,
      expressive.amplitude,
      session.lastSpeed,
      session.lastAmplitude,
      false // anti-bored floor disabled (booster handles this)
    );

    // 8. Update session state
    session.lastSpeed = safetyResult.speed;
    session.lastAmplitude = safetyResult.amplitude;

    // 9. Create device command and shift the center range for more expressive motion
    const command = applyRangeDrift(createDeviceCommand(safetyResult), expressive.drift);

    // Log tick details
    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    console.log(`[ChartSync] Tick @ ${elapsed}s:`, {
      mode: getModeName(selectedModeId),
      style: modeResult.style,
      intensity: modeResult.intensity.toFixed(3),
      booster: boosterResult.wasApplied ? getBoosterPatternName(session.boosterStep) : 'off',
      drift: expressive.drift,
      limited: safetyResult.wasLimited,
      command
    });

    await saveSession(session);

    return command;

  } catch (error) {
    console.error(`[ChartSync] Tick error:`, error);
    // Return safe default on error
    return {
      speed: Math.max(20, session.lastSpeed - 10),
      minY: 40,
      maxY: 60
    };
  }
}

/**
 * Get session status
 */
export async function getSessionStatus(sessionId: string): Promise<{
  exists: boolean;
  isActive: boolean;
  elapsed?: number;
  remaining?: number;
  mode?: string;
  lastCommand?: { speed: number; amplitude: number };
}> {
  const session = await loadSession(sessionId);

  if (!session) {
    return { exists: false, isActive: false };
  }

  const now = Date.now();
  const elapsed = Math.floor((now - session.startTime) / 1000);
  const remaining = Math.max(0, Math.floor((session.endTime - now) / 1000));

  return {
    exists: true,
    isActive: session.isActive && !isSessionExpired(session),
    elapsed,
    remaining,
    mode: getModeName(session.modeId),
    lastCommand: {
      speed: session.lastSpeed,
      amplitude: session.lastAmplitude
    }
  };
}

/**
 * Clean up expired sessions
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const sessions = await listSessions();
  let cleaned = 0;
  for (const session of sessions) {
    if (!session.isActive || isSessionExpired(session)) {
      try {
        await removeSession(session.sessionId);
        cleaned++;
      } catch (error) {
        console.error(`[ChartSync] Failed to remove expired session ${session.sessionId}:`, error);
      }
    }
  }
  return cleaned;
}

/**
 * Get all active sessions (for debugging)
 */
export async function getAllActiveSessions(): Promise<ChartSyncSession[]> {
  const sessions = await listSessions();
  return sessions.filter(s => s.isActive && !isSessionExpired(s));
}
