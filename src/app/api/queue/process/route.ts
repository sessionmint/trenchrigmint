import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb, FieldValue, Timestamp } from '@/lib/firebase-admin';
import { DEFAULT_TOKEN_MINT, HELIUS_API_KEY, ADMIN_API_KEY, CRON_SECRET } from '@/lib/constants';
import { getAppBaseUrl } from '@/lib/app-url';

// ============================================
// AUTHENTICATION
// ============================================

function verifyAuth(request: NextRequest, requireAdmin: boolean = false): boolean {
  const authHeader = request.headers.get('authorization');

  // Check for cron secret
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    return true;
  }

  // Check for admin API key
  if (ADMIN_API_KEY) {
    const providedKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (providedKey === ADMIN_API_KEY) {
      return true;
    }
  }

  // For POST (processing), allow unauthenticated - it's safe because:
  // - Only uses Admin SDK for writes
  // - Just moves queue items, no sensitive operations
  if (!requireAdmin) {
    return true;
  }

  return false;
}

// ============================================
// TYPES
// ============================================

interface QueueItem {
  id: string;
  tokenMint: string;
  walletAddress: string;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  position: number;
}

interface CurrentToken {
  tokenMint: string;
  queueItemId: string | null;
  expiresAt: Timestamp | null;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  walletAddress: string | null;
}

// ============================================
// WEBHOOK UPDATE
// ============================================

async function updateHeliusWebhook(tokenMint: string, baseUrl: string): Promise<boolean> {
  if (!HELIUS_API_KEY) {
    console.log('[Process] Helius API key not configured, skipping webhook update');
    return false;
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.error('[Process] Admin API key not configured, cannot update webhook');
    return false;
  }

  // Read last tracked token for diagnostics only.
  const db = getAdminDb();
  const settingsDoc = await db.doc('settings/webhook').get();
  const lastToken = settingsDoc.exists ? settingsDoc.data()?.trackedToken : null;
  console.log('[Process] Webhook sync requested:', { from: lastToken, to: tokenMint });

  try {
    const response = await fetch(`${baseUrl}/api/webhook/manage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`,
      },
      body: JSON.stringify({ tokenMint, webhookUrl: baseUrl }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Process] Failed to update webhook:', error);
      return false;
    } else {
      console.log('[Process] Webhook updated to track:', tokenMint);
      // Save the tracked token to Firebase
      await db.doc('settings/webhook').set({ 
        trackedToken: tokenMint,
        updatedAt: FieldValue.serverTimestamp() 
      }, { merge: true });
      return true;
    }
  } catch (error) {
    console.error('[Process] Error updating webhook:', error);
    return false;
  }
}

// ============================================
// QUEUE PROCESSING
// ============================================

async function getCurrentToken(): Promise<CurrentToken | null> {
  const db = getAdminDb();
  const docSnap = await db.doc('settings/currentToken').get();

  if (docSnap.exists) {
    return docSnap.data() as CurrentToken;
  }
  return null;
}

async function getNextQueueItem(): Promise<QueueItem | null> {
  const db = getAdminDb();
  const snapshot = await db
    .collection('queue')
    .orderBy('position', 'asc')
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as QueueItem;
}

