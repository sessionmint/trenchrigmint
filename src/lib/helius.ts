import { HELIUS_API_KEY, HELIUS_MAINNET_API } from './constants';

// ============================================
// TRADE EVENT TYPES
// ============================================

export interface TradeEvent {
  type: 'BUY' | 'SELL';
  signature: string;
  tokenMint: string;
  amount: number;
  priceInSol: number;
  wallet: string;
  timestamp: number;
}

interface EnhancedTokenTransfer {
  mint: string;
  toUserAccount?: string;
  fromUserAccount?: string;
  tokenAmount?: number;
}

interface EnhancedNativeTransfer {
  amount: number;
}

interface EnhancedTransaction {
  tokenTransfers?: EnhancedTokenTransfer[];
  nativeTransfers?: EnhancedNativeTransfer[];
  feePayer?: string;
  signature: string;
  timestamp?: number;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount?: {
    uiAmount?: number | null;
  };
}

interface ParsedMeta {
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  preBalances?: number[];
  postBalances?: number[];
}

interface ParsedTransaction {
  signatures?: string[];
  message?: {
    accountKeys?: Array<string | { pubkey?: string }>;
  };
}

interface WebsocketTransactionData {
  meta?: ParsedMeta;
  transaction?: ParsedTransaction;
}

function normalizeAccountKey(key: string | { pubkey?: string } | undefined): string {
  if (!key) return '';
  if (typeof key === 'string') return key;
  return key.pubkey || '';
}

// ============================================
// TRANSACTION PARSING
// ============================================

/**
 * Parse a Helius enhanced transaction to extract trade info
 * Used for processing MAINNET webhook data
 */
export function parseSwapTransaction(tx: EnhancedTransaction, tokenMint: string): TradeEvent | null {
  try {
    const tokenTransfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];
    
    const tokenTransfer = tokenTransfers.find(
      (t) => t.mint === tokenMint
    );
    
    if (!tokenTransfer) return null;

    const userAccount =
      tx.feePayer ||
      tokenTransfer.toUserAccount ||
      tokenTransfer.fromUserAccount ||
      '';
    const isBuy = tokenTransfer.toUserAccount === userAccount;
    
    const solTransfer = nativeTransfers.find(
      (t) => Math.abs(t.amount) > 10000
    );
    const solAmount = solTransfer ? Math.abs(solTransfer.amount) / 1e9 : 0;

    return {
      type: isBuy ? 'BUY' : 'SELL',
      signature: tx.signature,
      tokenMint: tokenMint,
      amount: Math.abs(tokenTransfer.tokenAmount || 0),
      priceInSol: solAmount,
      wallet: userAccount,
      timestamp: (tx.timestamp || Date.now() / 1000) * 1000,
    };
  } catch (error) {
    console.error('Error parsing swap transaction:', error);
    return null;
  }
}

/**
 * Parse transaction from websocket notification
 */
export function parseWebsocketTransaction(data: unknown, tokenMint: string): TradeEvent | null {
  try {
    const rawTx =
      typeof data === 'object' &&
      data !== null &&
      'transaction' in data &&
      (data as { transaction?: unknown }).transaction
        ? (data as { transaction?: unknown }).transaction
        : data;

    if (!rawTx || typeof rawTx !== 'object') return null;
    const tx = rawTx as WebsocketTransactionData;
    
    if (!tx.meta || !tx.transaction) return null;

    const signature = tx.transaction.signatures?.[0] || '';
    const accountKeys = tx.transaction.message?.accountKeys || [];
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let tokenChange = 0;
    let userWallet = normalizeAccountKey(accountKeys[0]);

    for (let i = 0; i < postBalances.length; i++) {
      const post = postBalances[i];
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      
      if (post.mint === tokenMint) {
        const postAmount = post.uiTokenAmount?.uiAmount || 0;
        const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
        tokenChange = postAmount - preAmount;
        
        if (tokenChange !== 0) {
          userWallet = normalizeAccountKey(accountKeys[post.accountIndex]) || userWallet;
        }
      }
    }

    if (tokenChange === 0) return null;

    const preSOL = tx.meta.preBalances?.[0] || 0;
    const postSOL = tx.meta.postBalances?.[0] || 0;
    const solChange = Math.abs(postSOL - preSOL) / 1e9;

    return {
      type: tokenChange > 0 ? 'BUY' : 'SELL',
      signature,
      tokenMint,
      amount: Math.abs(tokenChange),
      priceInSol: solChange,
      wallet: userWallet,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('Error parsing websocket transaction:', error);
    return null;
  }
}

/**
 * Fetch recent transactions for a token from MAINNET
 * Note: This uses the server-side HELIUS_API_KEY
 */
export async function getRecentTokenTransactions(tokenMint: string): Promise<EnhancedTransaction[]> {
  if (!HELIUS_API_KEY) {
    console.warn('Helius API key not configured (server-side)');
    return [];
  }

  try {
    const key = encodeURIComponent(HELIUS_API_KEY);
    const response = await fetch(
      `${HELIUS_MAINNET_API}/addresses/${tokenMint}/transactions?api-key=${key}&limit=20&type=SWAP`
    );
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload as EnhancedTransaction[] : [];
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return [];
  }
}

/**
 * Get token metadata from MAINNET
 */
export async function getTokenMetadata(tokenMint: string): Promise<Record<string, unknown> | null> {
  if (!HELIUS_API_KEY) {
    console.warn('Helius API key not configured');
    return null;
  }

  try {
    const key = encodeURIComponent(HELIUS_API_KEY);
    const response = await fetch(`${HELIUS_MAINNET_API}/token-metadata?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [tokenMint] }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    return Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) || null : null;
  } catch (error) {
    console.error('Error fetching token metadata:', error);
    return null;
  }
}
