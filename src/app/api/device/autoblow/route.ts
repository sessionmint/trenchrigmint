import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  getSession,
  getActiveSessionForToken,
  processSessionTick,
  endSession,
  getSessionStatus,
  cleanupExpiredSessions,
  getAllActiveSessions,
  getModeName,
  DeviceCommand,
  COMMAND_INTERVAL_MS
} from '@/lib/chartSync';
import { updateDeviceSession } from '@/lib/firebase-admin';
import { AutoblowDeviceState } from '@/lib/device/types';
import { resolveAutoblowClusterUrl } from '@/lib/autoblow/cluster';

// ============================================
// CONFIGURATION
// ============================================

const isAutoblowEnabled = (value?: string | null) => {
  const normalized = (value || '').toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

const AUTOBLOW_DEVICE_TOKEN = process.env.AUTOBLOW_DEVICE_TOKEN || '';
const AUTOBLOW_ENABLED = isAutoblowEnabled(process.env.AUTOBLOW_ENABLED);
const AUTOBLOW_CLUSTER = process.env.AUTOBLOW_CLUSTER || '';

// Track last command time to enforce cooldown
let lastCommandTime = 0;

// ============================================
// AUTOBLOW API HELPERS
// ============================================

async function getClusterUrl(): Promise<string> {
  return resolveAutoblowClusterUrl(AUTOBLOW_DEVICE_TOKEN, AUTOBLOW_CLUSTER);
}

async function getDeviceState(): Promise<AutoblowDeviceState> {
  if (!AUTOBLOW_DEVICE_TOKEN) throw new Error('Device token not configured');

  const baseUrl = await getClusterUrl();
  const response = await fetch(`${baseUrl}/autoblow/state`, {
    method: 'GET',
    headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
  });

  if (!response.ok) {
    throw new Error(`Failed to get device state: ${response.status}`);
  }

  return response.json();
}

async function sendDeviceCommand(command: DeviceCommand): Promise<Record<string, unknown>> {
  if (!AUTOBLOW_DEVICE_TOKEN) throw new Error('Device token not configured');

  // Enforce cooldown
  const now = Date.now();
  if (now - lastCommandTime < COMMAND_INTERVAL_MS - 5000) {
    console.log('[Autoblow] Command skipped - cooldown active');
    return { skipped: true, reason: 'cooldown' };
  }

  const baseUrl = await getClusterUrl();

  // If speed is 0, stop the device
  if (command.speed === 0) {
    const response = await fetch(`${baseUrl}/autoblow/oscillate/stop`, {
      method: 'PUT',
      headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
    });

    lastCommandTime = now;
    return response.ok ? { stopped: true } : { error: 'Failed to stop' };
  }

  // Send oscillation command
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

  lastCommandTime = now;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device command failed: ${response.status} - ${text}`);
  }

  return response.json();
}

async function stopDevice(): Promise<Record<string, unknown>> {
  if (!AUTOBLOW_DEVICE_TOKEN) return { error: 'Not configured' };

  const baseUrl = await getClusterUrl();
  const response = await fetch(`${baseUrl}/autoblow/oscillate/stop`, {
    method: 'PUT',
    headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
  });

  return response.ok ? { stopped: true } : { error: 'Failed to stop' };
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST - Start a new session or process a tick
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const adminKey = process.env.ADMIN_API_KEY;

    const isAuthorized =
      (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
      (adminKey && authHeader === `Bearer ${adminKey}`);

    if (!isAuthorized && (cronSecret || adminKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'start': {
        // Start a new chart sync session
        const { sessionStateId, tokenMint } = body;

        if (!sessionStateId || !tokenMint) {
          return NextResponse.json(
            { error: 'Missing sessionStateId or tokenMint' },
            { status: 400 }
          );
        }

        // Check for existing active session
        const existing = await getActiveSessionForToken(tokenMint);
        if (existing) {
          return NextResponse.json({
            success: false,
            error: 'Session already active for this token',
            sessionId: existing.sessionId
          });
        }

        // Create new session
        const session = await createSession({ sessionStateId, tokenMint });

        // Send initial command if device enabled
        let deviceResult = null;
        if (AUTOBLOW_ENABLED && AUTOBLOW_DEVICE_TOKEN) {
          const command = await processSessionTick(session.sessionId);
          if (command) {
            deviceResult = await sendDeviceCommand(command);
          }
        }

        // Update Firestore with initial session values
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
            console.log(`[Autoblow] Session started, Firestore updated: mode=${getModeName(updatedSession.modeId)}`);
          } catch (fsError) {
            console.error('[Autoblow] Failed to update Firestore on start:', fsError);
          }
        }

        return NextResponse.json({
          success: true,
          sessionId: session.sessionId,
          modeId: session.modeId,
          modeName: getModeName(session.modeId),
          startsAt: new Date(session.startTime).toISOString(),
          endsAt: new Date(session.endTime).toISOString(),
          deviceEnabled: AUTOBLOW_ENABLED,
          deviceResult
        });
      }

      case 'tick': {
        // Process a session tick (called every 60s by cron)
        const { sessionId, tokenMint } = body;

        // Find session by ID or by token
        const session = sessionId
          ? await getSession(sessionId)
          : tokenMint
            ? await getActiveSessionForToken(tokenMint)
            : null;

        if (!session) {
          return NextResponse.json({
            success: false,
            error: 'No active session found'
          });
        }

        // Process tick
        const command = await processSessionTick(session.sessionId);

        if (!command) {
          return NextResponse.json({
            success: false,
            error: 'Failed to process tick'
          });
        }

        // Send command if device enabled
        let deviceResult = null;
        if (AUTOBLOW_ENABLED && AUTOBLOW_DEVICE_TOKEN) {
          deviceResult = await sendDeviceCommand(command);
        }

        // Update Firestore with new mode/speed/amplitude values
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
          } catch (fsError) {
            console.error('[Autoblow] Failed to update Firestore:', fsError);
          }
        }

        const status = await getSessionStatus(session.sessionId);

        return NextResponse.json({
          success: true,
          sessionId: session.sessionId,
          command,
          status,
          deviceEnabled: AUTOBLOW_ENABLED,
          deviceResult
        });
      }

      case 'stop': {
        // Stop a session
        const { sessionId, tokenMint } = body;

        const session = sessionId
          ? await getSession(sessionId)
          : tokenMint
            ? await getActiveSessionForToken(tokenMint)
            : null;

        if (session) {
          await endSession(session.sessionId);
        }

        // Stop device
        let deviceResult = null;
        if (AUTOBLOW_ENABLED && AUTOBLOW_DEVICE_TOKEN) {
          deviceResult = await stopDevice();
        }

        return NextResponse.json({
          success: true,
          action: 'stopped',
          sessionId: session?.sessionId,
          deviceResult
        });
      }

      default:
        return NextResponse.json({
          error: 'Invalid action. Use: start, tick, stop',
          examples: {
            start: { action: 'start', sessionStateId: 'abc', tokenMint: '...' },
            tick: { action: 'tick', sessionId: '...' },
            stop: { action: 'stop', sessionId: '...' }
          }
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Autoblow] POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 500 }
    );
  }
}

/**
 * GET - Get device/session status
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const adminKey = process.env.ADMIN_API_KEY;

    if (adminKey && authHeader !== `Bearer ${adminKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const tokenMint = searchParams.get('tokenMint');

    const response: {
      enabled: boolean;
      configured: boolean;
      commandIntervalMs: number;
      session?: unknown;
      activeSessions?: Array<{
        sessionId: string;
        tokenMint: string;
        mode: string;
        elapsed: number;
        remaining: number;
      }>;
      deviceState?: AutoblowDeviceState;
      deviceError?: string;
    } = {
      enabled: AUTOBLOW_ENABLED,
      configured: !!AUTOBLOW_DEVICE_TOKEN,
      commandIntervalMs: COMMAND_INTERVAL_MS
    };

    // Get specific session status
    if (sessionId) {
      response.session = await getSessionStatus(sessionId);
    } else if (tokenMint) {
      const session = await getActiveSessionForToken(tokenMint);
      if (session) {
        response.session = await getSessionStatus(session.sessionId);
      }
    }

    // Get all active sessions
    response.activeSessions = (await getAllActiveSessions()).map(s => ({
      sessionId: s.sessionId,
      tokenMint: s.tokenMint,
      mode: getModeName(s.modeId),
      elapsed: Math.floor((Date.now() - s.startTime) / 1000),
      remaining: Math.max(0, Math.floor((s.endTime - Date.now()) / 1000))
    }));

    // Get device state if configured
    if (AUTOBLOW_ENABLED && AUTOBLOW_DEVICE_TOKEN) {
      try {
        response.deviceState = await getDeviceState();
      } catch (error) {
        response.deviceError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Autoblow] GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Status check failed' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Emergency stop
 */
export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const adminKey = process.env.ADMIN_API_KEY;

    if (adminKey && authHeader !== `Bearer ${adminKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // End all active sessions
    const sessions = await getAllActiveSessions();
    await Promise.all(sessions.map(s => endSession(s.sessionId)));

    // Stop device
    let deviceResult = null;
    if (AUTOBLOW_DEVICE_TOKEN) {
      deviceResult = await stopDevice();
    }

    console.log('[Autoblow] Emergency stop executed');

    return NextResponse.json({
      success: true,
      action: 'emergency_stop',
      sessionsEnded: sessions.length,
      deviceResult
    });
  } catch (error) {
    console.error('[Autoblow] Emergency stop error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Stop failed' },
      { status: 500 }
    );
  }
}

/**
 * PUT - Manual test/control (bypasses session system)
 */
export async function PUT(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const adminKey = process.env.ADMIN_API_KEY;

    if (adminKey && authHeader !== `Bearer ${adminKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!AUTOBLOW_DEVICE_TOKEN) {
      return NextResponse.json({ error: 'Device not configured' }, { status: 400 });
    }

    const body = await request.json();
    const { action, speed, minY, maxY } = body;

    switch (action) {
      case 'test': {
        // Direct test with custom parameters
        const command: DeviceCommand = {
          speed: Math.max(0, Math.min(100, speed || 40)),
          minY: Math.max(0, Math.min(100, minY || 30)),
          maxY: Math.max(0, Math.min(100, maxY || 70))
        };

        const result = await sendDeviceCommand(command);
        console.log(`[Autoblow] Manual test:`, command);

        return NextResponse.json({
          success: true,
          action: 'test',
          command,
          result
        });
      }

      case 'stop': {
        const result = await stopDevice();
        console.log('[Autoblow] Manual stop');

        return NextResponse.json({
          success: true,
          action: 'stopped',
          result
        });
      }

      case 'status': {
        const state = await getDeviceState();
        return NextResponse.json({
          success: true,
          action: 'status',
          state
        });
      }

      case 'cleanup': {
        const cleaned = await cleanupExpiredSessions();
        return NextResponse.json({
          success: true,
          action: 'cleanup',
          sessionsRemoved: cleaned
        });
      }

      default:
        return NextResponse.json({
          error: 'Invalid action. Use: test, stop, status, cleanup',
          examples: {
            test: { action: 'test', speed: 50, minY: 30, maxY: 70 },
            stop: { action: 'stop' },
            status: { action: 'status' },
            cleanup: { action: 'cleanup' }
          }
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Autoblow] PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 500 }
    );
  }
}
