import { createClient, type RedisClientType } from 'redis';
import { list, put } from '@vercel/blob';
import { getAdminDb, FieldValue, Timestamp } from '@/lib/firebase-admin';
import { DEFAULT_TOKEN_MINT } from '@/lib/constants';

type QueueDriver = 'redis' | 'kv' | 'firestore' | 'blob';

const DRIVER: QueueDriver = (
  process.env.QUEUE_DRIVER ||
  process.env.NEXT_PUBLIC_QUEUE_DRIVER ||
  ''
).toLowerCase() as QueueDriver || 'firestore';

const REDIS_URL =
  process.env.REDIS_URL ||
  process.env.KV_URL || // Vercel KV / Upstash redis url
  process.env.UPSTASH_REDIS_URL ||
  '';

const REDIS_PREFIX = process.env.REDIS_QUEUE_PREFIX || process.env.REDIS_PREFIX || 'trenchrig:queue';
const QUEUE_KEY = `${REDIS_PREFIX}:items`;
const CURRENT_KEY = `${REDIS_PREFIX}:current`;
const SIGNATURE_SET_KEY = `${REDIS_PREFIX}:signatures`;
const TRANSACTION_LOG_KEY = `${REDIS_PREFIX}:txlog`;

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_PREFIX = process.env.BLOB_QUEUE_PREFIX || 'queue';
const BLOB_QUEUE_FILE = `${BLOB_PREFIX}/queue.json`;
const BLOB_CURRENT_FILE = `${BLOB_PREFIX}/current.json`;
const BLOB_SIGNATURE_FILE = `${BLOB_PREFIX}/signatures.json`;
const BLOB_TXLOG_FILE = `${BLOB_PREFIX}/txlog.json`;

// Typed loosely to avoid TS conflicts with multiple redis client instances in build environments.
let redisClient: RedisClientType | null | any = null;
let redisInitPromise: Promise<RedisClientType | null> | null | any = null;
let loggedNoRedisConfig = false;
let loggedRedisError = false;

export interface QueueItemRecord {
  id: string;
  tokenMint: string;
  walletAddress: string;
  expiresAt: Timestamp | null | number;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  addedAt: Timestamp | number | null;
  position: number;
  signature: string;
  userId: string | null;
}

export interface CurrentTokenRecord {
  tokenMint: string;
  queueItemId: string | null;
  expiresAt: Timestamp | null | number;
  isPriority: boolean;
  priorityLevel: number;
  displayDuration: number;
  walletAddress: string | null;
}

const isRedisDriver = DRIVER === 'redis' || DRIVER === 'kv';
const isBlobDriver = DRIVER === 'blob';

async function getRedis(): Promise<RedisClientType | null> {
  if (!isRedisDriver) return null;
  if (!REDIS_URL) {
    if (!loggedNoRedisConfig) {
      loggedNoRedisConfig = true;
      console.warn('[QueueDriver] REDIS_URL/KV_URL not set, staying on Firestore');
    }
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (!redisInitPromise) {
    redisInitPromise = (async () => {
      try {
        const client = createClient({
          url: REDIS_URL,
          socket: {
            connectTimeout: 5000,
            reconnectStrategy: (retries) => Math.min(500 * retries, 2000),
          },
        });

        client.on('error', (err) => {
          if (!loggedRedisError) {
            loggedRedisError = true;
            console.error('[QueueDriver] Redis runtime error, falling back to Firestore:', err);
          }
        });

        await client.connect();
        await client.ping();
        redisClient = client as unknown as RedisClientType;
        loggedRedisError = false;
        console.log('[QueueDriver] Redis connected');
        return redisClient;
      } catch (error) {
        if (!loggedRedisError) {
          loggedRedisError = true;
          console.error('[QueueDriver] Redis unavailable, falling back to Firestore:', error);
        }
        redisClient = null;
        return null;
      } finally {
        redisInitPromise = null;
      }
    })();
  }

  return redisInitPromise as Promise<RedisClientType | null>;
}

function redisScore(priorityLevel: number): number {
  // Higher priority first (smaller score), then FIFO inside priority level.
  return -(priorityLevel * 1_000_000_000_000) + Date.now();
}

function parseQueueItem(raw: string, index: number): QueueItemRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as QueueItemRecord;
    if (!parsed?.id) return undefined;
    return { ...parsed, position: index };
  } catch {
    return undefined;
  }
}

