import React, { useState, useEffect } from 'react';
import './TTSPermissionNotice.css';

const TTSPermissionNotice: React.FC = () => {
  const [showNotice, setShowNotice] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);

  useEffect(() => {
    // Check if TTS is supported
    if (!('speechSynthesis' in window)) {
      return;
    }

    // Show notice after a brief delay if user hasn't interacted
    const timer = setTimeout(() => {
      if (!hasInteracted) {
        setShowNotice(true);
      }
    }, 3000);

    // Listen for user interactions
    const handleInteraction = () => {
      setHasInteracted(true);
      setShowNotice(false);
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };

    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('keydown', handleInteraction, { once: true });
    document.addEventListener('touchstart', handleInteraction, { once: true });

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
  }, [hasInteracted]);

  if (!showNotice) {
    return null;
  }

  return (
    <div className="tts-permission-notice">
      <div className="tts-notice-content">
        <span className="tts-notice-icon">🔊</span>
        <div className="tts-notice-text">
          <strong>TTS Audio Ready!</strong>
          <p>Click anywhere to enable text-to-speech audio from Megaphone messages</p>
        </div>
        <button 
          className="tts-notice-dismiss"
          onClick={() => setShowNotice(false)}
        >
          ×
        </button>
      </div>
    </div>
  );
};

export default TTSPermissionNotice;