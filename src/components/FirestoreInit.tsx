'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueueStore } from '@/store/useQueueStore';
import { initializeAuth, subscribeToAuthState } from '@/lib/firebase';

const QUEUE_DRIVER = (process.env.NEXT_PUBLIC_QUEUE_DRIVER || process.env.QUEUE_DRIVER || 'firestore').toLowerCase();
const USE_FIRESTORE = QUEUE_DRIVER === 'firestore';

export const FirestoreInit = () => {
  const initialize = useQueueStore((state) => state.initialize);
  const isInitialized = useQueueStore((state) => state.isInitialized);
  const [authInitialized, setAuthInitialized] = useState(false);
  const cleanupRef = useRef<null | (() => void)>(null);
  const startedRef = useRef(false);

  // Initialize anonymous auth when component mounts
  useEffect(() => {
    if (!USE_FIRESTORE) {
      // No Firestore: mark auth as ready so queue poller can start
      setAuthInitialized(true);
      return;
    }

    let authUnsubscribe: (() => void) | undefined;

    console.log('[FirestoreInit] Component mounted, setting up auth...');

    const setupAuth = async () => {
      try {
        let authOk = false;
        // Initialize anonymous auth
        await initializeAuth();
        console.log('[FirestoreInit] Auth initialized successfully');
        authOk = true;
        setAuthInitialized(true);

        if (authOk) {
          // Subscribe to auth state changes
          authUnsubscribe = subscribeToAuthState((user) => {
            if (user) {
              console.log('[FirestoreInit] User signed in:', user.uid);
            } else {
              console.log('[FirestoreInit] No user signed in');
            }
          });
        }
      } catch (error) {
        console.error('[FirestoreInit] Auth setup error:', error);
        // For demo deploys, don't hard-block Firestore listeners on auth issues.
        // If your Firestore rules require auth, you'll still see permission errors in the listeners.
        setAuthInitialized(true);
      }
    };

    setupAuth();

    return () => {
      if (authUnsubscribe) {
        authUnsubscribe();
      }
    };
  }, []);

  // Initialize Firestore listeners after auth is ready
  useEffect(() => {
    console.log('[FirestoreInit] Checking initialization:', { isInitialized, authInitialized });

    if (authInitialized && !startedRef.current) {
      startedRef.current = true;
      console.log('[FirestoreInit] Starting Firestore listeners...');
      cleanupRef.current = initialize();
    }
  }, [initialize, authInitialized, isInitialized]);

  // Cleanup listeners on unmount only (don't tear down just because isInitialized flips)
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
      cleanupRef.current = null;
      startedRef.current = false;
    };
  }, []);

  return null;
};
