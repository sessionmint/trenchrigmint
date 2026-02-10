import { create } from 'zustand';
import { DEFAULT_TOKEN_MINT } from '@/lib/constants';
import {
  subscribeToQueue,
  subscribeToCurrentToken,
  getCurrentUserId,
  getQueueDB,
  getCurrentTokenDB,
  QueueItemDB,
} from '@/lib/firebase';
import { withAppBasePath } from '@/lib/app-url';
import { Timestamp } from 'firebase/firestore';

// ============================================
// TYPES
// ============================================

export interface QueueItem {
  id: string;
  tokenMint: string;
  walletAddress: string;
  expiresAt: number;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  addedAt: number;
}

interface QueueStore {
  // State
  currentToken: string;
  queue: QueueItem[];
  currentItem: QueueItem | null;
  isProcessing: boolean;
  isInitialized: boolean;
  
  // Actions
  initialize: () => () => void;
  addToQueue: (tokenMint: string, walletAddress: string, amount: number, signature: string) => Promise<{ processedImmediately?: boolean; tier?: string; [key: string]: unknown }>;
  processQueue: () => Promise<void>;
  removeCurrentAndAddPriority: (tokenMint: string, walletAddress: string, signature: string) => Promise<void>;
  refreshState: () => Promise<void>;
}

// Helper to convert Firestore timestamp to milliseconds
const timestampToMs = (ts: Timestamp | null): number => {
  if (!ts) return 0;
  try {
    return ts.toMillis();
  } catch {
    return 0;
  }
};

// Helper to convert QueueItemDB to QueueItem
const dbToLocal = (item: QueueItemDB): QueueItem => ({
  id: item.id,
  tokenMint: item.tokenMint,
  walletAddress: item.walletAddress,
  expiresAt: timestampToMs(item.expiresAt),
  isPriority: item.isPriority,
  priorityLevel: item.priorityLevel || 0,
  displayDuration: item.displayDuration || 600000, // Default 10 min
  addedAt: timestampToMs(item.addedAt),
});

// ============================================
// STORE
// ============================================

// Track when processing started (for timeout detection)
let processingStartTime = 0;
const PROCESSING_TIMEOUT_MS = 15000; // 15 seconds max

