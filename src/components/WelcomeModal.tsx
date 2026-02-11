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
          SessionMint's TrenchRig Syncs to the <span className="text-highlight">Session State Chart</span>. When a state is purchased, it becomes the enforced live focus.
        </p>

        <div className="modal-steps">
          <p className="modal-step">
            <span className="step-label">Step 1: </span> Connect Wallet<br />
          </p>
          <p className="modal-step">
            <span className="step-label">Step 2: Enter Token Contract Address & Pay<br />
            </p>
          <p className="modal-step">
            <span className="step-label">Step 3: Take the Screen<br />
            Your token is featured live.<br />
            TrenchRig syncs to the chart in real time.
          </p>
        </div>

        <p className="modal-tagline">
          THE SELECTED TOKEN CHART BECOMES THE CONTROL SIGNAL.<br />
          TRENCHRIG EXECUTES THAT SIGNAL IN REAL TIME.
        </p>

        <button className="modal-button" onClick={handleClose}>
          I&apos;M READY TO FEEL THE PUMP
        </button>

        <div className="modal-footer">
          TrenchRig Demo by <a href="https://sessionmint.fun" target="_blank" rel="noopener noreferrer">sessionmint.fun</a>
          <p className="modal-disclaimer">$MINSTR is the only token associated with SessionMint.fun.</p>
          <p className="modal-notice">For entertainment and gag purposes only. Device synchronization is best-effort. We do not endorse any token displayed.</p>
          <div className="modal-links">
            <a href="mailto:sessionmint@gmail.com">Contact support</a>
          </div>
        </div>
      </div>
    </div>
  );
}
