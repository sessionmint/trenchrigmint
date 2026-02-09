import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
  writeBatch
} from 'firebase/firestore';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  User
} from 'firebase/auth';

// Firebase configuration from environment variables
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Check if Firebase can be initialized (env vars present and client-side)
const canInitialize = typeof window !== 'undefined' && !!firebaseConfig.apiKey;

// Initialize Firebase only on client-side with valid config
let app: ReturnType<typeof initializeApp> | null = null;
let db: ReturnType<typeof getFirestore> | null = null;
let auth: ReturnType<typeof getAuth> | null = null;

if (canInitialize) {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  db = getFirestore(app);
  auth = getAuth(app);
}

// Helper to ensure db is available
function getDb() {
  if (!db) throw new Error('Firebase not initialized');
  return db;
}

// Helper to ensure auth is available
function getAuthInstance() {
  if (!auth) throw new Error('Firebase Auth not initialized');
  return auth;
}

// ============================================
// ANONYMOUS AUTH FUNCTIONS
// ============================================

let currentUser: User | null = null;

/**
 * Sign in anonymously - creates a unique user ID for tracking
 */
export async function signInAnonymousUser(): Promise<User | null> {
  try {
    const authInstance = getAuthInstance();
    const userCredential = await signInAnonymously(authInstance);
    currentUser = userCredential.user;
    return currentUser;
  } catch (error) {
    console.error('Anonymous sign-in error:', error);
    return null;
  }
}

/**
 * Get current authenticated user
 */
export function getCurrentUser(): User | null {
  return currentUser || auth?.currentUser || null;
}

/**
 * Get current user ID (anonymous UID)
 */
export function getCurrentUserId(): string | null {
  const user = getCurrentUser();
  return user?.uid || null;
}

/**
 * Subscribe to auth state changes
 */
export function subscribeToAuthState(callback: (user: User | null) => void): () => void {
  const authInstance = getAuthInstance();
  return onAuthStateChanged(authInstance, (user) => {
    currentUser = user;
    callback(user);
  });
}

/**
 * Initialize anonymous auth on app load
 */
export async function initializeAuth(): Promise<User | null> {
  // Check if already signed in
  if (auth?.currentUser) {
    currentUser = auth.currentUser;
    return currentUser;
  }

  // Sign in anonymously
  return signInAnonymousUser();
}

// ============================================
// TYPES
// ============================================

export interface QueueItemDB {
  id: string;
  tokenMint: string;
  walletAddress: string;
  expiresAt: Timestamp | null;
  isPriority: boolean;
  priorityLevel: number;  // 0 = none, 1 = basic (0.069), 2 = duplicate (0.5), 3 = premium (1.0)
  displayDuration: number; // milliseconds - 10 min or 1 hour
  addedAt: Timestamp;
  position: number;
  signature: string;
}

export interface CurrentTokenDB {
  tokenMint: string;
  queueItemId: string | null;
  expiresAt: Timestamp | null;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  walletAddress: string | null;
  updatedAt: Timestamp;
}

// ============================================
// COLLECTION REFERENCES
// ============================================

const QUEUE_COLLECTION = 'queue';
const CURRENT_TOKEN_DOC = 'settings/currentToken';

// ============================================
// QUEUE FUNCTIONS
// ============================================

/**
 * Add a new item to the queue
 */
export async function addToQueueDB(
  tokenMint: string, 
  walletAddress: string, 
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  signature: string
): Promise<string> {
  const database = getDb();
  const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Get current queue length for position
  const queueSnapshot = await getDocs(collection(database, QUEUE_COLLECTION));
  const position = queueSnapshot.size;

  const queueItem: Omit<QueueItemDB, 'addedAt'> & { addedAt: ReturnType<typeof serverTimestamp> } = {
    id,
    tokenMint,
    walletAddress,
    expiresAt: null,
    isPriority,
    priorityLevel,
    displayDuration,
    addedAt: serverTimestamp(),
    position,
    signature,
  };

  await setDoc(doc(database, QUEUE_COLLECTION, id), queueItem);
  return id;
}

/**
 * Get all queue items ordered by position
 */