export const useQueueStore = create<QueueStore>((set, get) => ({
  currentToken: DEFAULT_TOKEN_MINT,
  queue: [],
  currentItem: null,
  isProcessing: false,
  isInitialized: false,

  /**
   * Initialize Firestore listeners
   * Returns cleanup function
   */
  initialize: () => {
    let processingTimeout: NodeJS.Timeout | null = null;
    let checkInterval: NodeJS.Timeout | null = null;

    console.log('[QueueStore] Initializing...');

    // Immediately fetch current state (don't wait for listeners)
    get().refreshState();

    // Subscribe to queue changes (read-only)
    const unsubQueue = subscribeToQueue((queueItems) => {
      const queue = queueItems.map(dbToLocal);
      console.log('[QueueStore] Queue updated:', queue.length, 'items');
      set({ queue });
      
      // Check if we need to process queue (no current item but queue has items)
      const { currentItem, isProcessing } = get();
      if (!currentItem && !isProcessing && queue.length > 0) {
        console.log('[QueueStore] No current item, processing queue...');
        get().processQueue();
      }
    });

    // Track the previous token to detect changes
    let previousTokenMint: string | null = null;

    // Subscribe to current token changes (read-only)
    const unsubCurrent = subscribeToCurrentToken((current) => {
      console.log('[QueueStore] Current token update:', current?.tokenMint);

      // Only clear timeout if token actually changed (not just sessionStarted or other fields)
      const tokenChanged = previousTokenMint !== null && previousTokenMint !== current?.tokenMint;
      if (tokenChanged && processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
      }

      if (current) {
        const expiresAt = timestampToMs(current.expiresAt);
        const now = Date.now();

        console.log('[QueueStore] ExpiresAt:', expiresAt, 'Now:', now, 'Diff:', expiresAt - now);

        // Check if current token has already expired
        if (expiresAt && expiresAt <= now && current.queueItemId) {
          console.log('[QueueStore] Token already expired, processing...');
          get().processQueue();
          return;
        }

        // Detect if this is a NEW token from the queue (not default, has queueItemId)
        const isNewQueuedToken = current.queueItemId &&
          current.tokenMint !== DEFAULT_TOKEN_MINT &&
          previousTokenMint !== null &&
          previousTokenMint !== current.tokenMint;

        if (isNewQueuedToken) {
          console.log('[QueueStore] New token from queue detected, dispatching session transition event');
          // Dispatch event for session transition (device pause + overlay)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('newPumpSession', {
              detail: { tokenMint: current.tokenMint }
            }));
          }
        }

        // Update previous token
        previousTokenMint = current.tokenMint;

        set({
          currentToken: current.tokenMint,
          currentItem: current.queueItemId ? {
            id: current.queueItemId,
            tokenMint: current.tokenMint,
            walletAddress: current.walletAddress || '',
            expiresAt: expiresAt,
            isPriority: current.isPriority,
            priorityLevel: current.priorityLevel || 0,
            displayDuration: current.displayDuration || 600000,
            addedAt: 0,
          } : null,
        });

        // Set timeout to process next when current expires
        // Only set/reset timeout if token changed OR no timeout exists yet
        if (expiresAt && current.queueItemId && (tokenChanged || !processingTimeout)) {
          const timeUntilExpiry = expiresAt - now;

          if (timeUntilExpiry > 0) {
            console.log('[QueueStore] Setting expiry timeout for', timeUntilExpiry, 'ms');
            processingTimeout = setTimeout(() => {
              console.log('[QueueStore] Timeout fired, processing queue...');
              get().processQueue();
            }, timeUntilExpiry + 1000); // Add 1 second buffer
          } else {
            // Already expired
            console.log('[QueueStore] Already expired, processing immediately');
            get().processQueue();
          }
        }
      } else {
        // No current token document
        console.log('[QueueStore] No current token, checking queue...');
        set({
          currentToken: DEFAULT_TOKEN_MINT,
          currentItem: null,
        });
        
        // If queue has items, process
        const { queue, isProcessing } = get();
        if (queue.length > 0 && !isProcessing) {
          get().processQueue();
        }
      }
    });

    // Periodic refresh every 10 seconds as backup (in case listeners aren't working)
    checkInterval = setInterval(async () => {
      // Always refresh state from Firestore to ensure sync
      await get().refreshState();

      // Re-get state after refresh
      const updatedState = get();

      if (updatedState.currentItem?.expiresAt && updatedState.currentItem.expiresAt <= Date.now() && !updatedState.isProcessing) {
        console.log('[QueueStore] Periodic check: token expired, processing...');
        get().processQueue();
      }

      if (!updatedState.currentItem && updatedState.queue.length > 0 && !updatedState.isProcessing) {
        console.log('[QueueStore] Periodic check: no current item, processing...');
        get().processQueue();
      }
    }, 10000);

    set({ isInitialized: true });

    // Return cleanup function
    return () => {
      console.log('[QueueStore] Cleaning up...');
      unsubQueue();
      unsubCurrent();
      if (processingTimeout) clearTimeout(processingTimeout);
      if (checkInterval) clearInterval(checkInterval);
    };
  },

  /**
   * Add a new token to the queue via server API
   * Returns the API result including whether the token was processed immediately
   */
  addToQueue: async (tokenMint, walletAddress, amount, signature) => {
    const userId = getCurrentUserId();

    const response = await fetch(withAppBasePath('/api/queue/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenMint,
        walletAddress,
        amount,
        signature,
        userId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to add to queue');
    }

    console.log('[QueueStore] Added to queue:', result);

    // If the server activated the token immediately, update UI from the API payload
    // (helps when Firestore listeners are slow/misconfigured during demo deploys).
    const pr = (result as { processResult?: unknown } | null)?.processResult;
    const processedImmediately = !!(result as { processedImmediately?: unknown } | null)?.processedImmediately;
    const applyProcessResult = (processResult: unknown) => {
      if (!processResult || typeof processResult !== 'object') return false;
      const r = processResult as { processed?: boolean; action?: string; tokenMint?: string; expiresAt?: string; queueItemId?: string; walletAddress?: string; isPriority?: boolean; priorityLevel?: number; displayDuration?: number };
      if (!r.processed) return false;

      if (r.action === 'reset_to_default' && r.tokenMint) {
        set({ currentToken: r.tokenMint, currentItem: null });
        return true;
      }

      if (r.action === 'next_item' && r.tokenMint) {
        const expiresAt = r.expiresAt ? new Date(r.expiresAt).getTime() : 0;
        set({
          currentToken: r.tokenMint,
          currentItem: {
            id: r.queueItemId || r.tokenMint,
            tokenMint: r.tokenMint,
            walletAddress: r.walletAddress || '',
            expiresAt,
            isPriority: !!(r.isPriority || (r.priorityLevel || 0) > 0),
            priorityLevel: r.priorityLevel || 0,
            displayDuration: r.displayDuration || 600000,
            addedAt: Date.now(),
          },
        });
        return true;
      }

      return false;
    };

    const applied = processedImmediately ? applyProcessResult(pr) : false;

    if (!applied) {
      // Best-effort: try to advance queue right away (no-op if current token is still active).
      await get().processQueue();
      // Then sync from Firestore (if available) for queue list + any missed fields.
      await get().refreshState();
    } else {
      // Don't immediately refresh; Firestore reads can be stale for a moment and overwrite the correct token.
      if (typeof window !== 'undefined') {
        setTimeout(() => {
          get().refreshState();
        }, 2000);
      }
    }

    return result;
  },

  /**
   * Manually refresh state from Firestore (fallback if listeners aren't working)
   */
  refreshState: async () => {
    console.log('[QueueStore] Refreshing state from Firestore...');
    try {
      // Prefer server-side state when client Firestore permissions are locked down.
      // This keeps the demo functional even if Firestore rules are restrictive.
      try {
        const res = await fetch(withAppBasePath('/api/state'), { method: 'GET' });
        if (res.ok) {
          const data = await res.json() as {
            currentToken: null | {
              tokenMint: string | null;
              queueItemId: string | null;
              expiresAt: number;
              isPriority: boolean;
              priorityLevel: number;
              displayDuration: number;
              walletAddress: string | null;
            };
            queue: Array<{
              id: string;
              tokenMint: string;
              walletAddress: string;
              expiresAt: number;
              isPriority: boolean;
              priorityLevel: number;
              displayDuration: number;
              addedAt: number;
            }>;
          };

          if (Array.isArray(data.queue)) {
            set({ queue: data.queue });
          }

          if (data.currentToken && data.currentToken.tokenMint) {
            set({
              currentToken: data.currentToken.tokenMint,
              currentItem: data.currentToken.queueItemId ? {
                id: data.currentToken.queueItemId,
                tokenMint: data.currentToken.tokenMint,
                walletAddress: data.currentToken.walletAddress || '',
                expiresAt: data.currentToken.expiresAt || 0,
                isPriority: !!data.currentToken.isPriority,
                priorityLevel: data.currentToken.priorityLevel || 0,
                displayDuration: data.currentToken.displayDuration || 600000,
                addedAt: 0,
              } : null,
            });
          }

          // If server says no current token doc, fall through to client default handling.
          if (data.currentToken === null) {
            set({ currentToken: DEFAULT_TOKEN_MINT, currentItem: null });
          }

          return;
        }
      } catch (e) {
        console.warn('[QueueStore] /api/state failed, falling back to client Firestore:', e);
      }

      const [queueItems, currentToken] = await Promise.all([
        getQueueDB(),
        getCurrentTokenDB(),
      ]);

      // Helper to safely get milliseconds from timestamp
      const getMs = (ts: unknown): number => {
        if (!ts) return 0;
        if (typeof ts === 'object' && ts !== null && 'toMillis' in ts && typeof (ts as { toMillis?: unknown }).toMillis === 'function') {
          return (ts as { toMillis: () => number }).toMillis();
        }
        if (ts instanceof Date) return ts.getTime();
        if (typeof ts === 'object' && ts !== null && 'seconds' in ts) {
          const timestampLike = ts as { seconds: number; nanoseconds?: number };
          return timestampLike.seconds * 1000 + Math.floor((timestampLike.nanoseconds || 0) / 1000000);
        }
        if (typeof ts === 'number') return ts;
        if (typeof ts === 'string') return new Date(ts).getTime() || 0;
        return 0;
      };

      const queue = queueItems.map(item => ({
        id: item.id,
        tokenMint: item.tokenMint,
        walletAddress: item.walletAddress,
        expiresAt: getMs(item.expiresAt),
        isPriority: item.isPriority,
        priorityLevel: item.priorityLevel || 0,
        displayDuration: item.displayDuration || 600000,
        addedAt: getMs(item.addedAt),
      }));

      console.log('[QueueStore] Refreshed queue:', queue.length, 'items', queue);
      console.log('[QueueStore] Refreshed currentToken:', currentToken?.tokenMint, currentToken);

      set({ queue });

      if (currentToken) {
        const expiresAt = getMs(currentToken.expiresAt);
        set({
          currentToken: currentToken.tokenMint,
          currentItem: currentToken.queueItemId ? {
            id: currentToken.queueItemId,
            tokenMint: currentToken.tokenMint,
            walletAddress: currentToken.walletAddress || '',
            expiresAt: expiresAt,
            isPriority: currentToken.isPriority,
            priorityLevel: currentToken.priorityLevel || 0,
            displayDuration: currentToken.displayDuration || 600000,
            addedAt: 0,
          } : null,
        });
      } else {
        set({
          currentToken: DEFAULT_TOKEN_MINT,
          currentItem: null,
        });
      }
    } catch (error) {
      console.error('[QueueStore] Error refreshing state:', error);
    }
  },

  /**
   * Process the next item in queue via SERVER API
   */
  processQueue: async () => {
    const { isProcessing } = get();

    // Check for stuck processing flag (auto-reset after timeout)
    if (isProcessing) {
      const timeSinceStart = Date.now() - processingStartTime;
      if (timeSinceStart < PROCESSING_TIMEOUT_MS) {
        console.log('[QueueStore] Already processing, skipping');
        return;
      }
      console.log('[QueueStore] Processing flag stuck, resetting...');
    }

    // Set flag BEFORE any async work to prevent race conditions
    processingStartTime = Date.now();
    set({ isProcessing: true });
    console.log('[QueueStore] Processing queue...');

    try {
      const response = await fetch(withAppBasePath('/api/queue/process'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await response.json();
      console.log('[QueueStore] Process result:', result);

      if (!response.ok) {
        console.error('[QueueStore] Process error:', result.error);
        // Only refresh on error to try to recover
        await get().refreshState();
      } else if (result.processed) {
        // Force update state immediately from API result (don't wait for Firestore listener)
        // DO NOT call refreshState() here - it might read stale data and overwrite correct state
        if (result.action === 'reset_to_default') {
          console.log('[QueueStore] Resetting to default token');
          set({
            currentToken: result.tokenMint,
            currentItem: null,
          });
        } else if (result.action === 'next_item') {
          console.log('[QueueStore] Moving to next item:', result.tokenMint);
          // Force update state immediately with proper data from API
          const expiresAt = result.expiresAt ? new Date(result.expiresAt).getTime() : 0;
          set({
            currentToken: result.tokenMint,
            currentItem: {
              id: result.queueItemId || result.tokenMint,
              tokenMint: result.tokenMint,
              walletAddress: result.walletAddress || '',
              expiresAt: expiresAt,
              isPriority: result.isPriority || result.priorityLevel > 0,
              priorityLevel: result.priorityLevel || 0,
              displayDuration: result.displayDuration || 600000,
              addedAt: Date.now(),
            },
          });
        }
        // Don't refresh - trust the API result, Firestore listener will sync eventually
      } else {
        // Not processed (token not expired yet) - refresh to ensure sync
        await get().refreshState();
      }
    } catch (error) {
      console.error('[QueueStore] Error processing queue:', error);
      // Still try to refresh on error to stay in sync
      await get().refreshState();
    } finally {
      set({ isProcessing: false });
    }
  },

  /**
   * Priority takeover via server API
   */
  removeCurrentAndAddPriority: async (tokenMint, walletAddress, signature) => {
    const userId = getCurrentUserId();

    const response = await fetch(withAppBasePath('/api/queue/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenMint,
        walletAddress,
        amount: 0.069, // PRIORITY_BASIC amount
        signature,
        userId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to set priority token');
    }
    
    console.log('[QueueStore] Priority set:', result);
  },
}));