// ========================
// REDIS IMPLEMENTATION
// ========================

async function redisAddToQueue(item: Omit<QueueItemRecord, 'position' | 'addedAt' | 'expiresAt'>): Promise<string> {
  const client = await getRedis();
  if (!client) throw new Error('Redis unavailable');

  const id = item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const payload: QueueItemRecord = {
    ...item,
    id,
    expiresAt: null,
    addedAt: Date.now(),
    position: 0,
  };

  await client.zAdd(QUEUE_KEY, { score: redisScore(item.priorityLevel), value: JSON.stringify(payload) });
  return id;
}

async function redisListQueue(limit = 200): Promise<QueueItemRecord[]> {
  const client = await getRedis();
  if (!client) return [];

  const rows = await client.zRange(QUEUE_KEY, 0, limit - 1);
  const items: QueueItemRecord[] = [];
  rows.forEach((row, idx) => {
    const parsed = parseQueueItem(row, idx);
    if (parsed) items.push(parsed);
  });
  return items;
}

async function redisPopNext(): Promise<QueueItemRecord | null> {
  const client = await getRedis();
  if (!client) return null;

  const popped = await client.zPopMin(QUEUE_KEY, 1);
  if (!popped || popped.length === 0) return null;
  const parsed = parseQueueItem(popped[0].value, 0);
  return parsed || null;
}

async function redisSetCurrentToken(data: CurrentTokenRecord): Promise<void> {
  const client = await getRedis();
  if (!client) throw new Error('Redis unavailable');
  await client.set(CURRENT_KEY, JSON.stringify(data));
}

async function redisGetCurrentToken(): Promise<CurrentTokenRecord | null> {
  const client = await getRedis();
  if (!client) return null;
  const raw = await client.get(CURRENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentTokenRecord;
  } catch {
    await client.del(CURRENT_KEY);
    return null;
  }
}

async function redisResetToDefault(defaultToken: string): Promise<void> {
  const client = await getRedis();
  if (!client) throw new Error('Redis unavailable');
  const payload: CurrentTokenRecord = {
    tokenMint: defaultToken,
    queueItemId: null,
    expiresAt: null,
    isPriority: false,
    priorityLevel: 0,
    displayDuration: 0,
    walletAddress: null,
  };
  await client.set(CURRENT_KEY, JSON.stringify(payload));
}

async function redisLogTransaction(
  tokenMint: string,
  walletAddress: string,
  amount: number,
  type: 'standard' | 'priority',
  signature: string,
  userId: string | null,
  verified: boolean
): Promise<void> {
  const client = await getRedis();
  if (!client) throw new Error('Redis unavailable');
  const entry = {
    tokenMint,
    walletAddress,
    amount,
    type,
    signature,
    userId,
    verified,
    ts: Date.now(),
  };
  await client.multi()
    .lPush(TRANSACTION_LOG_KEY, JSON.stringify(entry))
    .sAdd(SIGNATURE_SET_KEY, signature)
    .exec();
  await client.lTrim(TRANSACTION_LOG_KEY, 0, 499); // keep last 500
}

async function redisIsSignatureUsed(signature: string): Promise<boolean> {
  const client = await getRedis();
  if (!client) return false;
  const exists = await client.sIsMember(SIGNATURE_SET_KEY, signature);
  return !!exists;
}

// ========================
// BLOB IMPLEMENTATION
// ========================

async function blobFetchJSON<T>(pathname: string, fallback: T): Promise<T> {
  if (!BLOB_TOKEN) {
    console.warn('[QueueDriver] BLOB_READ_WRITE_TOKEN not set, blob driver cannot read');
    return fallback;
  }
  try {
    const existing = await list({ token: BLOB_TOKEN, prefix: pathname, limit: 1 });
    const match = existing.blobs.find(b => b.pathname === pathname);
    if (!match) return fallback;
    const res = await fetch(match.downloadUrl, { cache: 'no-store' });
    if (!res.ok) return fallback;
    const data = (await res.json()) as T;
    return data;
  } catch (error) {
    console.error('[QueueDriver] Blob fetch failed', error);
    return fallback;
  }
}