export async function getQueueDB(): Promise<QueueItemDB[]> {
  const database = getDb();
  const q = query(collection(database, QUEUE_COLLECTION), orderBy('position', 'asc'));
  const snapshot = await getDocs(q);
  console.log('[Firebase] getQueueDB: fetched', snapshot.docs.length, 'items');
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as QueueItemDB));
}

/**
 * Remove an item from the queue
 */
export async function removeFromQueueDB(id: string): Promise<void> {
  const database = getDb();
  await deleteDoc(doc(database, QUEUE_COLLECTION, id));
}

/**
 * Clear all items from queue
 */
export async function clearQueueDB(): Promise<void> {
  const database = getDb();
  const snapshot = await getDocs(collection(database, QUEUE_COLLECTION));
  const batch = writeBatch(database);
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

// ============================================
// CURRENT TOKEN FUNCTIONS
// ============================================

/**
 * Get the current token being displayed
 */
export async function getCurrentTokenDB(): Promise<CurrentTokenDB | null> {
  const database = getDb();
  const docSnap = await getDoc(doc(database, CURRENT_TOKEN_DOC));
  if (docSnap.exists()) {
    const data = docSnap.data() as CurrentTokenDB;
    console.log('[Firebase] getCurrentTokenDB:', data.tokenMint);
    return data;
  }
  console.log('[Firebase] getCurrentTokenDB: document does not exist');
  return null;
}

/**
 * Set the current token being displayed
 */
export async function setCurrentTokenDB(
  tokenMint: string,
  queueItemId: string | null,
  expiresAt: Date | null,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  walletAddress: string | null
): Promise<void> {
  const database = getDb();
  const data: Omit<CurrentTokenDB, 'updatedAt'> & { updatedAt: ReturnType<typeof serverTimestamp> } = {
    tokenMint,
    queueItemId,
    expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
    isPriority,
    priorityLevel,
    displayDuration,
    walletAddress,
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(database, CURRENT_TOKEN_DOC), data);
}

/**
 * Reset to default token
 */
export async function resetToDefaultTokenDB(defaultToken: string): Promise<void> {
  await setCurrentTokenDB(defaultToken, null, null, false, 0, 0, null);
}

// ============================================
// REAL-TIME LISTENERS
// ============================================

/**
 * Subscribe to queue changes
 */
export function subscribeToQueue(
  callback: (queue: QueueItemDB[]) => void
): () => void {
  const database = getDb();
  const q = query(collection(database, QUEUE_COLLECTION), orderBy('position', 'asc'));

  console.log('[Firebase] Setting up queue listener...');

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const queue = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as QueueItemDB));
      console.log('[Firebase] Queue snapshot received:', queue.length, 'items');
      callback(queue);
    },
    (error) => {
      console.error('[Firebase] Queue listener error:', error);
    }
  );

  return unsubscribe;
}

/**
 * Subscribe to current token changes
 */
export function subscribeToCurrentToken(
  callback: (current: CurrentTokenDB | null) => void
): () => void {
  const database = getDb();

  console.log('[Firebase] Setting up currentToken listener...');

  const unsubscribe = onSnapshot(
    doc(database, CURRENT_TOKEN_DOC),
    (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as CurrentTokenDB;
        console.log('[Firebase] CurrentToken snapshot received:', data.tokenMint);
        callback(data);
      } else {
        console.log('[Firebase] CurrentToken document does not exist');
        callback(null);
      }
    },
    (error) => {
      console.error('[Firebase] CurrentToken listener error:', error);
    }
  );

  return unsubscribe;
}

// ============================================
// TRANSACTION LOGGING (OPTIONAL)
// ============================================

export interface TransactionLogDB {
  id: string;
  tokenMint: string;
  walletAddress: string;
  amount: number;
  type: 'standard' | 'priority';
  signature: string;
  timestamp: Timestamp;
}

/**
 * Log a successful payment transaction
 */
export async function logTransactionDB(
  tokenMint: string,
  walletAddress: string,
  amount: number,
  type: 'standard' | 'priority',
  signature: string
): Promise<void> {
  const database = getDb();
  const id = `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  await setDoc(doc(database, 'transactions', id), {
    id,
    tokenMint,
    walletAddress,
    amount,
    type,
    signature,
    timestamp: serverTimestamp(),
  });
}

export { db, auth };