async function setCurrentToken(
  tokenMint: string,
  queueItemId: string | null,
  expiresAt: Date | null,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  walletAddress: string | null
): Promise<void> {
  const db = getAdminDb();

  await db.doc('settings/currentToken').set({
    tokenMint,
    queueItemId,
    expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
    isPriority,
    priorityLevel,
    displayDuration,
    walletAddress,
    activeAt: Timestamp.fromDate(new Date()), // Track when token became active
    sessionStarted: false, // Will be set to true when device session starts
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function removeFromQueue(id: string): Promise<void> {
  const db = getAdminDb();
  await db.collection('queue').doc(id).delete();
}

// ============================================
// API HANDLER
// ============================================

/**
 * POST - Process queue: check if current token expired and move to next
 * Allows client-triggered processing (safe - uses Admin SDK)
 */
export async function POST(request: NextRequest) {
  try {
    // Allow client-triggered processing
    if (!verifyAuth(request, false)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const baseUrl = getAppBaseUrl(request.nextUrl.origin);

    // Get current token
    const current = await getCurrentToken();
    const now = Date.now();

    console.log('[Process] Current token state:', {
      tokenMint: current?.tokenMint,
      queueItemId: current?.queueItemId,
      expiresAt: current?.expiresAt?.toMillis(),
      now
    });

    // Check if current token has expired
    const isExpired = current?.expiresAt
      ? current.expiresAt.toMillis() < now
      : !current?.queueItemId; // No active item means we should process

    console.log('[Process] Is expired:', isExpired);

    if (!isExpired && current?.queueItemId) {
      console.log('[Process] Skipping - current token not expired');
      return NextResponse.json({
        processed: false,
        reason: 'Current token not expired',
        currentToken: current.tokenMint,
        expiresAt: current.expiresAt?.toDate().toISOString(),
        expiresIn: current.expiresAt ? current.expiresAt.toMillis() - now : null,
      });
    }

    // Get next item from queue
    const nextItem = await getNextQueueItem();
    console.log('[Process] Next queue item:', nextItem ? { id: nextItem.id, tokenMint: nextItem.tokenMint } : 'none');

    // Stop the current device session before transitioning
    // This clears both in-memory session and Firestore deviceSession document
    if (current?.queueItemId && current.tokenMint !== DEFAULT_TOKEN_MINT) {
      console.log('[Process] Stopping device session for expired token:', current.tokenMint);
      try {
        await fetch(`${baseUrl}/api/device/autoblow/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', tokenMint: current.tokenMint })
        });
      } catch (err) {
        console.error('[Process] Failed to stop device session:', err);
      }
    }

    if (nextItem) {
      // Set next item as current using its own display duration
      const expiresAt = new Date(now + nextItem.displayDuration);

      await setCurrentToken(
        nextItem.tokenMint,
        nextItem.id,
        expiresAt,
        nextItem.isPriority,
        nextItem.priorityLevel,
        nextItem.displayDuration,
        nextItem.walletAddress
      );

      // Remove from queue
      await removeFromQueue(nextItem.id);

      // Update webhook to track new token
      const webhookSynced = await updateHeliusWebhook(nextItem.tokenMint, baseUrl);

      // Note: Device session will be started by the status endpoint after 10-second cooldown
      // This is handled in /api/device/status to be serverless-compatible

      return NextResponse.json({
        processed: true,
        action: 'next_item',
        queueItemId: nextItem.id,
        tokenMint: nextItem.tokenMint,
        walletAddress: nextItem.walletAddress,
        expiresAt: expiresAt.toISOString(),
        isPriority: nextItem.isPriority,
        priorityLevel: nextItem.priorityLevel,
        displayDuration: nextItem.displayDuration,
        webhookSynced,
      });
    } else {
      // Queue empty - reset to default token
      await setCurrentToken(DEFAULT_TOKEN_MINT, null, null, false, 0, 0, null);

      // Update webhook to track default token
      const webhookSynced = await updateHeliusWebhook(DEFAULT_TOKEN_MINT, baseUrl);

      return NextResponse.json({
        processed: true,
        action: 'reset_to_default',
        tokenMint: DEFAULT_TOKEN_MINT,
        webhookSynced,
      });
    }
  } catch (error) {
    console.error('[Process] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process queue' },
      { status: 500 }
    );
  }
}

/**
 * GET - Get queue status
 * Requires admin API key
 */
export async function GET(request: NextRequest) {
  try {
    // GET requires admin auth
    if (!verifyAuth(request, true)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getAdminDb();

    // Get current token
    const current = await getCurrentToken();

    // Get queue length
    const queueSnapshot = await db.collection('queue').get();
    const queueLength = queueSnapshot.size;

    // Get queue items
    const queueItems = queueSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    const now = Date.now();
    const expiresAt = current?.expiresAt?.toMillis();

    return NextResponse.json({
      currentToken: current?.tokenMint || DEFAULT_TOKEN_MINT,
      queueItemId: current?.queueItemId || null,
      isPriority: current?.isPriority || false,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      expiresIn: expiresAt ? Math.max(0, expiresAt - now) : null,
      isExpired: expiresAt ? expiresAt < now : true,
      queueLength,
      queue: queueItems,
    });
  } catch (error) {
    console.error('[Process] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get queue status' },
      { status: 500 }
    );
  }
}
