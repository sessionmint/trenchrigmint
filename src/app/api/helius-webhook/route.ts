import { NextRequest, NextResponse } from 'next/server';
import {
  DEVICE_API_URL,
  DEVICE_API_KEY,
  HELIUS_WEBHOOK_AUTH_TOKEN,
  HELIUS_WEBHOOK_IPS,
  VERIFY_WEBHOOK_IP,
} from '@/lib/constants';
import { resolveAutoblowClusterUrl } from '@/lib/autoblow/cluster';

// ============================================
// TYPES
// ============================================

interface HeliusWebhookPayload {
  type: string;
  signature: string;
  slot: number;
  timestamp: number;
  tokenTransfers?: TokenTransfer[];
  nativeTransfers?: NativeTransfer[];
  accountData?: AccountData[];
  description?: string;
  source?: string;
  feePayer?: string;
}

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

interface AccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
}

interface TokenBalanceChange {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: {
    tokenAmount: string;
    decimals: number;
  };
}

interface TradeEvent {
  type: 'BUY' | 'SELL';
  signature: string;
  tokenMint: string;
  amount: number;
  priceInSol: number;
  wallet: string;
  timestamp: number;
}

// ============================================
// SECURITY FUNCTIONS
// ============================================

/**
 * Extract client IP from request headers
 * Handles various proxy configurations (Vercel, Cloudflare, etc.)
 */
function getClientIP(request: NextRequest): string | null {
  // Try various headers in order of reliability
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // x-forwarded-for can contain multiple IPs, first one is the client
    return forwardedFor.split(',')[0].trim();
  }

  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP.trim();
  }

  // Vercel-specific
  const vercelForwardedFor = request.headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor) {
    return vercelForwardedFor.split(',')[0].trim();
  }

  return null;
}

/**
 * Verify the request comes from Helius's IP addresses
 */
function verifyHeliusIP(request: NextRequest): boolean {
  if (!VERIFY_WEBHOOK_IP) {
    // IP verification disabled (e.g., for development)
    return true;
  }

  const clientIP = getClientIP(request);
  
  if (!clientIP) {
    console.warn('[Webhook] Could not determine client IP');
    return false;
  }

  const isAllowed = HELIUS_WEBHOOK_IPS.includes(clientIP);
  
  if (!isAllowed) {
    console.warn(`[Webhook] Request from non-Helius IP: ${clientIP}`);
  }

  return isAllowed;
}

/**
 * Verify the authorization token matches what we configured in Helius
 */
