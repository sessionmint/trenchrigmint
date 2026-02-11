import { NextRequest, NextResponse } from 'next/server';
import { rebalanceChartSyncStores } from '@/lib/chartSync/store';
import { getAdminDb, FieldValue } from '@/lib/firebase-admin';
import { DEFAULT_TOKEN_MINT } from '@/lib/constants';
import { getInternalBaseUrl } from '@/lib/app-url';

type CurrentTokenDoc = {
  tokenMint?: string;
  queueItemId?: string | null;
  displayDuration?: number;
  sessionStarted?: boolean;
};

function verifyAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  const cronSecret = (process.env.CRON_SECRET || '').trim();

  if (!adminKey && !cronSecret) return true;

  const provided = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (authHeader || '');

  return (!!adminKey && provided === adminKey) || (!!cronSecret && provided === cronSecret);
}

function serviceAuthHeaders(): HeadersInit {
  const token = (process.env.ADMIN_API_KEY || process.env.CRON_SECRET || '').trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function runResync(request: NextRequest) {
  const db = getAdminDb();
  const baseUrl = getInternalBaseUrl(request.nextUrl.origin);
  const authHeaders = serviceAuthHeaders();

  const storeSync = await rebalanceChartSyncStores();

  const processRes = await fetch(`${baseUrl}/api/queue/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
  });
  const processBody = await safeJson(processRes);

  const currentSnap = await db.doc('settings/currentToken').get();
  const current = (currentSnap.data() || null) as CurrentTokenDoc | null;

  let sessionStart: unknown = null;
  let tick: unknown = null;
  let startedNow = false;

  if (current?.tokenMint && current.queueItemId) {
    const startRes = await fetch(`${baseUrl}/api/device/autoblow/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        tokenMint: current.tokenMint,
        sessionStateId: `resync-${current.queueItemId}`,
        durationMs: typeof current.displayDuration === 'number' ? current.displayDuration : undefined,
      }),
    });
    sessionStart = await safeJson(startRes);

    const startPayload = sessionStart as { deviceResult?: boolean } | null;
    startedNow = !!(startRes.ok && startPayload?.deviceResult === true);
    if (startedNow) {
      await db.doc('settings/currentToken').set({
        sessionStarted: true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const tickRes = await fetch(`${baseUrl}/api/device/tick`, {
      method: 'GET',
      headers: authHeaders,
    });
    tick = await safeJson(tickRes);
  } else if (current && current.tokenMint === DEFAULT_TOKEN_MINT && current.sessionStarted === false) {
    await db.doc('settings/currentToken').set({
      sessionStarted: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const stateRes = await fetch(`${baseUrl}/api/state`, { method: 'GET' });
  const state = await safeJson(stateRes);

  const statusToken = current?.tokenMint || DEFAULT_TOKEN_MINT;
  const statusRes = await fetch(`${baseUrl}/api/device/status?tokenMint=${encodeURIComponent(statusToken)}`);
  const status = await safeJson(statusRes);

  return {
    success: true,
    storeSync,
    queueProcess: {
      ok: processRes.ok,
      response: processBody,
    },
    sessionStart,
    startedNow,
    tick,
    state,
    status,
    tokenMint: statusToken,
  };
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const result = await runResync(request);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[DeviceResync] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Resync failed' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
