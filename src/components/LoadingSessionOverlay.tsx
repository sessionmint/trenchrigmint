'use client';

import { useState, useEffect } from 'react';

interface LoadingSessionOverlayProps {
  isVisible: boolean;
  onComplete: () => void;
  duration?: number;
}

export function LoadingSessionOverlay({
  isVisible,
  onComplete,
  duration = 10000
}: LoadingSessionOverlayProps) {
  const [countdown, setCountdown] = useState(Math.ceil(duration / 1000));

  useEffect(() => {
    if (!isVisible) {
      setCountdown(Math.ceil(duration / 1000));
      return;
    }

    // Start countdown
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onComplete();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isVisible, duration, onComplete]);

  if (!isVisible) return null;

  return (
    <div className="loading-session-overlay">
      <div className="loading-session-content">
        <div className="loading-session-spinner" />
        <h2 className="loading-session-title">SessionMint</h2>
        <p className="loading-session-message">Loading a new pump session...</p>
        <div className="loading-session-countdown">{countdown}</div>
        <p className="loading-session-subtitle">Device syncing in progress</p>
      </div>
    </div>
  );
}