function verifyAuthToken(request: NextRequest): boolean {
  if (!HELIUS_WEBHOOK_AUTH_TOKEN) {
    console.warn('[Webhook] No auth token configured - webhook is unprotected!');
    // In production, you should require this
    return process.env.NODE_ENV !== 'production';
  }

  const authHeader = request.headers.get('authorization');
  
  if (!authHeader) {
    console.error('[Webhook] No authorization header provided');
    return false;
  }

  // Helius sends the token directly or as "Bearer <token>"
  const providedToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  return providedToken === HELIUS_WEBHOOK_AUTH_TOKEN;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function parseHeliusTransaction(payload: HeliusWebhookPayload): TradeEvent | null {
  try {
    const { signature, timestamp, tokenTransfers, nativeTransfers, feePayer } = payload;

    if (!tokenTransfers || tokenTransfers.length === 0) {
      return null;
    }

    // Use the first token transfer (Helius webhook is already filtered to tracked token)
    const relevantTransfer = tokenTransfers[0];
    if (!relevantTransfer) {
      return null;
    }

    // Calculate SOL amount from native transfers
    let solAmount = 0;
    if (nativeTransfers && nativeTransfers.length > 0) {
      // Sum up SOL movements (in lamports)
      const totalSolMoved = nativeTransfers.reduce((sum, t) => sum + Math.abs(t.amount), 0);
      solAmount = totalSolMoved / 2 / 1e9; // Divide by 2 to avoid double counting, convert to SOL
    }

    // Determine if BUY or SELL based on token flow
    // If feePayer received tokens, it's a BUY; if they sent tokens, it's a SELL
    const isBuy = relevantTransfer.toUserAccount === feePayer;

    return {
      type: isBuy ? 'BUY' : 'SELL',
      signature,
      tokenMint: relevantTransfer.mint,
      amount: relevantTransfer.tokenAmount,
      priceInSol: solAmount,
      wallet: feePayer || relevantTransfer.fromUserAccount,
      timestamp: timestamp * 1000, // Convert to milliseconds
    };
  } catch (error) {
    console.error('[Webhook] Error parsing transaction:', error);
    return null;
  }
}

// ============================================
// AUTOBLOW DEVICE CONTROL
// ============================================

// Environment config
const AUTOBLOW_DEVICE_TOKEN = process.env.AUTOBLOW_DEVICE_TOKEN || '';
const AUTOBLOW_ENABLED = process.env.AUTOBLOW_ENABLED === 'true';
const AUTOBLOW_CLUSTER = process.env.AUTOBLOW_CLUSTER || '';

// Safety limits
const MIN_SPEED = 10;
const MAX_SPEED = 70;        // Capped at 70% for safety
const MIN_POSITION = 25;     // Don't go below 25%
const MAX_POSITION = 75;     // Don't go above 75%
const BASE_SPEED = 30;       // Starting speed

// ============================================
// RATE LIMITING CONFIG
// ============================================
// Client wants: 1 minute cooldown, sustainable for 12-24 hours
// 
// Strategy: Batch trades and send 1 command per COMMAND_INTERVAL
// - Collect all trades during the interval
// - Send a single command based on net sentiment
// 
// API calls per hour: 60 / (COMMAND_INTERVAL_MS / 60000) = 6 calls/hour (at 10min interval)
// Over 24 hours: 144 calls (very sustainable)

const COMMAND_INTERVAL_MS = 60000;  // 1 minute between device commands (60 calls/hour max)
const INACTIVITY_STOP_MS = 120000;  // Stop after 2 minutes of no trades

// Batching state (note: in serverless, this resets per invocation, but that's ok)
let lastCommandTime = 0;
let tradeBatch = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 };

// Track current state
let currentSpeed = BASE_SPEED;
let inactivityTimeout: NodeJS.Timeout | null = null;

async function getAutoblowClusterUrl(): Promise<string> {
  return resolveAutoblowClusterUrl(AUTOBLOW_DEVICE_TOKEN, AUTOBLOW_CLUSTER);
}

async function setAutoblowOscillation(speed: number, minY: number, maxY: number): Promise<boolean> {
  try {
    const baseUrl = await getAutoblowClusterUrl();
    const response = await fetch(`${baseUrl}/autoblow/oscillate`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-device-token': AUTOBLOW_DEVICE_TOKEN
      },
      body: JSON.stringify({ speed, minY, maxY })
    });
    return response.ok;
  } catch (error) {
    console.error('[Autoblow] Error setting oscillation:', error);
    return false;
  }
}

async function stopAutoblow(): Promise<boolean> {
  try {
    const baseUrl = await getAutoblowClusterUrl();
    const response = await fetch(`${baseUrl}/autoblow/oscillate/stop`, {
      method: 'PUT',
      headers: { 'x-device-token': AUTOBLOW_DEVICE_TOKEN }
    });
    currentSpeed = BASE_SPEED;
    tradeBatch = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 };
    return response.ok;
  } catch (error) {
    console.error('[Autoblow] Error stopping:', error);
    return false;
  }
}

function resetInactivityTimer() {
  if (inactivityTimeout) {
    clearTimeout(inactivityTimeout);
  }
  inactivityTimeout = setTimeout(async () => {
    console.log('[Autoblow] Inactivity timeout - stopping device');
    await stopAutoblow();
  }, INACTIVITY_STOP_MS);
}

