import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

type CurrentTokenDoc = {
  tokenMint?: string;
  queueItemId?: string | null;
  expiresAt?: { toMillis?: () => number } | null;
  isPriority?: boolean;
  priorityLevel?: number;
  displayDuration?: number;
  walletAddress?: string | null;
};

export async function GET() {
  try {
    const db = getAdminDb();

    const [currentSnap, queueSnap] = await Promise.all([
      db.doc('settings/currentToken').get(),
      db.collection('queue').orderBy('position', 'asc').limit(200).get(),
    ]);

    const current = (currentSnap.exists ? (currentSnap.data() as CurrentTokenDoc) : null);

    const queue = queueSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const expiresAt = (data.expiresAt as { toMillis?: () => number } | null | undefined)?.toMillis?.() ?? 0;
      const addedAt = (data.addedAt as { toMillis?: () => number } | null | undefined)?.toMillis?.() ?? 0;
      return {
        id: d.id,
        tokenMint: String(data.tokenMint || ''),
        walletAddress: String(data.walletAddress || ''),
        expiresAt,
        isPriority: !!data.isPriority,
        priorityLevel: Number(data.priorityLevel || 0),
        displayDuration: Number(data.displayDuration || 600000),
        addedAt,
        position: Number(data.position || 0),
      };
    });

    const currentExpiresAt = current?.expiresAt?.toMillis?.() ?? 0;

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

