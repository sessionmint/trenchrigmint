import { NextRequest, NextResponse } from 'next/server';
import { checkDuplicateCooldown } from '@/lib/firebase-admin';
import { DUPLICATE_COOLDOWN_MS, PRIORITY_DUPLICATE } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const { tokenMint } = await request.json();

    if (!tokenMint) {
      return NextResponse.json(
        { error: 'tokenMint is required' },
        { status: 400 }
      );
    }

    // Check if token is in cooldown
    const cooldownCheck = await checkDuplicateCooldown(tokenMint, DUPLICATE_COOLDOWN_MS);

    if (cooldownCheck.inCooldown) {
      const hoursRemaining = Math.floor(cooldownCheck.remainingMs / (60 * 60 * 1000));
      const minutesRemaining = Math.ceil((cooldownCheck.remainingMs % (60 * 60 * 1000)) / (60 * 1000));

      return NextResponse.json({
        inCooldown: true,
        remainingMs: cooldownCheck.remainingMs,
        remainingTime: `${hoursRemaining}h ${minutesRemaining}m`,
        lastUsedAt: cooldownCheck.lastUsedAt,
        overridePrice: PRIORITY_DUPLICATE,
        message: `This token was recently queued. Wait ${hoursRemaining}h ${minutesRemaining}m or pay ${PRIORITY_DUPLICATE} SOL to override.`
      });
    }

    return NextResponse.json({
      inCooldown: false,
      message: 'Token is available for queue'
    });
  } catch (error) {
    console.error('[Cooldown Check] Error:', error);
    return NextResponse.json(
      { error: 'Failed to check cooldown' },
      { status: 500 }
    );
  }
}