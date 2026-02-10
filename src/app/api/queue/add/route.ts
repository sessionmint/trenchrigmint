import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  addToQueueAdmin,
  logTransactionAdmin,
  isSignatureUsed,
  checkDuplicateCooldown,
  getAdminDb,
} from '@/lib/firebase-admin';
import {
  TREASURY_WALLET,
  STANDARD_PRICE,
  PRIORITY_BASIC,
  PRIORITY_DUPLICATE,
  PRIORITY_PREMIUM,
  DISPLAY_DURATION_STANDARD,
  DISPLAY_DURATION_PREMIUM,
  DUPLICATE_COOLDOWN_MS,
  PRIORITY_LEVELS,
} from '@/lib/constants';
import { getInternalBaseUrl } from '@/lib/app-url';

// ============================================
// TYPES
// ============================================

interface AddToQueueRequest {
  tokenMint: string;
  walletAddress: string;
  amount: number; // SOL amount paid
  signature: string;
  userId?: string | null;
}

const TX_LOOKUP_TIMEOUT_MS = 45_000;
const TX_LOOKUP_INTERVAL_MS = 2_500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRpcUrl(): string {
  const base = (process.env.NEXT_PUBLIC_HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com').trim();
  if (!base) return 'https://mainnet.helius-rpc.com';
  if (base.includes('api-key=')) return base;
  const apiKey = (process.env.HELIUS_API_KEY || process.env.NEXT_PUBLIC_HELIUS_API_KEY || '').trim();
  if (!apiKey) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}api-key=${encodeURIComponent(apiKey)}`;
}

// ============================================
// PAYMENT VERIFICATION
// ============================================

async function verifyPayment(
  signature: string,
  expectedPayer: string
): Promise<{ verified: boolean; amount: number; error?: string }> {
  try {
    const rpcUrl = buildRpcUrl();
    // Avoid leaking API keys in logs.
    console.log('[Payment] Verifying on RPC:', rpcUrl.replace(/api-key=[^&]+/i, 'api-key=***'));
    console.log('[Payment] Signature:', signature);
    console.log('[Payment] Expected payer:', expectedPayer);
    console.log('[Payment] Treasury wallet:', TREASURY_WALLET);
    
    const connection = new Connection(rpcUrl);

    // Give RPC time to index the transaction. This avoids false negatives
    // right after wallet confirms a payment.
    const deadline = Date.now() + TX_LOOKUP_TIMEOUT_MS;
    let tx: Awaited<ReturnType<typeof connection.getTransaction>> | null = null;
    while (Date.now() < deadline) {
      tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx) break;
      await sleep(TX_LOOKUP_INTERVAL_MS);
    }

    if (!tx) {
      console.log('[Payment] Transaction not found');
      return {
        verified: false,
        amount: 0,
        error: 'Transaction not indexed yet. Please wait 10-30s and retry with the SAME signature.',
      };
    }

    if (tx.meta?.err) {
      console.log('[Payment] Transaction failed on-chain:', tx.meta.err);
      return { verified: false, amount: 0, error: 'Transaction failed on-chain' };
    }

    // Get ALL account keys (including from lookup tables for versioned transactions)
    const accountKeys = tx.transaction.message.getAccountKeys();
    const allAccounts: string[] = [];
    
    // Get static keys
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys.get(i);
      if (key) {
        allAccounts.push(key.toBase58());
      }
    }
    
    console.log('[Payment] All accounts in tx:', allAccounts);

    // Find treasury wallet index
    const treasuryIndex = allAccounts.indexOf(TREASURY_WALLET);
    if (treasuryIndex === -1) {
      console.log('[Payment] Treasury wallet not found in transaction accounts');
      return { verified: false, amount: 0, error: 'Treasury wallet not found in transaction' };
    }

    // Check balance changes
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];

    console.log('[Payment] Pre balances:', preBalances);
    console.log('[Payment] Post balances:', postBalances);
    console.log('[Payment] Treasury index:', treasuryIndex);

    const treasuryReceived = (postBalances[treasuryIndex] - preBalances[treasuryIndex]) / LAMPORTS_PER_SOL;

    console.log('[Payment] Treasury received:', treasuryReceived, 'SOL');

    // Verify amount is one of the accepted tiers (with small tolerance)
    const validAmounts = [STANDARD_PRICE, PRIORITY_BASIC, PRIORITY_DUPLICATE, PRIORITY_PREMIUM];
    const matchedAmount = validAmounts.find(amt => Math.abs(treasuryReceived - amt) < 0.001);

    if (!matchedAmount) {
      return {
        verified: false,
        amount: 0,
        error: `Invalid payment amount: ${treasuryReceived.toFixed(4)} SOL. Must be ${STANDARD_PRICE}, ${PRIORITY_BASIC}, ${PRIORITY_DUPLICATE}, or ${PRIORITY_PREMIUM} SOL`
      };
    }

    console.log('[Payment] Verification successful! Matched tier:', matchedAmount, 'SOL');
    return { verified: true, amount: matchedAmount };
  } catch (error) {
    console.error('[Payment] Verification error:', error);
    return { verified: false, amount: 0, error: 'Failed to verify transaction' };
  }
}

// ============================================
// API HANDLER
// ============================================

export async function POST(request: NextRequest) {
  try {
    const body: AddToQueueRequest = await request.json();
    const { tokenMint, walletAddress, amount, signature, userId } = body;

    console.log('[Queue Add] Request received:', { tokenMint, walletAddress, amount, signature });

    // Validate required fields
    if (!tokenMint || !walletAddress || !signature) {
      return NextResponse.json(
        { error: 'Missing required fields: tokenMint, walletAddress, signature' },
        { status: 400 }
      );
    }

    // Validate token mint address
    try {
      new PublicKey(tokenMint);
    } catch {
      return NextResponse.json(
        { error: 'Invalid token mint address' },
        { status: 400 }
      );
    }

    // Validate wallet address
    try {
      new PublicKey(walletAddress);
    } catch {
      return NextResponse.json(
        { error: 'Invalid wallet address' },
        { status: 400 }
      );
    }

    // Check if signature has already been used (prevent replay attacks)
    const signatureUsed = await isSignatureUsed(signature);
    if (signatureUsed) {
      return NextResponse.json(
        { error: 'Transaction signature already used' },
        { status: 400 }
      );
    }

    // Verify the payment on-chain
    const verification = await verifyPayment(signature, walletAddress);

    if (!verification.verified) {
      // Log failed transaction for auditing
      await logTransactionAdmin(
        tokenMint,
        walletAddress,
        verification.amount || 0,
        'standard',
        signature,
        userId || null,
        false
      );
      
      return NextResponse.json(
        { error: verification.error || 'Payment verification failed' },
        { status: 400 }
      );
    }

    const paidAmount = verification.amount;

    // Determine tier based on amount paid
    let priorityLevel: number;
    let isPriority: boolean;
    let displayDuration: number;
    let tierType: 'standard' | 'priority';

    if (paidAmount === PRIORITY_PREMIUM) {
      priorityLevel = PRIORITY_LEVELS.PREMIUM;
      isPriority = true;
      displayDuration = DISPLAY_DURATION_PREMIUM;
      tierType = 'priority';
    } else if (paidAmount === PRIORITY_DUPLICATE) {
      priorityLevel = PRIORITY_LEVELS.DUPLICATE;
      isPriority = true;
      displayDuration = DISPLAY_DURATION_STANDARD;
      tierType = 'priority';
    } else if (paidAmount === PRIORITY_BASIC) {
      priorityLevel = PRIORITY_LEVELS.BASIC;
      isPriority = true;
      displayDuration = DISPLAY_DURATION_STANDARD;
      tierType = 'priority';
    } else {
      priorityLevel = PRIORITY_LEVELS.NONE;
      isPriority = false;
      displayDuration = DISPLAY_DURATION_STANDARD;
      tierType = 'standard';
    }

    // Check for duplicate address (only applies if not paying for duplicate override)
    const duplicateCheck = await checkDuplicateCooldown(tokenMint, DUPLICATE_COOLDOWN_MS);
    
    if (duplicateCheck.inCooldown && paidAmount < PRIORITY_DUPLICATE) {
      const hoursRemaining = Math.floor(duplicateCheck.remainingMs / (60 * 60 * 1000));
      const minutesRemaining = Math.ceil((duplicateCheck.remainingMs % (60 * 60 * 1000)) / (60 * 1000));
      
      // Log the rejected transaction
      await logTransactionAdmin(
        tokenMint,
        walletAddress,
        paidAmount,
        tierType,
        signature,
        userId || null,
        false
      );

      return NextResponse.json(
        { 
          error: `This token was recently queued. Please wait ${hoursRemaining}h ${minutesRemaining}m or pay ${PRIORITY_DUPLICATE} SOL to override the cooldown.`,
          code: 'DUPLICATE_COOLDOWN',
          remainingMs: duplicateCheck.remainingMs,
          overridePrice: PRIORITY_DUPLICATE
        },
        { status: 400 }
      );
    }

    // Log the successful transaction
    await logTransactionAdmin(
      tokenMint,
      walletAddress,
      paidAmount,
      tierType,
      signature,
      userId || null,
      true
    );

    // Check if queue is currently empty (no active item) - we'll process immediately after adding
    const db = getAdminDb();
    const currentTokenDoc = await db.doc('settings/currentToken').get();
    const currentToken = currentTokenDoc.data();
    const queueEmpty = !currentToken?.queueItemId;

    // Add to queue
    const queueItemId = await addToQueueAdmin(
      tokenMint,
      walletAddress,
      isPriority,
      priorityLevel,
      displayDuration,
      signature,
      userId || null
    );

    // If queue was empty, trigger processing to make this token active immediately
    let processedImmediately = false;
    let processError: string | null = null;
    let processResult: unknown = null;

    if (queueEmpty) {
      console.log('[Queue Add] Queue was empty, triggering immediate processing');
      console.log('[Queue Add] Token added with ID:', queueItemId);

      // Small delay to ensure Firestore write is fully synced
      await new Promise(resolve => setTimeout(resolve, 500));

      // Use internal fetch with absolute URL
      const baseUrl = getInternalBaseUrl(request.nextUrl.origin);
      console.log('[Queue Add] Using base URL:', baseUrl);

      try {
        const processRes = await fetch(`${baseUrl}/api/queue/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        processResult = await processRes.json();
        console.log('[Queue Add] Process result:', processResult);
        processedImmediately = !!(processRes.ok && (processResult as { processed?: unknown } | null)?.processed);
        if (!processedImmediately) {
          processError = (processResult as { error?: string } | null)?.error || 'Queue processing did not complete immediately';
        }
      } catch (e) {
        console.error('[Queue Add] Failed to trigger processing:', e);
        processError = e instanceof Error ? e.message : 'Failed to trigger queue processing';
      }
    } else {
      console.log('[Queue Add] Queue not empty, token added to queue with ID:', queueItemId);
    }

    // Determine response message based on tier
    let message: string;
    let tier: string;
    if (priorityLevel === PRIORITY_LEVELS.PREMIUM) {
      message = 'Premium token queued (1 hour display)';
      tier = 'premium';
    } else if (priorityLevel === PRIORITY_LEVELS.DUPLICATE) {
      message = 'Priority token queued (duplicate override)';
      tier = 'duplicate';
    } else if (priorityLevel === PRIORITY_LEVELS.BASIC) {
      message = 'Priority token queued';
      tier = 'basic';
    } else {
      message = 'Added to queue';
      tier = 'standard';
    }

    return NextResponse.json({
      success: true,
      message,
      queueItemId,
      priorityLevel,
      displayDuration,
      tier,
      processedImmediately,
      processError,
      // Expose processing details so the client can update UI immediately even if Firestore listeners lag.
      processResult,
    });
  } catch (error) {
    console.error('[Queue Add] Error:', error);
    
    // Check for Firebase quota errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: number })?.code;
    
    if (errorCode === 8 || errorMessage.includes('RESOURCE_EXHAUSTED') || errorMessage.includes('Quota exceeded')) {
      return NextResponse.json(
        { 
          error: 'Service temporarily unavailable due to high demand. Your payment was received - please contact support with your transaction signature for manual processing.',
          code: 'QUOTA_EXCEEDED'
        },
        { status: 503 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
