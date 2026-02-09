import { NextRequest, NextResponse } from 'next/server';
import { DEVICE_API_URL, DEVICE_API_KEY } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const trade = await request.json();
    const { type, amount, priceInSol, tokenMint, wallet, timestamp } = trade;

    // Customize this payload for your device
    const devicePayload = {
      event: type,
      data: { type, amount, priceInSol, tokenMint, wallet: wallet?.slice(0, 8) + '...', timestamp },
      controls: {
        color: type === 'BUY' ? '#39FF14' : '#FF1493',
        intensity: Math.min(Math.floor(priceInSol * 100), 100),
        duration: Math.min(Math.floor(priceInSol * 2000), 10000),
        pattern: type === 'BUY' ? 'pulse' : 'flash',
        sound: type === 'BUY' ? 'cha-ching' : 'whoosh',
      },
    };

    if (!DEVICE_API_URL) {
      console.log('[Device Alert] Would send:', devicePayload);
      return NextResponse.json({ success: true, message: 'Device API not configured', payload: devicePayload });
    }

    const response = await fetch(DEVICE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DEVICE_API_KEY && { 'Authorization': `Bearer ${DEVICE_API_KEY}` }),
      },
      body: JSON.stringify(devicePayload),
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Device API failed' }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
