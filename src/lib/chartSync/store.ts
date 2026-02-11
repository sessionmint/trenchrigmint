import { createClient, type RedisClientType } from 'redis';
import { getAdminDb, FieldValue } from '@/lib/firebase-admin';
import type { ChartSyncSession } from './types';

const REDIS_URL = process.env.REDIS_URL || '';
function autoRedisPrefix(): string {
  const explicit = (process.env.REDIS_PREFIX || '').trim();
  if (explicit) return explicit;

  const vercelProject =
    (process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  const firebaseProject =
    (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '').trim();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || '').trim();
  const envName = (process.env.VERCEL_ENV || process.env.NODE_ENV || 'development').trim();

  const rawProject = vercelProject || firebaseProject || appUrl || 'sessionmint';
  const project = rawProject
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sessionmint';

  const env = envName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'development';

  return `${project}:${env}:chartsync`;
}

const REDIS_PREFIX = autoRedisPrefix();
const REDIS_INDEX_KEY = `${REDIS_PREFIX}:session_ids`;
const REDIS_SESSION_KEY = (sessionId: string) => `${REDIS_PREFIX}:session:${sessionId}`;
const FIRESTORE_COLLECTION = 'chartSyncSessions';
const FALLBACK_INDEX_WINDOW = 200;

let redisClient: RedisClientType | null = null;
let redisInitPromise: Promise<RedisClientType | null> | null = null;
let loggedNoRedisConfig = false;
let loggedRedisError = false;

function sessionTtlSeconds(session: ChartSyncSession): number {
  const remaining = Math.ceil((session.endTime - Date.now()) / 1000);
  return Math.max(300, remaining + 3600);
}

