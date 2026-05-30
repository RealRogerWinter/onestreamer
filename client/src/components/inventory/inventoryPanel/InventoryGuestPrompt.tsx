import React from 'react';

interface InventoryGuestPromptProps {
  onLogin?: () => void;
  onSignup?: () => void;
}

/**
 * Guest (unauthenticated) inventory prompt. Markup preserved verbatim so the
 * characterization tests stay green.
 */
const InventoryGuestPrompt: React.FC<InventoryGuestPromptProps> = ({ onLogin, onSignup }) => {
  return (
    <div className="inventory-guest-prompt-v2">
      <div className="guest-icon-header">
        <div className="locked-icon">🔒</div>
        <h3>Inventory Locked</h3>
      </div>

      <div className="guest-benefits">
        <div className="benefit-item">
          <span className="benefit-icon">💎</span>
          <span>Collect rare items</span>
        </div>
        <div className="benefit-item">
          <span className="benefit-icon">⚡</span>
          <span>Use powerful buffs</span>
        </div>
        <div className="benefit-item">
          <span className="benefit-icon">🎯</span>
          <span>Throw effects on stream</span>
        </div>
      </div>

      <div className="auth-cta-section">
        <button
          className="inventory-login-btn"
          onClick={(e) => {
            e.preventDefault();
            if (onLogin) onLogin();
          }}
        >
          Sign In
        </button>
        <div className="divider-text">or</div>
        <button
          className="inventory-signup-btn"
          onClick={(e) => {
            e.preventDefault();
            if (onSignup) onSignup();
          }}
        >
          <span className="signup-text">Create Free Account</span>
          <span className="signup-bonus">🎁 Get starter items!</span>
        </button>
      </div>
    </div>
  );
};

export default InventoryGuestPrompt;
