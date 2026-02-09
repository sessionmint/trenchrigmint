import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

// ============================================
// FIREBASE ADMIN INITIALIZATION
// ============================================

let adminApp: App;
let adminDb: Firestore;

function getAdminApp(): App {
  if (getApps().length === 0) {
    // Build service account from individual environment variables
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

    if (privateKey && clientEmail && projectId) {
      // Replace escaped newlines with actual newlines in private key
      const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');

      adminApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: formattedPrivateKey,
        }),
        projectId,
      });
    } else {
      // Fallback: Initialize with project ID only (works in some Firebase environments like Cloud Functions)
      console.warn('[Firebase Admin] Missing credentials, initializing with project ID only');
      adminApp = initializeApp({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });
    }
  } else {
    adminApp = getApps()[0];
  }
  return adminApp;
}

function getAdminDb(): Firestore {
  if (!adminDb) {
    adminDb = getFirestore(getAdminApp());
  }
  return adminDb;
}

// ============================================
// TYPES
// ============================================

export interface QueueItemAdmin {
  id: string;
  tokenMint: string;
  walletAddress: string;
  expiresAt: Timestamp | null;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  addedAt: Timestamp | FieldValue;
  position: number;
  transactionSignature: string;
  userId: string | null;
}

export interface TransactionLogAdmin {
  id: string;
  tokenMint: string;
  walletAddress: string;
  amount: number;
  type: 'standard' | 'priority';
  signature: string;
  timestamp: Timestamp | FieldValue;
  userId: string | null;
  verified: boolean;
}

// ============================================
// COLLECTION REFERENCES
// ============================================

const QUEUE_COLLECTION = 'queue';
const TRANSACTIONS_COLLECTION = 'transactions';
const CURRENT_TOKEN_DOC = 'settings/currentToken';

// ============================================
// QUEUE FUNCTIONS (ADMIN)
// ============================================

/**
 * Add a new item to the queue (server-side only)
 * Inserts items according to priority level:
 * - Priority 3 (1.0 SOL): Top of queue
 * - Priority 2 (0.5 SOL): After all priority 3, before priority 1
 * - Priority 1 (0.069 SOL): After all priority 2-3, before priority 0
 * - Priority 0 (0.01 SOL): End of queue
 */
export async function addToQueueAdmin(
  tokenMint: string,
  walletAddress: string,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  transactionSignature: string,
  userId: string | null
): Promise<string> {
  const db = getAdminDb();
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Get all queue items sorted by current position
  const queueSnapshot = await db.collection(QUEUE_COLLECTION)
    .orderBy('position', 'asc')
    .get();

  const queueItems = queueSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as QueueItemAdmin[];

  // Find insertion position based on priority level
  let insertPosition = queueItems.length; // Default to end
  
  if (isPriority) {
    // Find the first item with lower priority
    for (let i = 0; i < queueItems.length; i++) {
      const item = queueItems[i];
      const itemPriority = item.priorityLevel || 0;
      
      if (itemPriority < priorityLevel) {
        insertPosition = i;
        break;
      }
    }
  }

  // Update positions for items after insertion point
  const batch = db.batch();
  for (let i = insertPosition; i < queueItems.length; i++) {
    const item = queueItems[i];
    batch.update(db.collection(QUEUE_COLLECTION).doc(item.id), {
      position: i + 1
    });
  }

  // Create the new queue item
  const queueItem: QueueItemAdmin = {
    id,
    tokenMint,
    walletAddress,
    expiresAt: null,
    isPriority,
    priorityLevel,
    displayDuration,
    addedAt: FieldValue.serverTimestamp(),
    position: insertPosition,
    transactionSignature,
    userId,
  };

  batch.set(db.collection(QUEUE_COLLECTION).doc(id), queueItem);
  await batch.commit();

  return id;
}

/**
 * Set the current token being displayed (for priority takeover)
 */
