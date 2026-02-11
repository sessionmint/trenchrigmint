import { NextResponse } from 'next/server';
import { getCurrentToken, listQueue } from '@/lib/queue-driver';

export async function GET() {
  try {
    const [current, queueRaw] = await Promise.all([
      getCurrentToken(),
      listQueue(),
    ]);

    const queue = queueRaw.map((item) => {
      const expiresAt = typeof item.expiresAt === 'object' && item.expiresAt !== null && 'toMillis' in item.expiresAt
        ? (item.expiresAt as { toMillis: () => number }).toMillis()
        : (item.expiresAt as number | undefined) || 0;
      const addedAt = typeof item.addedAt === 'object' && item.addedAt !== null && 'toMillis' in item.addedAt
        ? (item.addedAt as { toMillis: () => number }).toMillis()
        : (item.addedAt as number | undefined) || 0;

      return {
        id: item.id,
        tokenMint: item.tokenMint,
        walletAddress: item.walletAddress,
        expiresAt,
        isPriority: item.isPriority,
        priorityLevel: item.priorityLevel || 0,
        displayDuration: item.displayDuration || 600000,
        addedAt,
        position: item.position || 0,
      };
    });

    const currentExpiresAt = typeof current?.expiresAt === 'object' && current?.expiresAt !== null && 'toMillis' in current.expiresAt
      ? (current.expiresAt as { toMillis: () => number }).toMillis()
      : (current?.expiresAt as number | undefined) || 0;

    return NextResponse.json(
      {
        ok: true,
        currentToken: current
          ? {
              tokenMint: current.tokenMint || null,
              queueItemId: current.queueItemId || null,
              expiresAt: currentExpiresAt,
              isPriority: !!current.isPriority,
              priorityLevel: Number(current.priorityLevel || 0),
              displayDuration: Number(current.displayDuration || 0),
              walletAddress: current.walletAddress || null,
            }
          : null,
        queue,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[State] Error:', error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
