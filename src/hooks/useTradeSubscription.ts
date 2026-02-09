'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { HELIUS_WS_URL } from '@/lib/constants';
import { withAppBasePath } from '@/lib/app-url';
import { TradeEvent, parseWebsocketTransaction } from '@/lib/helius';

// Rate limit protection constants
const WS_RECONNECT_BASE_DELAY = 3000;  // Start at 3 seconds
const WS_RECONNECT_MAX_DELAY = 60000;  // Max 60 seconds between retries
const WS_MAX_RECONNECT_ATTEMPTS = 10;  // Stop after 10 failed attempts

interface UseTradeSubscriptionProps {
  tokenMint: string;
  onTrade: (trade: TradeEvent) => void;
  enabled?: boolean;
}

interface SubscriptionState {
  isConnected: boolean;
  lastTrade: TradeEvent | null;
  error: string | null;
  reconnectCount: number;
}

// Minimum time between device alerts (prevent spam during high volume)
const DEVICE_ALERT_MIN_INTERVAL = 500; // 500ms minimum between alerts

export function useTradeSubscription({
  tokenMint,
  onTrade,
  enabled = true
}: UseTradeSubscriptionProps): SubscriptionState {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastAlertTimeRef = useRef<number>(0);

  const [state, setState] = useState<SubscriptionState>({
    isConnected: false,
    lastTrade: null,
    error: null,
    reconnectCount: 0,
  });

  const sendDeviceAlert = useCallback(async (trade: TradeEvent) => {
    // Rate limit device alerts to prevent API abuse
    const now = Date.now();
    if (now - lastAlertTimeRef.current < DEVICE_ALERT_MIN_INTERVAL) {
      return; // Skip this alert, too soon after last one
    }
    lastAlertTimeRef.current = now;

    try {
      await fetch(withAppBasePath('/api/device-alert'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trade),
      });
    } catch (error) {
      console.error('Error sending device alert:', error);
    }
  }, []);

  const handleTrade = useCallback((trade: TradeEvent) => {
    setState(prev => ({ ...prev, lastTrade: trade }));
    onTrade(trade);
    sendDeviceAlert(trade);
  }, [onTrade, sendDeviceAlert]);

  const connect = useCallback(function connectSocket() {
    if (!enabled || !tokenMint || !HELIUS_WS_URL) return;

    if (wsRef.current) wsRef.current.close();

    try {
      const ws = new WebSocket(HELIUS_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Helius WS] Connected');
        setState(prev => ({ ...prev, isConnected: true, error: null, reconnectCount: 0 }));

        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'transactionSubscribe',
          params: [
            { accountInclude: [tokenMint] },
            { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
          ],
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.params?.result) {
            const trade = parseWebsocketTransaction(data.params.result, tokenMint);
            if (trade) handleTrade(trade);
          }
        } catch (error) {
          console.error('[Helius WS] Parse error:', error);
        }
      };

      ws.onerror = () => {
        setState(prev => ({ ...prev, isConnected: false, error: 'WebSocket error' }));
      };

      ws.onclose = () => {
        setState(prev => {
          // Stop reconnecting after max attempts to prevent rate limiting
          if (prev.reconnectCount >= WS_MAX_RECONNECT_ATTEMPTS) {
            console.log('[Helius WS] Max reconnection attempts reached, stopping');
            return { ...prev, isConnected: false, error: 'Connection failed after max retries' };
          }

          // Exponential backoff: 3s, 6s, 12s, 24s, 48s, 60s (capped)
          const delay = Math.min(
            WS_RECONNECT_BASE_DELAY * Math.pow(2, prev.reconnectCount),
            WS_RECONNECT_MAX_DELAY
          );
          console.log(`[Helius WS] Reconnecting in ${delay}ms (attempt ${prev.reconnectCount + 1}/${WS_MAX_RECONNECT_ATTEMPTS})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            setState(p => ({ ...p, reconnectCount: p.reconnectCount + 1 }));
            connectSocket();
          }, delay);

          return { ...prev, isConnected: false };
        });
      };
    } catch {
      setState(prev => ({ ...prev, error: 'Failed to connect' }));
    }
  }, [tokenMint, enabled, handleTrade]);

  useEffect(() => {
    // Reset reconnect count when token changes (fresh start for new token)
    setState(prev => ({ ...prev, reconnectCount: 0, error: null }));
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [tokenMint, enabled, connect]);

  return state;
}
