import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  getActiveSessionForToken,
  processSessionTick,
  endSession,
  getSessionStatus,
  getModeName,
  DeviceCommand
} from '@/lib/chartSync';
import { updateDeviceSession, clearDeviceSession } from '@/lib/firebase-admin';
import { resolveAutoblowClusterUrl } from '@/lib/autoblow/cluster';

const isAutoblowEnabled = (value?: string | null) => {
  const normalized = (value || '').toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

// Environment variables for device configuration
const AUTOBLOW_DEVICE_TOKEN = process.env.AUTOBLOW_DEVICE_TOKEN || '';
const AUTOBLOW_ENABLED = isAutoblowEnabled(process.env.AUTOBLOW_ENABLED);
const AUTOBLOW_CLUSTER = process.env.AUTOBLOW_CLUSTER || '';

async function getClusterUrl(): Promise<string> {
  return resolveAutoblowClusterUrl(AUTOBLOW_DEVICE_TOKEN, AUTOBLOW_CLUSTER);
}

async function stopOscillation(): Promise<boolean> {
  if (!AUTOBLOW_DEVICE_TOKEN) return false;

  try {
    const baseUrl = await getClusterUrl();
    const response = await fetch(`${baseUrl}/autoblow/oscillate/stop`, {
      method: 'PUT',
      headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
    });
    return response.ok;
  } catch (error) {
    console.error('[Session] Error stopping device:', error);
    return false;
  }
}

async function sendCommand(command: DeviceCommand): Promise<boolean> {
  if (!AUTOBLOW_DEVICE_TOKEN) return false;

  try {
    const baseUrl = await getClusterUrl();

    if (command.speed === 0) {
      return await stopOscillation();
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
    console.error('[Session] Error sending command:', error);
    return false;
  }
}

/**
 * POST - Session lifecycle management
 * Called from the frontend when queue state changes
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, tokenMint, sessionStateId, durationMs } = body;

    if (!AUTOBLOW_ENABLED) {
      console.log('[Session] Device disabled, skipping action:', action);
      return NextResponse.json({
        success: true,
        action,
        deviceEnabled: false
      });
    }

    if (!AUTOBLOW_DEVICE_TOKEN) {
      console.log('[Session] No device token configured');
      return NextResponse.json({
        success: false,
        error: 'Device not configured'
      }, { status: 400 });
    }

    switch (action) {
      case 'start': {
        // Start a new chart-synced session for this token
        // This is called when a new token becomes active from the queue

        if (!tokenMint) {
          return NextResponse.json({
            success: false,
            error: 'Missing tokenMint'
          }, { status: 400 });
        }

        // Check for existing session
        const existing = await getActiveSessionForToken(tokenMint);
        if (existing) {
          const command = await processSessionTick(existing.sessionId);
          let deviceResult = false;
          if (command) {
            deviceResult = await sendCommand(command);
          }

          // Keep Firestore fresh even when reusing the same active session.
          try {
            const existingStatus = await getSessionStatus(existing.sessionId);
            await updateDeviceSession(
              tokenMint,
              existing.modeId,
              getModeName(existing.modeId),
              existingStatus.lastCommand?.speed || existing.lastSpeed,
              existingStatus.lastCommand?.amplitude || existing.lastAmplitude
            );
          } catch (fsError) {
            console.error('[Session] Failed to refresh Firestore for existing session:', fsError);
          }

          // Return existing session info
          const status = await getSessionStatus(existing.sessionId);
          return NextResponse.json({
            success: true,
            action: 'existing_session',
            sessionId: existing.sessionId,
            mode: getModeName(existing.modeId),
            status,
            command,
            deviceResult
          });
        }

        // Create new session
        const session = await createSession({
          sessionStateId: sessionStateId || `queue-${Date.now()}`,
          tokenMint,
          durationMs: typeof durationMs === 'number' && durationMs > 0 ? durationMs : undefined
        });

        // Process first tick and send initial command
        const command = await processSessionTick(session.sessionId);
        let deviceResult = false;
        if (command) {
          deviceResult = await sendCommand(command);
        }

        // Store mode in Firestore for cross-instance access
        const modeName = getModeName(session.modeId);
        console.log(`[Session] Storing in Firestore: mode=${modeName}, modeId=${session.modeId}, speed=${session.lastSpeed}`);
        try {
          await updateDeviceSession(
            tokenMint,
            session.modeId,
            modeName,
            session.lastSpeed,
            session.lastAmplitude
          );
          console.log(`[Session] Firestore update successful`);
        } catch (fsError) {
          console.error(`[Session] Firestore update failed:`, fsError);
        }

        console.log(`[Session] Started for ${tokenMint.slice(0, 8)}... Mode: ${modeName}`);

        return NextResponse.json({
          success: true,
          action: 'started',
          sessionId: session.sessionId,
          modeId: session.modeId,
          modeName: getModeName(session.modeId),
          startsAt: new Date(session.startTime).toISOString(),
          endsAt: new Date(session.endTime).toISOString(),
          initialCommand: command,
          deviceResult
        });
      }

      case 'stop': {
        // Stop session and device
        // Called when token expires or is replaced

        if (tokenMint) {
          const session = await getActiveSessionForToken(tokenMint);
          if (session) {
            await endSession(session.sessionId);
            console.log(`[Session] Ended session for ${tokenMint.slice(0, 8)}...`);
          }
        }

        const stopped = await stopOscillation();

        // Clear the device session from Firestore
        try {
          await clearDeviceSession();
          console.log('[Session] Cleared Firestore device session');
        } catch (err) {
          console.error('[Session] Failed to clear Firestore session:', err);
        }

        return NextResponse.json({
          success: stopped,
          action: 'stopped',
          tokenMint
        });
      }

      case 'tick': {
        // Process a tick for the active session
        // Called by cron every 60 seconds

        if (!tokenMint) {
          return NextResponse.json({
            success: false,
            error: 'Missing tokenMint'
          }, { status: 400 });
        }

        const session = await getActiveSessionForToken(tokenMint);
        if (!session) {
          return NextResponse.json({
            success: false,
            error: 'No active session for this token'
          });
        }

        const command = await processSessionTick(session.sessionId);
        let deviceResult = false;
        if (command) {
          deviceResult = await sendCommand(command);
        }

        // Update mode in Firestore (mode may have changed based on chart conditions)
        const modeName = getModeName(session.modeId);
        await updateDeviceSession(
          tokenMint,
          session.modeId,
          modeName,
          session.lastSpeed,
          session.lastAmplitude
        );

        const status = await getSessionStatus(session.sessionId);

        return NextResponse.json({
          success: true,
          action: 'tick',
          sessionId: session.sessionId,
          mode: modeName,
          command,
          status,
          deviceResult
        });
      }

      default:
        return NextResponse.json({
          error: 'Invalid action. Use: start, stop, tick'
        }, { status: 400 });
    }

  } catch (error) {
    console.error('[Session] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Session action failed' },
      { status: 500 }
    );
  }
}

/**
 * GET - Get session status for a token
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tokenMint = searchParams.get('tokenMint');

    if (!tokenMint) {
      return NextResponse.json({
        error: 'Missing tokenMint parameter'
      }, { status: 400 });
    }

    const session = await getActiveSessionForToken(tokenMint);

    if (!session) {
      return NextResponse.json({
        hasSession: false,
        tokenMint
      });
    }

    const status = await getSessionStatus(session.sessionId);

    return NextResponse.json({
      hasSession: true,
      tokenMint,
      sessionId: session.sessionId,
      modeId: session.modeId,
      modeName: getModeName(session.modeId),
      ...status
    });
  } catch (error) {
    console.error('[Session] GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Status check failed' },
      { status: 500 }
    );
  }
}
