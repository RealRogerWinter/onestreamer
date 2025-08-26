import React, { useState, useEffect } from 'react';

const SafariTTSNotice: React.FC = () => {
  const [showNotice, setShowNotice] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);

  useEffect(() => {
    // Check if Safari iOS
    const ua = navigator.userAgent;
    const isSafariIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream && /Safari/.test(ua);
    
    // Also check if already initialized
    const alreadyInit = localStorage.getItem('safari_tts_initialized') === 'true';
    
    if (isSafariIOS && !hasInteracted && !alreadyInit) {
      setShowNotice(true);
      console.log('🍎 Safari TTS Notice: Showing for Safari iOS user');
    }
  }, [hasInteracted]);

  const handleInteraction = () => {
    // Initialize TTS with user interaction
    if ('speechSynthesis' in window) {
      try {
        console.log('🍎 Safari TTS: User clicked enable button');
        
        // Cancel any stuck state
        speechSynthesis.cancel();
        
        // Get voices to prime the system
        const voices = speechSynthesis.getVoices();
        console.log(`🍎 Safari TTS: ${voices.length} voices available`);
        
        // CRITICAL: Use empty string, not space
        const testUtterance = new SpeechSynthesisUtterance('');
        testUtterance.volume = 0;
        
        // Speak immediately in click handler
        speechSynthesis.speak(testUtterance);
        console.log('✅ Safari TTS: Initialized with empty utterance');
        
        // Test with actual text after a delay
        setTimeout(() => {
          const testText = new SpeechSynthesisUtterance('Audio enabled');
          testText.volume = 0.3;
          speechSynthesis.cancel();
          speechSynthesis.speak(testText);
          console.log('🔊 Safari TTS: Test speak triggered');
        }, 100);
        
      } catch (e) {
        console.error('❌ Safari TTS: Failed to initialize:', e);
      }
    }
    
    setHasInteracted(true);
    setShowNotice(false);
    localStorage.setItem('safari_tts_initialized', 'true');
  };

  useEffect(() => {
    // Check if already initialized
    if (localStorage.getItem('safari_tts_initialized') === 'true') {
      setHasInteracted(true);
      setShowNotice(false);
    }
  }, []);

  if (!showNotice) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        padding: '20px',
        borderRadius: '10px',
        zIndex: 10000,
        textAlign: 'center',
        maxWidth: '80%',
        border: '2px solid #ff9800'
      }}
      onClick={handleInteraction}
    >
      <h3 style={{ marginTop: 0 }}>📢 Enable Text-to-Speech</h3>
      <p>Safari requires a tap to enable audio playback</p>
      <button 
        style={{
          backgroundColor: '#ff9800',
          color: 'white',
          border: 'none',
          padding: '10px 20px',
          borderRadius: '5px',
          fontSize: '16px',
          cursor: 'pointer',
          marginTop: '10px'
        }}
      >
        Tap to Enable Audio
      </button>
      <p style={{ fontSize: '12px', marginTop: '15px', opacity: 0.7 }}>
        Safari requires user interaction to play audio
      </p>
    </div>
  );
};

export default SafariTTSNotice;