export async function setCurrentTokenAdmin(
  tokenMint: string,
  queueItemId: string | null,
  expiresAt: Date | null,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  walletAddress: string | null
): Promise<void> {
  const db = getAdminDb();

  await db.doc(CURRENT_TOKEN_DOC).set({
    tokenMint,
    queueItemId,
    expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
    isPriority,
    priorityLevel,
    displayDuration,
    walletAddress,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Log a verified transaction (server-side only)
 */
export async function logTransactionAdmin(
  tokenMint: string,
  walletAddress: string,
  amount: number,
  type: 'standard' | 'priority',
  signature: string,
  userId: string | null,
  verified: boolean
): Promise<void> {
  const db = getAdminDb();
  const id = `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const transaction: TransactionLogAdmin = {
    id,
    tokenMint,
    walletAddress,
    amount,
    type,
    signature,
    timestamp: FieldValue.serverTimestamp(),
    userId,
    verified,
  };

  await db.collection(TRANSACTIONS_COLLECTION).doc(id).set(transaction);
}

/**
 * Check if a transaction signature has already been used
 */
export async function isSignatureUsed(signature: string): Promise<boolean> {
  const db = getAdminDb();
  const snapshot = await db
    .collection(TRANSACTIONS_COLLECTION)
    .where('signature', '==', signature)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * Check if a token address was recently used (within cooldown period)
 * Returns the time remaining in milliseconds, or 0 if not in cooldown
 */
export async function checkDuplicateCooldown(
  tokenMint: string,
  cooldownMs: number
): Promise<{ inCooldown: boolean; remainingMs: number; lastUsedAt: Date | null }> {
  const db = getAdminDb();
  const cutoffTime = Timestamp.fromMillis(Date.now() - cooldownMs);

  // Check current token and recent queue items
  const [currentTokenDoc, recentQueueSnapshot] = await Promise.all([
    db.doc(CURRENT_TOKEN_DOC).get(),
    db.collection(QUEUE_COLLECTION)
      .where('tokenMint', '==', tokenMint)
      .where('addedAt', '>', cutoffTime)
      .orderBy('addedAt', 'desc')
      .limit(1)
      .get()
  ]);

  // Check transactions separately (may need index, handle gracefully)
  let recentTxSnapshot: FirebaseFirestore.QuerySnapshot | null = null;
  try {
    recentTxSnapshot = await db.collection(TRANSACTIONS_COLLECTION)
      .where('tokenMint', '==', tokenMint)
      .where('verified', '==', true)
      .where('timestamp', '>', cutoffTime)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
  } catch (indexError) {
    console.warn('[Cooldown] Transaction index query failed, falling back:', indexError);
    // Fallback: simpler query without timestamp filter
    try {
      const allTxForToken = await db.collection(TRANSACTIONS_COLLECTION)
        .where('tokenMint', '==', tokenMint)
        .where('verified', '==', true)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (!allTxForToken.empty) {
        const txData = allTxForToken.docs[0].data();
        const txTime = (txData.timestamp as Timestamp)?.toMillis();
        if (txTime && txTime > cutoffTime.toMillis()) {
          recentTxSnapshot = allTxForToken;
        }
      }
    } catch (fallbackError) {
      console.warn('[Cooldown] Fallback query also failed:', fallbackError);
    }
  }

  // Check if currently displaying this token
  const currentData = currentTokenDoc.data();
  if (currentData && currentData.tokenMint === tokenMint && currentData.queueItemId) {
    const expiresAt = currentData.expiresAt as Timestamp | null;
    if (expiresAt && expiresAt.toMillis() > Date.now()) {
      const remainingMs = expiresAt.toMillis() - Date.now();
      return {
        inCooldown: true,
        remainingMs: remainingMs + cooldownMs, // Add cooldown after display ends
        lastUsedAt: new Date()
      };
    }
  }

  // Check recent queue items
  if (!recentQueueSnapshot.empty) {
    const recentItem = recentQueueSnapshot.docs[0].data();
    const addedAt = (recentItem.addedAt as Timestamp).toMillis();
    const timeSinceAdded = Date.now() - addedAt;
    const remainingMs = cooldownMs - timeSinceAdded;

    if (remainingMs > 0) {
      return {
        inCooldown: true,
        remainingMs,
        lastUsedAt: new Date(addedAt)
      };
    }
  }

  // Check recent transactions (covers tokens that were displayed and removed from queue)
  if (recentTxSnapshot && !recentTxSnapshot.empty) {
    const recentTx = recentTxSnapshot.docs[0].data();
    const txTime = (recentTx.timestamp as Timestamp).toMillis();
    const timeSinceTx = Date.now() - txTime;
    const remainingMs = cooldownMs - timeSinceTx;

    if (remainingMs > 0) {
      return {
        inCooldown: true,
        remainingMs,
        lastUsedAt: new Date(txTime)
      };
    }
  }

  return { inCooldown: false, remainingMs: 0, lastUsedAt: null };
}

// ============================================
// DEVICE SESSION FUNCTIONS
// ============================================

const DEVICE_SESSION_DOC = 'settings/deviceSession';

/**
 * Update the current device session/mode info
 */
export async function updateDeviceSession(
  tokenMint: string,
  modeId: number,
  modeName: string,
  speed: number,
  amplitude: number
): Promise<void> {
  const db = getAdminDb();

  await db.doc(DEVICE_SESSION_DOC).set({
    tokenMint,
    modeId,
    modeName,
    speed,
    amplitude,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Get the current device session info
 */
export async function getDeviceSession(): Promise<{
  tokenMint: string;
  modeId: number;
  modeName: string;
  speed: number;
  amplitude: number;
  updatedAt: Date;
} | null> {
  const db = getAdminDb();
  const doc = await db.doc(DEVICE_SESSION_DOC).get();

  if (!doc.exists) return null;

  const data = doc.data();
  if (!data) return null;

  return {
    tokenMint: data.tokenMint,
    modeId: data.modeId,
    modeName: data.modeName,
    speed: data.speed,
    amplitude: data.amplitude,
    updatedAt: data.updatedAt?.toDate() || new Date(),
  };
}

/**
 * Clear the device session (when token expires or resets to default)
 */
export async function clearDeviceSession(): Promise<void> {
  const db = getAdminDb();
  await db.doc(DEVICE_SESSION_DOC).delete();
  console.log('[Firebase] Device session cleared');
}

export { getAdminDb, Timestamp, FieldValue };