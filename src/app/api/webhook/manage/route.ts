import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb, FieldValue } from '@/lib/firebase-admin';
import {
  HELIUS_API_KEY,
  HELIUS_MAINNET_API,
  DEFAULT_TOKEN_MINT,
  ADMIN_API_KEY,
  HELIUS_WEBHOOK_AUTH_TOKEN,
  HELIUS_WEBHOOK_CLEANUP_EXTRAS,
} from '@/lib/constants';
import { getAppBaseUrl } from '@/lib/app-url';

// ============================================
// AUTHENTICATION
// ============================================

function verifyAdminAuth(request: NextRequest): boolean {
  if (!ADMIN_API_KEY) {
    console.error('[Webhook Manage] CRITICAL: No admin API key configured!');
    return false; // Always require API key
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <key>" and just "<key>"
  const providedKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  return providedKey === ADMIN_API_KEY;
}

// ============================================
// TYPES
// ============================================

interface HeliusWebhook {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
  authHeader?: string;
}

interface WebhookConfig {
  webhookId: string | null;
  currentToken: string;
  authToken?: string;
}

// ============================================
// HELIUS WEBHOOK MANAGEMENT (MAINNET)
// ============================================

const HELIUS_API_BASE = HELIUS_MAINNET_API;
const HELIUS_API_KEY_QS = encodeURIComponent(HELIUS_API_KEY);

async function getExistingWebhooks(): Promise<HeliusWebhook[]> {
  if (!HELIUS_API_KEY) {
    throw new Error('Helius API key not configured');
  }

  const response = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${HELIUS_API_KEY_QS}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get webhooks: ${response.status} - ${error}`);
  }

  return response.json();
}

async function createWebhook(webhookUrl: string, tokenMint: string): Promise<HeliusWebhook> {
  if (!HELIUS_API_KEY) {
    throw new Error('Helius API key not configured');
  }

  const webhookConfig: Record<string, unknown> = {
    webhookURL: webhookUrl,
    transactionTypes: ['SWAP'], // Only swaps, not transfers
    accountAddresses: [tokenMint],
    webhookType: 'enhanced', // Enhanced for mainnet with parsed data
    txnStatus: 'success',
  };

  // Add auth header if configured for security
  if (HELIUS_WEBHOOK_AUTH_TOKEN) {
    webhookConfig.authHeader = HELIUS_WEBHOOK_AUTH_TOKEN;
  }

  const response = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${HELIUS_API_KEY_QS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookConfig),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook: ${error}`);
  }

  return response.json();
}

async function updateWebhook(webhookId: string, tokenMint: string): Promise<HeliusWebhook> {
  if (!HELIUS_API_KEY) {
    throw new Error('Helius API key not configured');
  }

  const updateConfig: Record<string, unknown> = {
    accountAddresses: [tokenMint],
  };

  // Update auth header if configured
  if (HELIUS_WEBHOOK_AUTH_TOKEN) {
    updateConfig.authHeader = HELIUS_WEBHOOK_AUTH_TOKEN;
  }

  const response = await fetch(`${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${HELIUS_API_KEY_QS}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateConfig),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update webhook: ${error}`);
  }

  return response.json();
}

async function deleteWebhook(webhookId: string): Promise<void> {
  if (!HELIUS_API_KEY) {
    throw new Error('Helius API key not configured');
  }

  const response = await fetch(`${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${HELIUS_API_KEY_QS}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete webhook: ${error}`);
  }
}

async function getWebhookConfig(): Promise<WebhookConfig> {
  const db = getAdminDb();
  const docSnap = await db.doc('settings/webhook').get();

  if (docSnap.exists) {
    const data = docSnap.data();
    return {
      webhookId: data?.webhookId || null,
      currentToken: data?.currentToken || DEFAULT_TOKEN_MINT,
      authToken: data?.authToken,
    };
  }

  return { webhookId: null, currentToken: DEFAULT_TOKEN_MINT };
}

