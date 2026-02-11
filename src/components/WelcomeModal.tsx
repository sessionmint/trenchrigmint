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
        <h2 className="modal-title">Session State</h2>

        <p className="modal-description">
          SessionMint operates TrenchRig on a deterministic <span className="text-highlight">Session State</span>. When a state is purchased, it becomes the enforced live focus. The selected token chart becomes the control signal. TrenchRig executes that signal in real time.
        </p>

        <div className="modal-steps">
          <p className="modal-step">
            <span className="step-label">Step 1 &mdash;</span> Connect Wallet<br />
            Authorize your wallet to participate.
          </p>
          <p className="modal-step">
            <span className="step-label">Step 2 &mdash;</span> Enter Token Contract<br />
            Paste the token contract address and purchase the Session State.
          </p>
          <p className="modal-step">
            <span className="step-label">Step 3 &mdash;</span> Take the Screen<br />
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
            <a href="https://sessionmint.fun/terms-of-service/" target="_blank" rel="noopener noreferrer">Terms of Service</a>
            <span className="modal-divider">|</span>
            <a href="mailto:sessionmint@gmail.com">Contact support (sessionmint@gmail.com)</a>
          </div>
        </div>
      </div>
    </div>
  );
}
