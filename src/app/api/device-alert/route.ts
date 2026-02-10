import { NextRequest, NextResponse } from 'next/server';
import { DEVICE_API_KEY, DEVICE_API_URL } from '@/lib/constants';

// This endpoint is called from the client WebSocket trade stream.
// For demo deploys, it is safe to be a no-op when no device is configured.
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json().catch(() => null);

    if (!DEVICE_API_URL) {
      return NextResponse.json({ ok: true, forwarded: false });
    }

    const response = await fetch(DEVICE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DEVICE_API_KEY ? { Authorization: `Bearer ${DEVICE_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload ?? {}),
    });

    return NextResponse.json({ ok: response.ok, forwarded: true, status: response.status });
  } catch (error) {
    console.error('[Device Alert] Error:', error);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, configured: !!DEVICE_API_URL });
}