/**
 * Calculate device parameters from batched trades
 * More buys = faster, more sells = slower
 * Higher volume = wider stroke range
 */
function calculateDeviceParams(batch: typeof tradeBatch): { speed: number; minY: number; maxY: number } {
  const totalTrades = batch.buys + batch.sells;
  
  if (totalTrades === 0) {
    return { speed: currentSpeed, minY: 40, maxY: 60 };
  }

  // Net sentiment: positive = bullish, negative = bearish
  const netTrades = batch.buys - batch.sells;
  const netVolume = batch.buyVolume - batch.sellVolume;
  
  // Calculate speed adjustment (-20 to +20 range based on sentiment)
  const tradeRatio = netTrades / Math.max(totalTrades, 1);
  const speedAdjust = Math.round(tradeRatio * 20);
  
  // Volume boost (0-10 extra speed for high volume)
  const totalVolume = batch.buyVolume + batch.sellVolume;
  const volumeBoost = Math.min(Math.floor(totalVolume * 5), 10);
  
  // Apply to current speed with bounds
  let newSpeed = currentSpeed + speedAdjust + (netVolume > 0 ? volumeBoost : -volumeBoost / 2);
  newSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(newSpeed)));
  
  // Stroke range based on activity level
  const activityLevel = Math.min(totalTrades / 20, 1); // Normalize to 0-1
  const rangeExpansion = Math.floor(activityLevel * 15);
  const minY = Math.max(MIN_POSITION, 50 - rangeExpansion);
  const maxY = Math.min(MAX_POSITION, 50 + rangeExpansion);
  
  return { speed: newSpeed, minY, maxY };
}

async function handleTradeForAutoblow(trade: TradeEvent): Promise<void> {
  if (!AUTOBLOW_ENABLED || !AUTOBLOW_DEVICE_TOKEN) {
    return;
  }

  // Always add to batch
  if (trade.type === 'BUY') {
    tradeBatch.buys++;
    tradeBatch.buyVolume += trade.priceInSol;
  } else {
    tradeBatch.sells++;
    tradeBatch.sellVolume += trade.priceInSol;
  }

  // Check cooldown - only send command every COMMAND_INTERVAL_MS
  const now = Date.now();
  const timeSinceLastCommand = now - lastCommandTime;
  
  if (timeSinceLastCommand < COMMAND_INTERVAL_MS) {
    // Still in cooldown, just batch the trade
    const shortToken = `${trade.tokenMint.slice(0, 4)}...${trade.tokenMint.slice(-4)}`;
    console.log(`[Autoblow] Batched ${trade.type} on ${shortToken} | Batch: ${tradeBatch.buys}B/${tradeBatch.sells}S | Cooldown: ${Math.round((COMMAND_INTERVAL_MS - timeSinceLastCommand) / 1000)}s`);
    return;
  }

  // Cooldown expired - calculate params from batch and send command
  const params = calculateDeviceParams(tradeBatch);
  currentSpeed = params.speed;

  const shortToken = `${trade.tokenMint.slice(0, 4)}...${trade.tokenMint.slice(-4)}`;
  console.log(`[Autoblow] SENDING COMMAND | Token: ${shortToken} | Speed: ${params.speed}% | Range: ${params.minY}-${params.maxY}% | Batch: ${tradeBatch.buys}B/${tradeBatch.sells}S (${(tradeBatch.buyVolume + tradeBatch.sellVolume).toFixed(4)} SOL)`);

  // Send command
  const success = await setAutoblowOscillation(params.speed, params.minY, params.maxY);
  
  if (success) {
    lastCommandTime = now;
    // Reset batch after successful send
    tradeBatch = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 };
    resetInactivityTimer();
  }
}