async function blobWriteJSON(pathname: string, data: unknown): Promise<void> {
  if (!BLOB_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN not set');
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    token: BLOB_TOKEN,
    allowOverwrite: true,
  });
}

async function blobAddToQueue(
  tokenMint: string,
  walletAddress: string,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  transactionSignature: string,
  userId: string | null
): Promise<string> {
  const queue = await blobFetchJSON<QueueItemRecord[]>(BLOB_QUEUE_FILE, []);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Determine insert position by priority
  let insertPosition = queue.length;
  if (isPriority) {
    for (let i = 0; i < queue.length; i++) {
      const itemPriority = queue[i].priorityLevel || 0;
      if (itemPriority < priorityLevel) {
        insertPosition = i;
        break;
      }
    }
  }

  const newItem: QueueItemRecord = {
    id,
    tokenMint,
    walletAddress,
    expiresAt: null,
    isPriority,
    priorityLevel,
    displayDuration,
    addedAt: Date.now(),
    position: insertPosition,
    signature: transactionSignature,
    userId,
  };

  const updated = [...queue.slice(0, insertPosition), newItem, ...queue.slice(insertPosition)];
  // Fix positions
  updated.forEach((item, idx) => { item.position = idx; });

  await blobWriteJSON(BLOB_QUEUE_FILE, updated);
  return id;
}

async function blobListQueue(): Promise<QueueItemRecord[]> {
  const queue = await blobFetchJSON<QueueItemRecord[]>(BLOB_QUEUE_FILE, []);
  return queue;
}

async function blobPopNext(): Promise<QueueItemRecord | null> {
  const queue = await blobFetchJSON<QueueItemRecord[]>(BLOB_QUEUE_FILE, []);
  if (queue.length === 0) return null;
  const [next, ...rest] = queue;
  rest.forEach((item, idx) => { item.position = idx; });
  await blobWriteJSON(BLOB_QUEUE_FILE, rest);
  return next;
}

async function blobSetCurrentToken(data: CurrentTokenRecord): Promise<void> {
  await blobWriteJSON(BLOB_CURRENT_FILE, {
    ...data,
    expiresAt: typeof data.expiresAt === 'object' && data.expiresAt !== null && 'toMillis' in data.expiresAt
      ? (data.expiresAt as { toMillis: () => number }).toMillis()
      : data.expiresAt,
  });
}

async function blobGetCurrentToken(): Promise<CurrentTokenRecord | null> {
  const current = await blobFetchJSON<CurrentTokenRecord | null>(BLOB_CURRENT_FILE, null);
  return current;
}

async function blobResetToDefault(defaultToken: string): Promise<void> {
  const payload: CurrentTokenRecord = {
    tokenMint: defaultToken,
    queueItemId: null,
    expiresAt: null,
    isPriority: false,
    priorityLevel: 0,
    displayDuration: 0,
    walletAddress: null,
  };
  await blobWriteJSON(BLOB_CURRENT_FILE, payload);
}

async function blobLogTransaction(
  tokenMint: string,
  walletAddress: string,
  amount: number,
  type: 'standard' | 'priority',
  signature: string,
  userId: string | null,
  verified: boolean
): Promise<void> {
  const txlog = await blobFetchJSON<Array<Record<string, unknown>>>(BLOB_TXLOG_FILE, []);
  txlog.unshift({
    tokenMint,
    walletAddress,
    amount,
    type,
    signature,
    userId,
    verified,
    ts: Date.now(),
  });
  // Keep last 500
  await blobWriteJSON(BLOB_TXLOG_FILE, txlog.slice(0, 500));

  // Track signature reuse
  const signatures = await blobFetchJSON<string[]>(BLOB_SIGNATURE_FILE, []);
  if (!signatures.includes(signature)) {
    signatures.push(signature);
    await blobWriteJSON(BLOB_SIGNATURE_FILE, signatures.slice(-1000));
  }
}

