'use client';

import { useState } from 'react';

export function WelcomeModal() {
  const [isOpen, setIsOpen] = useState(true);

  const handleClose = () => {
    setIsOpen(false);
    // Dispatch custom event to enable stream controls
    window.dispatchEvent(new CustomEvent('streamEnabled'));
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-container">
        <h2 className="modal-title">Session Mint</h2>

        <p className="modal-description">
          SessionMint TrenchRig syncs to the <span className="text-highlight">Session State Chart</span>. When a state is purchased, it becomes the live focus.
        </p>

        <div className="modal-steps">
          <p className="modal-step">
            <span className="step-label">Step 1:</span> Connect Wallet
          </p>
          <p className="modal-step">
            <span className="step-label">Step 2:</span> Enter Token Contract Address and Pay
          </p>
          <p className="modal-step">
            <span className="step-label">Step 3:</span> Take the Screen
          </p>
        </div>

        <p className="modal-tagline">
          Your token is featured live.
        </p>

        <button className="modal-button" onClick={handleClose}>
          I&apos;M READY TO FEEL THE PUMP
        </button>

        <div className="modal-footer">
          TrenchRig Demo by <a href="https://sessionmint.fun" target="_blank" rel="noopener noreferrer">sessionmint.fun</a>
          <p className="modal-disclaimer">No official token is endorsed. Do your own research before buying anything.</p>
          <p className="modal-notice">For entertainment and gag purposes only. Device synchronization is best-effort. We do not endorse any token displayed.</p>
          <div className="modal-links">
            <a href="mailto:sessionmint@gmail.com">Contact support</a>
          </div>
        </div>
      </div>
    </div>
  );
}
