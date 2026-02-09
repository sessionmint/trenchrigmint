'use client';

import { useEffect, useState } from 'react';
import { useQueueStore } from '@/store/useQueueStore';
import { initializeAuth, subscribeToAuthState } from '@/lib/firebase';

export const FirestoreInit = () => {
  const initialize = useQueueStore((state) => state.initialize);
  const isInitialized = useQueueStore((state) => state.isInitialized);
  const [authInitialized, setAuthInitialized] = useState(false);

  // Initialize anonymous auth when component mounts
  useEffect(() => {
    let authUnsubscribe: (() => void) | undefined;

    console.log('[FirestoreInit] Component mounted, setting up auth...');

    const setupAuth = async () => {
      try {
        // Initialize anonymous auth
        await initializeAuth();
        console.log('[FirestoreInit] Auth initialized successfully');
        setAuthInitialized(true);

        // Subscribe to auth state changes
        authUnsubscribe = subscribeToAuthState((user) => {
          if (user) {
            console.log('[FirestoreInit] User signed in:', user.uid);
          } else {
            console.log('[FirestoreInit] No user signed in');
          }
        });
      } catch (error) {
        console.error('[FirestoreInit] Auth setup error:', error);
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

    if (!isInitialized && authInitialized) {
      console.log('[FirestoreInit] Starting Firestore listeners...');
      const cleanup = initialize();
      return cleanup;
    }
  }, [initialize, isInitialized, authInitialized]);

  return null;
};