async function blobIsSignatureUsed(signature: string): Promise<boolean> {
  const signatures = await blobFetchJSON<string[]>(BLOB_SIGNATURE_FILE, []);
  return signatures.includes(signature);
}

// ========================
// FIRESTORE IMPLEMENTATION (fallback / default)
// ========================

async function firestoreAddToQueue(
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

  const snapshot = await db.collection('queue').orderBy('position', 'asc').get();
  const queueItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as QueueItemRecord[];

  let insertPosition = queueItems.length;
  if (isPriority) {
    for (let i = 0; i < queueItems.length; i++) {
      const item = queueItems[i];
      const itemPriority = item.priorityLevel || 0;
      if (itemPriority < priorityLevel) {
        insertPosition = i;
        break;
      }
    }
  }

  const batch = db.batch();
  for (let i = insertPosition; i < queueItems.length; i++) {
    const item = queueItems[i];
    batch.update(db.collection('queue').doc(item.id), { position: i + 1 });
  }

  const queueItem: QueueItemRecord = {
    id,
    tokenMint,
    walletAddress,
    expiresAt: null,
    isPriority,
    priorityLevel,
    displayDuration,
    addedAt: FieldValue.serverTimestamp(),
    position: insertPosition,
    signature: transactionSignature,
    userId,
  };

  batch.set(db.collection('queue').doc(id), queueItem);
  await batch.commit();
  return id;
}

async function firestoreListQueue(): Promise<QueueItemRecord[]> {
  const db = getAdminDb();
  const snapshot = await db.collection('queue').orderBy('position', 'asc').get();
  return snapshot.docs.map((doc, idx) => ({ position: idx, ...doc.data(), id: doc.id } as QueueItemRecord));
}

async function firestorePopNext(): Promise<QueueItemRecord | null> {
  const db = getAdminDb();
  const snapshot = await db.collection('queue').orderBy('position', 'asc').limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  const data = { id: doc.id, ...doc.data() } as QueueItemRecord;
  await db.collection('queue').doc(doc.id).delete();
  return data;
}

