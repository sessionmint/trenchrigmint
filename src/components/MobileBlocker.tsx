'use client';

import { useState, useEffect } from 'react';

const MIN_WIDTH = 900;

export function MobileBlocker() {
  const [isBlocked, setIsBlocked] = useState(false);
  const [currentWidth, setCurrentWidth] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const checkWidth = () => {
      const width = window.innerWidth;
      setCurrentWidth(width);
      setIsBlocked(width < MIN_WIDTH);
    };

    // Check on mount
    checkWidth();

    // Check on resize
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  // Don't render anything on server or before mount
  if (!mounted) return null;

  if (!isBlocked) return null;

  return (
    <div className="mobile-blocker">
      <div className="mobile-blocker-content">
        <div className="mobile-blocker-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12" y2="18.01" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="mobile-blocker-x">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
        </div>

        <h1 className="mobile-blocker-title">Desktop Required</h1>

        <p className="mobile-blocker-message">
          SessionMint requires a minimum screen width of {MIN_WIDTH}px for the optimal experience.
        </p>

        <div className="mobile-blocker-divider" />

        <p className="mobile-blocker-hint">
          Please access this site from a desktop computer or increase your browser window size.
        </p>

        <div className="mobile-blocker-specs">
          <span>Current: {currentWidth}px</span>
          <span>Required: {MIN_WIDTH}px+</span>
        </div>
      </div>
    </div>
  );
}
