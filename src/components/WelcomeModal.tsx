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
        <h2 className="modal-title">How it works?</h2>

        <p className="modal-description">
          SessionMint allows <span className="text-highlight">anyone</span> to take control of the AutoBlow device being live-streamed. The device moves as per the chart loaded on SessionMint.
        </p>

        <div className="modal-steps">
          <p className="modal-step">
            <span className="step-label">Step 1:</span> Connect Wallet
          </p>
          <p className="modal-step">
            <span className="step-label">Step 2:</span> Pick the option & approve
          </p>
          <p className="modal-step">
            <span className="step-label">Step 3:</span> Stroke Your Coin in the Trenches
          </p>
        </div>

        <p className="modal-tagline">
          A COMMUNITY THAT PUMPS TOGETHER, STROKES TOGETHER.<br />
          SHOW YOUR PUMP TO THE STREAM!
        </p>

        <button className="modal-button" onClick={handleClose}>
          I&apos;m ready to stroke
        </button>

        <div className="modal-footer">
          Demo by <a href="https://sessionmint.fun" target="_blank" rel="noopener noreferrer">sessionmint.fun</a>
          <p className="modal-disclaimer">There is no token associated with SessionMint.</p>
          <p className="modal-notice">Meant for gag & entertainment purposes only. We do not endorse any token displayed on SessionMint. Device Synchronization is at best-effort basis.</p>
          <div className="modal-links">
            <a href="https://sessionmint.fun/terms-of-service/" target="_blank" rel="noopener noreferrer">Terms of Service</a>
            <span className="modal-divider">|</span>
            <a href="mailto:support@sessionmint.fun">Contact Support</a>
          </div>
        </div>
      </div>
    </div>
  );
}
