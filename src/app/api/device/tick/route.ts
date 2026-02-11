import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  getActiveSessionForToken,
  getAllActiveSessions,
  processSessionTick,
  endSession,
  isSessionExpired,
  getModeName,
  cleanupExpiredSessions,
  getSession,
  DeviceCommand
} from '@/lib/chartSync';
import { rebalanceChartSyncStores } from '@/lib/chartSync/store';
import { getAdminDb, getDeviceSession, updateDeviceSession } from '@/lib/firebase-admin';
import { DEFAULT_TOKEN_MINT } from '@/lib/constants';
import { resolveAutoblowClusterUrl } from '@/lib/autoblow/cluster';

// Environment variables
const AUTOBLOW_DEVICE_TOKEN = process.env.AUTOBLOW_DEVICE_TOKEN || '';
const AUTOBLOW_ENABLED = process.env.AUTOBLOW_ENABLED === 'true';
const AUTOBLOW_CLUSTER = process.env.AUTOBLOW_CLUSTER || '';

interface CurrentTokenDoc {
  tokenMint?: string;
  queueItemId?: string | null;
  displayDuration?: number;
  activeAt?: { toMillis?: () => number };
  expiresAt?: { toMillis?: () => number } | null;
}

async function getClusterUrl(): Promise<string> {
  return resolveAutoblowClusterUrl(AUTOBLOW_DEVICE_TOKEN, AUTOBLOW_CLUSTER);
}

async function sendCommand(command: DeviceCommand): Promise<boolean> {
  if (!AUTOBLOW_DEVICE_TOKEN) return false;

  try {
    const baseUrl = await getClusterUrl();

    if (command.speed === 0) {
      const response = await fetch(`${baseUrl}/autoblow/oscillate/stop`, {
        method: 'PUT',
        headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
      });
      return response.ok;
    }

    const response = await fetch(`${baseUrl}/autoblow/oscillate`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-device-token': AUTOBLOW_DEVICE_TOKEN
      },
      body: JSON.stringify({
        speed: command.speed,
        minY: command.minY,
        maxY: command.maxY
      })
    });
    return response.ok;
  } catch (error) {
    console.error('[Tick] Error sending command:', error);
    return false;
  }
}

async function tryRestoreSessionFromFirestore(): Promise<boolean> {
  const db = getAdminDb();
  const currentTokenSnap = await db.doc('settings/currentToken').get();
  const currentToken = currentTokenSnap.data() as CurrentTokenDoc | undefined;

  if (!currentToken?.tokenMint || !currentToken.queueItemId) {
    return false;
  }

  if (currentToken.tokenMint === DEFAULT_TOKEN_MINT) {
    return false;
  }

  const expiresAtMs = currentToken.expiresAt?.toMillis?.();
  if (expiresAtMs && expiresAtMs <= Date.now()) {
    return false;
  }

  if (await getActiveSessionForToken(currentToken.tokenMint)) {
    return true;
  }

  const persistedSession = await getDeviceSession();
  const startTime = currentToken.activeAt?.toMillis?.() || Date.now();
  await createSession({
    sessionStateId: `recover-${currentToken.queueItemId}`,
    tokenMint: currentToken.tokenMint,
    startTime,
    durationMs: typeof currentToken.displayDuration === 'number' ? currentToken.displayDuration : undefined,
    initialModeId: persistedSession?.tokenMint === currentToken.tokenMint ? persistedSession.modeId : undefined,
    initialSpeed: persistedSession?.tokenMint === currentToken.tokenMint ? persistedSession.speed : undefined,
    initialAmplitude: persistedSession?.tokenMint === currentToken.tokenMint ? persistedSession.amplitude : undefined,
  });

  console.log(`[Tick] Restored session for ${currentToken.tokenMint.slice(0, 8)}... from Firestore state`);
  return true;
}

/**
 * GET - Process tick for all active sessions
 * This endpoint should be called by cron every 60 seconds
 *
 * Vercel cron config in vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/device/tick",
 *     "schedule": "* * * * *"
 *   }]
 * }
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const adminKey = process.env.ADMIN_API_KEY;

    // Allow Vercel cron (no auth) or manual calls with auth
    const isVercelCron = request.headers.get('x-vercel-cron') === '1';
    const isAuthorized =
      isVercelCron ||
      (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
      (adminKey && authHeader === `Bearer ${adminKey}`);

    if (!isAuthorized && (cronSecret || adminKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Always heal cross-store drift (Redis/KV <-> Firestore) on tick.
    const storeSync = await rebalanceChartSyncStores();

    // Get all active sessions
    let sessions = await getAllActiveSessions();

    // Serverless instances may not share memory; recover active session from Firestore if needed.
    if (sessions.length === 0) {
      await tryRestoreSessionFromFirestore();
      sessions = await getAllActiveSessions();
    }

    if (sessions.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No active sessions',
        sessionsProcessed: 0,
        storeSync
      });
    }

    const results: Array<{
      sessionId: string;
      tokenMint: string;
      mode: string;
      command: DeviceCommand | null;
      deviceResult: boolean;
      expired: boolean;
    }> = [];

    // Process each active session
    for (const session of sessions) {
      // Check if session expired
      if (isSessionExpired(session)) {
        await endSession(session.sessionId);
        results.push({
          sessionId: session.sessionId,
          tokenMint: session.tokenMint,
          mode: getModeName(session.modeId),
          command: { speed: 0, minY: 50, maxY: 50 },
          deviceResult: await sendCommand({ speed: 0, minY: 50, maxY: 50 }),
          expired: true
        });
        continue;
      }

      // Process tick
      const command = await processSessionTick(session.sessionId);
      let deviceResult = false;

      if (command && AUTOBLOW_ENABLED && AUTOBLOW_DEVICE_TOKEN) {
        deviceResult = await sendCommand(command);
      }

      // Update Firestore with new mode/speed/amplitude values
      // Re-fetch session to get updated values after processSessionTick
      const updatedSession = await getSession(session.sessionId);
      if (updatedSession) {
        try {
          await updateDeviceSession(
            updatedSession.tokenMint,
            updatedSession.modeId,
            getModeName(updatedSession.modeId),
            updatedSession.lastSpeed,
            updatedSession.lastAmplitude
          );
          console.log(`[Tick] Updated Firestore: mode=${getModeName(updatedSession.modeId)}, speed=${updatedSession.lastSpeed}, amp=${updatedSession.lastAmplitude}`);
        } catch (fsError) {
          console.error('[Tick] Failed to update Firestore:', fsError);
        }
      }

      results.push({
        sessionId: session.sessionId,
        tokenMint: session.tokenMint,
        mode: getModeName(session.modeId),
        command,
        deviceResult,
        expired: false
      });
    }

    // Cleanup any stale sessions
    const cleaned = await cleanupExpiredSessions();

    console.log(`[Tick] Processed ${results.length} sessions, cleaned ${cleaned} expired`);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      deviceEnabled: AUTOBLOW_ENABLED,
      storeSync,
      sessionsProcessed: results.length,
      sessionsCleaned: cleaned,
      results
    });
  } catch (error) {
    console.error('[Tick] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Tick failed' },
      { status: 500 }
    );
  }
}

/**
 * POST - Manual tick trigger (for testing)
 */
export async function POST(request: NextRequest) {
  // Same as GET but via POST
  return GET(request);
}