async function saveWebhookConfig(webhookId: string, currentToken: string): Promise<void> {
  const db = getAdminDb();
  await db.doc('settings/webhook').set({
    webhookId,
    currentToken,
    trackedToken: currentToken, // Also save as trackedToken for duplicate check
    network: 'mainnet', // Store network for clarity
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ============================================
// API HANDLERS
// ============================================

// Delay between API calls to prevent rate limiting
const API_CALL_DELAY = 500; // 500ms between Helius API calls

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure only one webhook exists - delete all extras, return the one to use
 */
async function ensureSingleWebhook(existingWebhooks: HeliusWebhook[], storedWebhookId: string | null): Promise<HeliusWebhook | null> {
  if (existingWebhooks.length === 0) {
    return null;
  }

  // Find the webhook to keep: prefer the stored one, otherwise use the first
  let webhookToKeep = storedWebhookId
    ? existingWebhooks.find(w => w.webhookID === storedWebhookId)
    : null;

  // If stored webhook doesn't exist anymore, use the first available
  if (!webhookToKeep) {
    webhookToKeep = existingWebhooks[0];
    console.log(`[Webhook] Stored webhook ${storedWebhookId} not found, using ${webhookToKeep.webhookID}`);
  }

  // Delete all other webhooks (with delays to prevent rate limiting)
  const webhooksToDelete = existingWebhooks.filter(w => w.webhookID !== webhookToKeep!.webhookID);

  if (webhooksToDelete.length > 0) {
    if (!HELIUS_WEBHOOK_CLEANUP_EXTRAS) {
      console.log(`[Webhook] Found ${webhooksToDelete.length} extra webhook(s). Cleanup disabled (set HELIUS_WEBHOOK_CLEANUP_EXTRAS=true to delete extras).`);
      return webhookToKeep;
    }

    console.log(`[Webhook] Cleaning up ${webhooksToDelete.length} extra webhook(s)`);
    for (const w of webhooksToDelete) {
      try {
        await deleteWebhook(w.webhookID);
        console.log(`[Webhook] Deleted extra webhook: ${w.webhookID}`);
        // Add delay between deletes to avoid rate limiting
        if (webhooksToDelete.indexOf(w) < webhooksToDelete.length - 1) {
          await delay(API_CALL_DELAY);
        }
      } catch (e) {
        console.error(`[Webhook] Failed to delete webhook ${w.webhookID}:`, e);
      }
    }
  }

  return webhookToKeep;
}

/**
 * POST - Update webhook for a new token (MAINNET)
 * Only creates a webhook if none exist (first-time setup)
 * Always updates the single existing webhook
 * Requires admin API key
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    if (!verifyAdminAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized - admin API key required' }, { status: 401 });
    }

    if (!HELIUS_API_KEY) {
      return NextResponse.json({ error: 'Helius API key not configured (HELIUS_API_KEY env var)' }, { status: 500 });
    }

    const { tokenMint, webhookUrl } = await request.json();
    let targetTokenMint: string = tokenMint;

    // If tokenMint is omitted, sync webhook to current active token.
    if (!targetTokenMint) {
      const db = getAdminDb();
      const currentDoc = await db.doc('settings/currentToken').get();
      const currentData = currentDoc.data();
      targetTokenMint = currentData?.tokenMint || DEFAULT_TOKEN_MINT;
      console.log('[Webhook] tokenMint not provided, using current token:', targetTokenMint);
    }

    // Validate token mint address format (basic check)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(targetTokenMint)) {
      return NextResponse.json({ error: 'Invalid token mint address format' }, { status: 400 });
    }

    // Get the webhook URL from request or construct it
    const baseUrl = (typeof webhookUrl === 'string' && webhookUrl.trim())
      ? webhookUrl.replace(/\/+$/, '')
      : getAppBaseUrl(request.nextUrl.origin);
    const fullWebhookUrl = `${baseUrl}/api/helius-webhook`;

    // Get existing webhook config from Firebase
    const config = await getWebhookConfig();

    // Get all existing webhooks from Helius
    const existingWebhooks = await getExistingWebhooks();
    console.log(`[Webhook] Found ${existingWebhooks.length} existing webhook(s) on Helius`);

    // Ensure only one webhook exists (clean up extras)
    let webhook = await ensureSingleWebhook(existingWebhooks, config.webhookId);

    if (webhook) {
      // Update the existing webhook to track the new token
      console.log(`[Webhook] Updating webhook ${webhook.webhookID} to track ${targetTokenMint}`);

      try {
        webhook = await updateWebhook(webhook.webhookID, targetTokenMint);
      } catch (updateError) {
        console.error(`[Webhook] Update failed:`, updateError);

        // If update fails, the webhook might be corrupted - try to recreate
        console.log(`[Webhook] Attempting to recreate webhook...`);
        try {
          await deleteWebhook(webhook.webhookID);
          webhook = await createWebhook(fullWebhookUrl, targetTokenMint);
          console.log(`[Webhook] Recreated webhook: ${webhook.webhookID}`);
        } catch (recreateError) {
          console.error(`[Webhook] Recreate failed:`, recreateError);
          return NextResponse.json(
            { error: 'Failed to update or recreate webhook. Please check Helius dashboard.' },
            { status: 500 }
          );
        }
      }
    } else {
      // No webhooks exist - create the first one (initial setup)
      console.log(`[Webhook] No webhooks found. Creating initial webhook for ${targetTokenMint}`);
      webhook = await createWebhook(fullWebhookUrl, targetTokenMint);
      console.log(`[Webhook] Created initial webhook: ${webhook.webhookID}`);
    }

    // Save config to Firebase
    await saveWebhookConfig(webhook.webhookID, targetTokenMint);

    return NextResponse.json({
      success: true,
      webhookId: webhook.webhookID,
      tokenMint: targetTokenMint,
      webhookUrl: fullWebhookUrl,
      network: 'mainnet',
      message: existingWebhooks.length > 0 ? 'Webhook updated' : 'Initial webhook created',
      cleanedUp: Math.max(0, existingWebhooks.length - 1),
    });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to manage webhook' },
      { status: 500 }
    );
  }
}

/**
 * GET - Get current webhook status (also cleans up extra webhooks)
 * Requires admin API key
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication
    if (!verifyAdminAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized - admin API key required' }, { status: 401 });
    }

    if (!HELIUS_API_KEY) {
      return NextResponse.json({ error: 'Helius API key not configured' }, { status: 500 });
    }

    const config = await getWebhookConfig();
    const webhooks = await getExistingWebhooks();

    // Clean up extra webhooks if there are more than one
    let cleanedUp = 0;
    let activeWebhook: HeliusWebhook | null = null;

    if (webhooks.length > 0) {
      activeWebhook = await ensureSingleWebhook(webhooks, config.webhookId);
      cleanedUp = Math.max(0, webhooks.length - 1);

      // Update stored config if the active webhook is different
      if (activeWebhook && activeWebhook.webhookID !== config.webhookId) {
        await saveWebhookConfig(activeWebhook.webhookID, config.currentToken);
      }
    }

    return NextResponse.json({
      configured: !!activeWebhook,
      webhookId: activeWebhook?.webhookID || config.webhookId,
      currentToken: config.currentToken,
      trackedAddresses: activeWebhook?.accountAddresses || [],
      network: 'mainnet',
      webhook: activeWebhook || null,
      totalWebhooksFound: webhooks.length,
      cleanedUp,
      securityConfig: {
        authTokenConfigured: !!HELIUS_WEBHOOK_AUTH_TOKEN,
        ipVerificationEnabled: process.env.VERIFY_WEBHOOK_IP === 'true',
      },
    });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get webhook status' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove webhook
 * Requires admin API key
 */
export async function DELETE(request: NextRequest) {
  try {
    // Verify admin authentication
    if (!verifyAdminAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized - admin API key required' }, { status: 401 });
    }

    if (!HELIUS_API_KEY) {
      return NextResponse.json({ error: 'Helius API key not configured' }, { status: 500 });
    }

    const config = await getWebhookConfig();

    if (config.webhookId) {
      await deleteWebhook(config.webhookId);

      // Clear config
      const db = getAdminDb();
      await db.doc('settings/webhook').delete();
    }

    return NextResponse.json({ success: true, deleted: config.webhookId });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete webhook' },
      { status: 500 }
    );
  }
}
