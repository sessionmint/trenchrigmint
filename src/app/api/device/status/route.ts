import { NextRequest, NextResponse } from 'next/server';
import {
  getAllActiveSessions,
  getActiveSessionForToken,
  getSessionStatus,
  getModeName
} from '@/lib/chartSync';
import { getDeviceSession, getAdminDb } from '@/lib/firebase-admin';
import { AutoblowDeviceState, DeviceSessionStatus, PublicDeviceStatus } from '@/lib/device/types';
import { resolveAutoblowClusterUrl } from '@/lib/autoblow/cluster';
import { getInternalBaseUrl } from '@/lib/app-url';

const SESSION_COOLDOWN_MS = 10000; // 10 seconds before starting device session
const FIREBASE_SESSION_STALE_MS = 90000; // 90 seconds without updates is considered stale
const TICK_KICK_MIN_INTERVAL_MS = 30000; // Avoid hammering tick endpoint

const isAutoblowEnabled = (value?: string | null) => {
  const normalized = (value || '').toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

// Environment variables for device configuration
const AUTOBLOW_DEVICE_TOKEN = process.env.AUTOBLOW_DEVICE_TOKEN || '';
const AUTOBLOW_ENABLED = isAutoblowEnabled(process.env.AUTOBLOW_ENABLED);
const AUTOBLOW_CLUSTER = process.env.AUTOBLOW_CLUSTER || '';

// Cache connection status
let lastCheckTime = 0;
let lastStatus: PublicDeviceStatus = { connected: false, state: 'unknown' };
let lastTickKickAt = 0;
const CACHE_DURATION = 3000; // 3 seconds - matches client poll minimum

interface CurrentTokenDoc {
  tokenMint?: string;
  queueItemId?: string | null;
  sessionStarted?: boolean;
  displayDuration?: number;
  activeAt?: { toMillis?: () => number };
}

async function getClusterUrl(): Promise<string> {
  return resolveAutoblowClusterUrl(AUTOBLOW_DEVICE_TOKEN, AUTOBLOW_CLUSTER);
}

async function getDeviceState(): Promise<AutoblowDeviceState> {
  const baseUrl = await getClusterUrl();
  const response = await fetch(`${baseUrl}/autoblow/state`, {
    method: 'GET',
    headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
  });

  if (!response.ok) throw new Error('Failed to get device state');
  return response.json();
}

/**
 * GET - Public device status endpoint
 * Returns basic status info without requiring auth
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenMint = searchParams.get('tokenMint');

  // Return cached status if recent (unless specific token requested)
  const now = Date.now();
  const cacheAge = now - lastCheckTime;

  // Add cache headers to help reduce requests
  const cacheHeaders = {
    'Cache-Control': 'public, max-age=2, stale-while-revalidate=5',
    'X-Cache-Age': String(Math.floor(cacheAge / 1000)),
  };

  if (!tokenMint && cacheAge < CACHE_DURATION) {
    return NextResponse.json(lastStatus, { headers: cacheHeaders });
  }

  // If device is disabled or not configured
  if (!AUTOBLOW_ENABLED) {
    lastStatus = { connected: false, state: 'disabled' };
    lastCheckTime = now;
    return NextResponse.json(lastStatus, { headers: cacheHeaders });
  }

  if (!AUTOBLOW_DEVICE_TOKEN) {
    lastStatus = { connected: false, state: 'not_configured' };
    lastCheckTime = now;
    return NextResponse.json(lastStatus, { headers: cacheHeaders });
  }

  try {
    const baseUrl = getInternalBaseUrl(request.nextUrl.origin);
    const db = getAdminDb();
    let currentToken: CurrentTokenDoc | null = null;

    // Check if we need to handle cooldown (applies to both paid tokens AND default token)
    let cooldownInfo: { active: boolean; remainingMs: number; totalMs: number } | undefined;

    try {
      const currentTokenDoc = await db.doc('settings/currentToken').get();
      currentToken = (currentTokenDoc.data() || null) as CurrentTokenDoc | null;

      // Apply cooldown whenever sessionStarted is false and activeAt is set
      if (currentToken && !currentToken.sessionStarted && currentToken.activeAt) {
        const activeAt = currentToken.activeAt?.toMillis?.() || 0;
        const timeSinceActive = now - activeAt;
        const remainingCooldown = Math.max(0, SESSION_COOLDOWN_MS - timeSinceActive);

        if (timeSinceActive >= SESSION_COOLDOWN_MS) {
          // Cooldown complete
          const isDefaultToken = !currentToken.queueItemId;

          if (isDefaultToken) {
            // For default token, just mark as started (no device session needed)
            console.log('[DeviceStatus] Cooldown complete for default token');
            await db.doc('settings/currentToken').update({ sessionStarted: true });
          } else {
            // For paid tokens, start the device session
            console.log('[DeviceStatus] Starting session after cooldown for:', currentToken.tokenMint);

            try {
              const sessionRes = await fetch(`${baseUrl}/api/device/autoblow/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'start',
                  tokenMint: currentToken.tokenMint,
                  durationMs: currentToken.displayDuration || undefined
                })
              });
              const sessionPayload = await sessionRes.json().catch(() => null) as {
                action?: string;
                deviceResult?: boolean;
              } | null;
              const startedSuccessfully =
                sessionRes.ok &&
                sessionPayload?.deviceResult === true;

              if (startedSuccessfully) {
                // Mark session as started only when a device command was accepted.
                await db.doc('settings/currentToken').update({ sessionStarted: true });
                console.log('[DeviceStatus] Session started successfully');
              } else {
                console.error('[DeviceStatus] Session start failed:', sessionPayload);
              }
            } catch (err) {
              console.error('[DeviceStatus] Session start error:', err);
            }
          }

          cooldownInfo = { active: false, remainingMs: 0, totalMs: SESSION_COOLDOWN_MS };
        } else {
          // Still in cooldown
          cooldownInfo = { active: true, remainingMs: remainingCooldown, totalMs: SESSION_COOLDOWN_MS };
        }
      }
    } catch (sessionCheckError) {
      console.error('[DeviceStatus] Session check error:', sessionCheckError);
    }

    // Device state can fail independently when hardware is offline; session logic must still run.
    let deviceState: AutoblowDeviceState | undefined;
    try {
      deviceState = await getDeviceState();
    } catch (deviceError) {
      console.error('[DeviceStatus] Device state error:', deviceError);
    }

    // Get session info from Firestore (persisted across serverless instances)
    let sessionInfo: DeviceSessionStatus | undefined;
    let firestoreSession = null;
    try {
      firestoreSession = await getDeviceSession();
    } catch (fsError) {
      console.error('[DeviceStatus] Firestore error:', fsError);
    }
    const sessions = await getAllActiveSessions();

    // Fallback keep-alive: if cron is delayed and session data is stale, kick one tick.
    const shouldKickTick =
      !cooldownInfo?.active &&
      !!currentToken?.queueItemId &&
      !!currentToken?.sessionStarted &&
      (now - lastTickKickAt >= TICK_KICK_MIN_INTERVAL_MS) &&
      (!firestoreSession || (now - firestoreSession.updatedAt.getTime() > FIREBASE_SESSION_STALE_MS));

    if (shouldKickTick) {
      lastTickKickAt = now;
      const adminKey = process.env.ADMIN_API_KEY;
      const cronSecret = process.env.CRON_SECRET;
      const authToken = adminKey || cronSecret || '';
      try {
        await fetch(`${baseUrl}/api/device/tick`, {
          method: 'GET',
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });
        console.log('[DeviceStatus] Triggered fallback /api/device/tick for stale session');
      } catch (tickError) {
        console.error('[DeviceStatus] Failed fallback tick trigger:', tickError);
      }
    }

    // Determine state based on device response
    // The Autoblow API returns operationalMode which can be:
    // - ONLINE_CONNECTED: connected but idle
    // - OSCILLATOR_PLAYING: device is moving/oscillating
    // - SYNC_SCRIPT_PLAYING: playing a sync script
    let state = 'idle';

    const operationalMode = deviceState?.operationalMode || '';

    // Check operationalMode for active states
    const isPlaying =
      operationalMode === 'OSCILLATOR_PLAYING' ||
      operationalMode === 'SYNC_SCRIPT_PLAYING' ||
      operationalMode.includes('PLAYING');

    // Also check oscillator speed as backup indicator
    const hasActiveSpeed =
      (deviceState?.oscillatorTargetSpeed && deviceState.oscillatorTargetSpeed > 0);

    // Handle cooldown state first
    if (cooldownInfo?.active) {
      state = 'cooldown';
    } else if (deviceState && isPlaying) {
      state = 'stroking';
    } else if (deviceState && hasActiveSpeed) {
      state = 'active';
    } else if (sessions.length > 0) {
      // If we have active sessions, device should be considered active even if API doesn't report it
      state = 'active';
    }

    // Prefer Firestore session (persisted across serverless instances)
    if (firestoreSession) {
      console.log(`[DeviceStatus] Found Firestore session: mode=${firestoreSession.modeName}, speed=${firestoreSession.speed}`);
      sessionInfo = {
        mode: firestoreSession.modeName,
        modeId: firestoreSession.modeId,
        elapsed: 0,
        remaining: 0,
        speed: firestoreSession.speed,
        amplitude: firestoreSession.amplitude
      };

      // Check if device is waiting for activity (low speed = no recent swaps)
      if (firestoreSession.speed <= 15 && state !== 'cooldown') {
        state = 'waiting';
      }
    } else if (tokenMint) {
      // Fallback: Get session for specific token from memory
      const session = await getActiveSessionForToken(tokenMint);
      if (session) {
        const status = await getSessionStatus(session.sessionId);
        sessionInfo = {
          mode: getModeName(session.modeId),
          modeId: session.modeId,
          elapsed: status.elapsed || 0,
          remaining: status.remaining || 0,
          speed: session.lastSpeed,
          amplitude: session.lastAmplitude
        };

        // Check if waiting for activity
        if (session.lastSpeed <= 15 && state !== 'cooldown') {
          state = 'waiting';
        }
      }
    } else if (sessions.length > 0) {
      // Fallback: Get first active session from memory
      const session = sessions[0];
      const status = await getSessionStatus(session.sessionId);
      sessionInfo = {
        mode: getModeName(session.modeId),
        modeId: session.modeId,
        elapsed: status.elapsed || 0,
        remaining: status.remaining || 0,
        speed: session.lastSpeed,
        amplitude: session.lastAmplitude
      };

      // Check if waiting for activity
      if (session.lastSpeed <= 15 && state !== 'cooldown') {
        state = 'waiting';
      }
    }

    // If hardware state can't be read, avoid reporting active movement.
    if (!deviceState && !cooldownInfo?.active) {
      state = sessionInfo ? 'waiting' : 'disconnected';
    }

    lastStatus = {
      connected: !!deviceState,
      state,
      deviceState,
      session: sessionInfo,
      cooldown: cooldownInfo
    };
    lastCheckTime = now;

    return NextResponse.json(lastStatus, { headers: cacheHeaders });
  } catch (error) {
    console.error('[DeviceStatus] Error:', error);
    lastStatus = { connected: false, state: 'disconnected' };
    lastCheckTime = now;
    return NextResponse.json(lastStatus, { headers: cacheHeaders });
  }
}