function parseSession(raw: string): ChartSyncSession | undefined {
  try {
    const parsed = JSON.parse(raw) as ChartSyncSession;
    if (!parsed?.sessionId || !parsed?.tokenMint) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function getRedisClient(): Promise<RedisClientType | null> {
  if (!REDIS_URL) {
    if (!loggedNoRedisConfig) {
      loggedNoRedisConfig = true;
      console.warn('[ChartSyncStore] REDIS_URL not set, using Firestore fallback only');
    }
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (!redisInitPromise) {
    redisInitPromise = (async () => {
      try {
        const client: RedisClientType = createClient({
          url: REDIS_URL,
          socket: {
            connectTimeout: 5000,
            reconnectStrategy: retries => Math.min(retries * 100, 2000),
          },
        });

        client.on('error', (error) => {
          if (!loggedRedisError) {
            loggedRedisError = true;
            console.error('[ChartSyncStore] Redis runtime error, falling back to Firestore:', error);
          }
        });

        await client.connect();
        await client.ping();
        redisClient = client;
        loggedRedisError = false;
        console.log('[ChartSyncStore] Redis connected');
        return client;
      } catch (error) {
        if (!loggedRedisError) {
          loggedRedisError = true;
          console.error('[ChartSyncStore] Redis unavailable, using Firestore fallback:', error);
        }
        redisClient = null;
        return null;
      } finally {
        redisInitPromise = null;
      }
    })();
  }

  return redisInitPromise;
}

async function writeSessionToRedis(session: ChartSyncSession): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const ttl = sessionTtlSeconds(session);
    const payload = JSON.stringify(session);

    await client.multi()
      .set(REDIS_SESSION_KEY(session.sessionId), payload, { EX: ttl })
      .sAdd(REDIS_INDEX_KEY, session.sessionId)
      .expire(REDIS_INDEX_KEY, ttl)
      .exec();

    return true;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to write session to Redis:', error);
    return false;
  }
}

async function writeSessionToFirestore(session: ChartSyncSession): Promise<boolean> {
  try {
    const db = getAdminDb();
    await db.collection(FIRESTORE_COLLECTION).doc(session.sessionId).set({
      ...session,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to write session to Firestore:', error);
    return false;
  }
}

async function mirrorSessionsToFirestore(sessions: ChartSyncSession[]): Promise<number> {
  if (!sessions.length) return 0;
  const results = await Promise.all(sessions.map(writeSessionToFirestore));
  return results.filter(Boolean).length;
}

async function mirrorSessionsToRedis(sessions: ChartSyncSession[]): Promise<number> {
  if (!sessions.length) return 0;
  const results = await Promise.all(sessions.map(writeSessionToRedis));
  return results.filter(Boolean).length;
}

async function readSessionFromRedis(sessionId: string): Promise<ChartSyncSession | undefined> {
  const client = await getRedisClient();
  if (!client) return undefined;

  try {
    const raw = await client.get(REDIS_SESSION_KEY(sessionId));
    if (!raw) return undefined;
    const parsed = parseSession(raw);
    if (!parsed) {
      await client.del(REDIS_SESSION_KEY(sessionId));
      await client.sRem(REDIS_INDEX_KEY, sessionId);
    }
    return parsed;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to read session from Redis:', error);
    return undefined;
  }
}

async function readSessionFromFirestore(sessionId: string): Promise<ChartSyncSession | undefined> {
  try {
    const db = getAdminDb();
    const snapshot = await db.collection(FIRESTORE_COLLECTION).doc(sessionId).get();
    if (!snapshot.exists) return undefined;
    return snapshot.data() as ChartSyncSession | undefined;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to read session from Firestore:', error);
    return undefined;
  }
}

async function listSessionsFromRedis(): Promise<ChartSyncSession[] | undefined> {
  const client = await getRedisClient();
  if (!client) return undefined;

  try {
    const ids = await client.sMembers(REDIS_INDEX_KEY);
    if (ids.length === 0) return [];

    const keys = ids.map(REDIS_SESSION_KEY);
    const rows = await client.mGet(keys);
    const sessions: ChartSyncSession[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const row = rows[i];
      if (!row) {
        staleIds.push(ids[i]);
        continue;
      }
      const parsed = parseSession(row);
      if (!parsed) {
        staleIds.push(ids[i]);
        continue;
      }
      sessions.push(parsed);
    }

    if (staleIds.length > 0) {
      await client.sRem(REDIS_INDEX_KEY, staleIds);
    }

    return sessions;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to list sessions from Redis:', error);
    return undefined;
  }
}

async function listSessionsFromFirestore(): Promise<ChartSyncSession[]> {
  try {
    const db = getAdminDb();
    const snapshot = await db.collection(FIRESTORE_COLLECTION)
      .orderBy('startTime', 'desc')
      .limit(FALLBACK_INDEX_WINDOW)
      .get();

    return snapshot.docs
      .map(doc => doc.data() as ChartSyncSession)
      .filter(session => !!session?.sessionId);
  } catch (error) {
    console.error('[ChartSyncStore] Failed to list sessions from Firestore:', error);
    return [];
  }
}

async function removeSessionFromRedis(sessionId: string): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    await client.multi()
      .del(REDIS_SESSION_KEY(sessionId))
      .sRem(REDIS_INDEX_KEY, sessionId)
      .exec();
    return true;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to remove session from Redis:', error);
    return false;
  }
}

async function removeSessionFromFirestore(sessionId: string): Promise<boolean> {
  try {
    const db = getAdminDb();
    await db.collection(FIRESTORE_COLLECTION).doc(sessionId).delete();
    return true;
  } catch (error) {
    console.error('[ChartSyncStore] Failed to remove session from Firestore:', error);
    return false;
  }
}

export async function saveSession(session: ChartSyncSession): Promise<void> {
  const [redisSaved, firestoreSaved] = await Promise.all([
    writeSessionToRedis(session),
    writeSessionToFirestore(session),
  ]);

  if (!redisSaved && !firestoreSaved) {
    throw new Error('Failed to persist chart sync session to both Redis and Firestore');
  }
}

export async function loadSession(sessionId: string): Promise<ChartSyncSession | undefined> {
  const redisSession = await readSessionFromRedis(sessionId);
  if (redisSession) {
    // Heal Firestore drift when Redis/KV has fresher state.
    await writeSessionToFirestore(redisSession);
    return redisSession;
  }

  const firestoreSession = await readSessionFromFirestore(sessionId);
  if (firestoreSession) {
    await writeSessionToRedis(firestoreSession);
  }
  return firestoreSession;
}

export async function listSessions(): Promise<ChartSyncSession[]> {
  const redisSessions = await listSessionsFromRedis();
  if (redisSessions && redisSessions.length > 0) {
    // Keep Firestore in sync when Redis/KV is the source of truth.
    await mirrorSessionsToFirestore(redisSessions);
    return redisSessions;
  }

  const firestoreSessions = await listSessionsFromFirestore();
  if (firestoreSessions.length > 0) {
    await mirrorSessionsToRedis(firestoreSessions);
  }
  return firestoreSessions;
}

export async function rebalanceChartSyncStores(): Promise<{
  source: 'redis' | 'firestore' | 'none';
  redisCount: number;
  firestoreCount: number;
  mirroredToFirestore: number;
  mirroredToRedis: number;
}> {
  const redisSessions = await listSessionsFromRedis();
  const firestoreSessions = await listSessionsFromFirestore();

  const redisCount = redisSessions?.length || 0;
  const firestoreCount = firestoreSessions.length;

  if (redisSessions && redisSessions.length > 0) {
    const mirroredToFirestore = await mirrorSessionsToFirestore(redisSessions);
    return {
      source: 'redis',
      redisCount,
      firestoreCount,
      mirroredToFirestore,
      mirroredToRedis: 0,
    };
  }

  if (firestoreSessions.length > 0) {
    const mirroredToRedis = await mirrorSessionsToRedis(firestoreSessions);
    return {
      source: 'firestore',
      redisCount,
      firestoreCount,
      mirroredToFirestore: 0,
      mirroredToRedis,
    };
  }

  return {
    source: 'none',
    redisCount: 0,
    firestoreCount: 0,
    mirroredToFirestore: 0,
    mirroredToRedis: 0,
  };
}

export async function removeSession(sessionId: string): Promise<void> {
  const [redisDeleted, firestoreDeleted] = await Promise.all([
    removeSessionFromRedis(sessionId),
    removeSessionFromFirestore(sessionId),
  ]);

  if (!redisDeleted && !firestoreDeleted) {
    throw new Error(`Failed to remove chart sync session ${sessionId}`);
  }
}