// Legacy device alert (for other devices if configured)
async function sendDeviceAlert(trade: TradeEvent): Promise<void> {
  // First handle Autoblow
  await handleTradeForAutoblow(trade);
  
  // Then handle other device if configured
  if (!DEVICE_API_URL) {
    return;
  }

  const devicePayload = {
    event: trade.type,
    data: {
      type: trade.type,
      amount: trade.amount,
      priceInSol: trade.priceInSol,
      tokenMint: trade.tokenMint,
      wallet: trade.wallet?.slice(0, 8) + '...',
      timestamp: trade.timestamp,
    },
    controls: {
      color: trade.type === 'BUY' ? '#39FF14' : '#FF1493',
      intensity: Math.min(Math.floor(trade.priceInSol * 100), 100),
      duration: Math.min(Math.max(Math.floor(trade.priceInSol * 2000), 500), 10000),
      pattern: trade.type === 'BUY' ? 'pulse' : 'flash',
      sound: trade.type === 'BUY' ? 'cha-ching' : 'whoosh',
    },
  };

  try {
    const response = await fetch(DEVICE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DEVICE_API_KEY && { 'Authorization': `Bearer ${DEVICE_API_KEY}` }),
      },
      body: JSON.stringify(devicePayload),
    });

    if (!response.ok) {
      console.error('[Device] Failed:', response.status);
    }
  } catch (error) {
    console.error('[Device] Error:', error);
  }
}

// ============================================
// WEBHOOK HANDLER
// ============================================

export async function POST(request: NextRequest) {
  try {
    // Security check 1: Verify IP address (if enabled)
    if (!verifyHeliusIP(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Security check 2: Verify authorization token
    if (!verifyAuthToken(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse the payload
    const rawBody = await request.text();
    let payload;
    
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const transactions: HeliusWebhookPayload[] = Array.isArray(payload) ? payload : [payload];

    // Quick filter: only process if there are token transfers (swaps)
    const hasTokenTransfers = transactions.some(tx => 
      tx.tokenTransfers && tx.tokenTransfers.length > 0
    );
    
    if (!hasTokenTransfers) {
      // Not a swap, skip entirely
      return NextResponse.json({ success: true, skipped: true, reason: 'no_token_transfers' });
    }

    // Process each transaction
    let processedCount = 0;
    for (const tx of transactions) {
      const trade = parseHeliusTransaction(tx);

      if (trade) {
        // Log trade with token info
        const shortToken = `${trade.tokenMint.slice(0, 4)}...${trade.tokenMint.slice(-4)}`;
        console.log(`[Trade] ${trade.type} | Token: ${shortToken} | Amount: ${trade.amount.toFixed(2)} | Price: ${trade.priceInSol.toFixed(6)} SOL`);

        // Handle Autoblow device and other alerts
        await sendDeviceAlert(trade);
        
        processedCount++;
      }
    }

    // Log summary
    if (processedCount > 0) {
      console.log(`[Webhook] Processed ${processedCount} swap(s) from ${transactions.length} transaction(s)`);
    }

    return NextResponse.json({
      success: true,
      received: transactions.length,
      processed: processedCount,
    });
  } catch (error) {
    console.error('[Webhook] Error processing webhook:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Health check endpoint (protected)
export async function GET(request: NextRequest) {
  // Only allow health checks from admin or with valid auth token
  const authHeader = request.headers.get('authorization');
  const adminKey = process.env.ADMIN_API_KEY;
  
  if (adminKey && authHeader !== `Bearer ${adminKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    status: 'ok',
    message: 'Webhook is active. Token tracking is managed by Helius webhook configuration.',
    network: 'mainnet',
    ipVerificationEnabled: VERIFY_WEBHOOK_IP,
    authTokenConfigured: !!HELIUS_WEBHOOK_AUTH_TOKEN,
    autoblowEnabled: AUTOBLOW_ENABLED,
    timestamp: new Date().toISOString(),
  });
}