async function firestoreSetCurrentToken(data: CurrentTokenRecord): Promise<void> {
  const db = getAdminDb();
  await db.doc('settings/currentToken').set({
    ...data,
    expiresAt: data.expiresAt ? Timestamp.fromDate(new Date(typeof data.expiresAt === 'number' ? data.expiresAt : data.expiresAt.toMillis?.() || Date.now())) : null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function firestoreGetCurrentToken(): Promise<CurrentTokenRecord | null> {
  const db = getAdminDb();
  const docSnap = await db.doc('settings/currentToken').get();
  if (!docSnap.exists) return null;
  return docSnap.data() as CurrentTokenRecord;
}

async function firestoreResetToDefault(defaultToken: string): Promise<void> {
  await firestoreSetCurrentToken({
    tokenMint: defaultToken,
    queueItemId: null,
    expiresAt: null,
    isPriority: false,
    priorityLevel: 0,
    displayDuration: 0,
    walletAddress: null,
  });
}

async function firestoreLogTransaction(
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
  await db.collection('transactions').doc(id).set({
    id,
    tokenMint,
    walletAddress,
    amount,
    type,
    signature,
    timestamp: FieldValue.serverTimestamp(),
    userId,
    verified,
  });
}

async function firestoreIsSignatureUsed(signature: string): Promise<boolean> {
  const db = getAdminDb();
  const snapshot = await db
    .collection('transactions')
    .where('signature', '==', signature)
    .where('verified', '==', true)
    .limit(1)
    .get();
  return !snapshot.empty;
}

// ========================
// PUBLIC API
// ========================

export function queueDriver(): QueueDriver {
  if (isRedisDriver) return DRIVER === 'kv' ? 'kv' : 'redis';
  if (isBlobDriver) return 'blob';
  return 'firestore';
}

export async function addToQueue(
  tokenMint: string,
  walletAddress: string,
  isPriority: boolean,
  priorityLevel: number,
  displayDuration: number,
  transactionSignature: string,
  userId: string | null
): Promise<string> {
  if (isRedisDriver && await getRedis()) {
    return redisAddToQueue({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      tokenMint,
      walletAddress,
      isPriority,
      priorityLevel,
      displayDuration,
      signature: transactionSignature,
      userId,
      expiresAt: null,
      addedAt: Date.now(),
      position: 0,
    });
  }

  if (isBlobDriver) {
    return blobAddToQueue(tokenMint, walletAddress, isPriority, priorityLevel, displayDuration, transactionSignature, userId);
  }

  return firestoreAddToQueue(tokenMint, walletAddress, isPriority, priorityLevel, displayDuration, transactionSignature, userId);
}

export async function listQueue(limit = 200): Promise<QueueItemRecord[]> {
  if (isRedisDriver && await getRedis()) {
    return redisListQueue(limit);
  }
  if (isBlobDriver) {
    const queue = await blobListQueue();
    return queue.slice(0, limit);
  }
  return firestoreListQueue();
}

export async function popNextQueueItem(): Promise<QueueItemRecord | null> {
  if (isRedisDriver && await getRedis()) {
    return redisPopNext();
  }
  if (isBlobDriver) {
    return blobPopNext();
  }
  return firestorePopNext();
}

export async function setCurrentToken(data: CurrentTokenRecord): Promise<void> {
  if (isRedisDriver && await getRedis()) {
    return redisSetCurrentToken(data);
  }
  if (isBlobDriver) {
    return blobSetCurrentToken(data);
  }
  return firestoreSetCurrentToken(data);
}

export async function getCurrentToken(): Promise<CurrentTokenRecord | null> {
  if (isRedisDriver && await getRedis()) {
    return redisGetCurrentToken();
  }
  if (isBlobDriver) {
    return blobGetCurrentToken();
  }
  return firestoreGetCurrentToken();
}

export async function resetToDefaultToken(defaultToken: string = DEFAULT_TOKEN_MINT): Promise<void> {
  if (isRedisDriver && await getRedis()) {
    return redisResetToDefault(defaultToken);
  }
  if (isBlobDriver) {
    return blobResetToDefault(defaultToken);
  }
  return firestoreResetToDefault(defaultToken);
}

export async function logTransaction(
  tokenMint: string,
  walletAddress: string,
  amount: number,
  type: 'standard' | 'priority',
  signature: string,
  userId: string | null,
  verified: boolean
): Promise<void> {
  if (isRedisDriver && await getRedis()) {
    return redisLogTransaction(tokenMint, walletAddress, amount, type, signature, userId, verified);
  }
  if (isBlobDriver) {
    return blobLogTransaction(tokenMint, walletAddress, amount, type, signature, userId, verified);
  }
  return firestoreLogTransaction(tokenMint, walletAddress, amount, type, signature, userId, verified);
}

export async function isSignatureUsed(signature: string): Promise<boolean> {
  if (isRedisDriver && await getRedis()) {
    return redisIsSignatureUsed(signature);
  }
  if (isBlobDriver) {
    return blobIsSignatureUsed(signature);
  }
  return firestoreIsSignatureUsed(signature);
}

export async function clearQueue(): Promise<void> {
  if (isRedisDriver && await getRedis()) {
    const client = await getRedis();
    if (client) {
      await client.del(QUEUE_KEY);
    }
    return;
  }
  if (isBlobDriver) {
    await blobWriteJSON(BLOB_QUEUE_FILE, []);
    return;
  }
  const db = getAdminDb();
  const snapshot = await db.collection('queue').get();
  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

export async function queueLength(): Promise<number> {
  if (isRedisDriver && await getRedis()) {
    const client = await getRedis();
    if (!client) return 0;
    return client.zCard(QUEUE_KEY);
  }
  if (isBlobDriver) {
    const queue = await blobListQueue();
    return queue.length;
  }
  const db = getAdminDb();
  const snapshot = await db.collection('queue').count().get();
  return snapshot.data().count || 0;
}
