import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb, FieldValue } from '@/lib/firebase-admin';
import { DEFAULT_TOKEN_MINT, HELIUS_API_KEY, ADMIN_API_KEY, CRON_SECRET } from '@/lib/constants';
import { getInternalBaseUrl, getPublicBaseUrl } from '@/lib/app-url';
import {
  getCurrentToken,
  popNextQueueItem,
  setCurrentToken,
  resetToDefaultToken,
  listQueue,
  queueLength,
} from '@/lib/queue-driver';

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
// WEBHOOK UPDATE
// ============================================

async function updateHeliusWebhook(tokenMint: string, internalBaseUrl: string, publicBaseUrl: string): Promise<boolean> {
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
    const response = await fetch(`${internalBaseUrl}/api/webhook/manage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`,
      },
      body: JSON.stringify({ tokenMint, webhookUrl: publicBaseUrl }),
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

    const internalBaseUrl = getInternalBaseUrl(request.nextUrl.origin);
    const publicBaseUrl = getPublicBaseUrl(request.nextUrl.origin);

    // Get current token
    const current = await getCurrentToken();
    const now = Date.now();

    // Check if current token has expired
    const currentExpiresMs = typeof current?.expiresAt === 'object' && current?.expiresAt !== null && 'toMillis' in current.expiresAt
      ? (current.expiresAt as { toMillis: () => number }).toMillis()
      : (current?.expiresAt as number | undefined);

    console.log('[Process] Current token state:', {
      tokenMint: current?.tokenMint,
      queueItemId: current?.queueItemId,
      expiresAt: currentExpiresMs,
      now
    });

    const isExpired = currentExpiresMs
      ? currentExpiresMs < now
      : !current?.queueItemId; // No active item means we should process

    console.log('[Process] Is expired:', isExpired);

    if (!isExpired && current?.queueItemId) {
      console.log('[Process] Skipping - current token not expired');
      return NextResponse.json({
        processed: false,
        reason: 'Current token not expired',
        currentToken: current.tokenMint,
        expiresAt: currentExpiresMs ? new Date(currentExpiresMs).toISOString() : null,
        expiresIn: currentExpiresMs ? currentExpiresMs - now : null,
      });
    }

    // Get next item from queue
    const nextItem = await popNextQueueItem();
    console.log('[Process] Next queue item:', nextItem ? { id: nextItem.id, tokenMint: nextItem.tokenMint } : 'none');

    // Stop the current device session before transitioning
    // This clears both in-memory session and Firestore deviceSession document
    if (current?.queueItemId && current.tokenMint !== DEFAULT_TOKEN_MINT) {
      console.log('[Process] Stopping device session for expired token:', current.tokenMint);
      try {
        await fetch(`${internalBaseUrl}/api/device/autoblow/session`, {
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

      await setCurrentToken({
        tokenMint: nextItem.tokenMint,
        queueItemId: nextItem.id,
        expiresAt,
        isPriority: nextItem.isPriority,
        priorityLevel: nextItem.priorityLevel,
        displayDuration: nextItem.displayDuration,
        walletAddress: nextItem.walletAddress,
      });

      // Update webhook to track new token
      const webhookSynced = await updateHeliusWebhook(nextItem.tokenMint, internalBaseUrl, publicBaseUrl);

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
      await resetToDefaultToken(DEFAULT_TOKEN_MINT);

      // Update webhook to track default token
      const webhookSynced = await updateHeliusWebhook(DEFAULT_TOKEN_MINT, internalBaseUrl, publicBaseUrl);

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
 * GET
 * - Default: process queue (used by Vercel Cron, which issues GET requests and sets `x-vercel-cron: 1`)
 * - Status mode: `?status=1` returns queue status (requires admin API key)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const wantsStatus = searchParams.get('status') === '1';

    if (wantsStatus) {
      // Status requires admin auth
      if (!verifyAuth(request, true)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // Get current token + queue via configured driver
      const current = await getCurrentToken();
      const queueItems = await listQueue();
      const queueLengthValue = await queueLength();

      const now = Date.now();
      const expiresAtMs = typeof current?.expiresAt === 'object' && current?.expiresAt !== null && 'toMillis' in current.expiresAt
        ? (current.expiresAt as { toMillis: () => number }).toMillis()
        : (current?.expiresAt as number | undefined);

      return NextResponse.json({
        currentToken: current?.tokenMint || DEFAULT_TOKEN_MINT,
        queueItemId: current?.queueItemId || null,
        isPriority: current?.isPriority || false,
        expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
        expiresIn: expiresAtMs ? Math.max(0, expiresAtMs - now) : null,
        isExpired: expiresAtMs ? expiresAtMs < now : true,
        queueLength: queueLengthValue,
        queue: queueItems,
      });
    }

    // Default behavior: process queue.
    // Vercel Cron calls with x-vercel-cron: 1 and cannot attach Authorization headers.
    // We accept either x-vercel-cron, CRON_SECRET, ADMIN_API_KEY, or no auth (same as POST behavior).
    return await POST(request);
  } catch (error) {
    console.error('[Process] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get queue status' },
      { status: 500 }
    );
  }
}
