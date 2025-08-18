import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface SoundEffect {
  id: string;
  type: 'tts' | 'audio-file';
  userId: string;
  username: string;
  text?: string;
  voiceId?: string;
  voice?: {
    id: string;
    name: string;
  };
  fileName?: string;
  audioData?: any;
  timestamp: number;
}

interface SoundFxPlayerProps {
  socket: Socket | null;
}

const SoundFxPlayer: React.FC<SoundFxPlayerProps> = ({ socket }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentEffect, setCurrentEffect] = useState<SoundEffect | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('soundfx_volume');
    return saved ? parseFloat(saved) : 0.8;
  });

  useEffect(() => {
    if (!socket) return;

    const handleSoundEffect = (effect: SoundEffect) => {
      console.log('🔊 SOUNDFX CLIENT: Received sound effect for all users:', {
        type: effect.type,
        text: effect.text,
        username: effect.username,
        voiceId: effect.voiceId,
        timestamp: new Date(effect.timestamp).toLocaleTimeString()
      });
      playEffect(effect);
    };

    const handleStopEffect = (data: { effectId: string }) => {
      if (currentEffect && currentEffect.id === data.effectId) {
        stopCurrentEffect();
      }
    };

    const handleStopAll = () => {
      stopCurrentEffect();
    };

    socket.on('sound-effect-play', handleSoundEffect);
    socket.on('sound-effect-stop', handleStopEffect);
    socket.on('sound-effect-stop-all', handleStopAll);

    return () => {
      socket.off('sound-effect-play');
      socket.off('sound-effect-stop');
      socket.off('sound-effect-stop-all');
    };
  }, [socket, currentEffect]);

  useEffect(() => {
    localStorage.setItem('soundfx_volume', volume.toString());
  }, [volume]);

  const playEffect = async (effect: SoundEffect) => {
    // Stop any currently playing effect
    stopCurrentEffect();

    setCurrentEffect(effect);
    setIsPlaying(true);

    try {
      if (effect.type === 'tts' && effect.text) {
        await playTTS(effect.text, effect.voiceId || 'alloy');
      } else if (effect.type === 'audio-file' && effect.fileName) {
        await playAudioFile(effect.fileName);
      }
    } catch (error) {
      console.error('❌ SOUNDFX: Error playing effect:', error);
    } finally {
      setIsPlaying(false);
      setCurrentEffect(null);
    }
  };

  const playTTS = async (text: string, voiceId: string) => {
    return new Promise<void>((resolve, reject) => {
      console.log(`🎤 SOUNDFX CLIENT: Starting TTS playback - Text: "${text}", Voice: ${voiceId}`);
      
      if (!('speechSynthesis' in window)) {
        console.error('❌ SOUNDFX CLIENT: Speech synthesis not supported in this browser');
        reject(new Error('Speech synthesis not supported'));
        return;
      }

      // Check if speech synthesis is available and not blocked
      if (speechSynthesis.speaking || speechSynthesis.pending) {
        console.log('⏳ SOUNDFX CLIENT: Speech synthesis busy, canceling previous...');
        speechSynthesis.cancel();
      }

      // Check if user has interacted with the page (required for TTS)
      if (!document.hasFocus()) {
        console.warn('⚠️ SOUNDFX CLIENT: Page not focused - TTS may be blocked');
      }

      const utterance = new SpeechSynthesisUtterance(text);
      synthRef.current = utterance;

      // Configure voice
      const voices = speechSynthesis.getVoices();
      let selectedVoice: SpeechSynthesisVoice | null = null;

      // Map our voice IDs to browser voices
      const voiceMap: { [key: string]: string[] } = {
        'alloy': ['Microsoft David', 'Google US English', 'Alex'],
        'echo': ['Microsoft Mark', 'Google UK English Male', 'Daniel'],
        'fable': ['Microsoft Hazel', 'Google UK English Female', 'Kate'],
        'onyx': ['Microsoft Zira', 'Google US English', 'Samantha'],
        'nova': ['Microsoft David', 'Google US English', 'Karen'],
        'shimmer': ['Microsoft Zira', 'Google US English', 'Moira']
      };

      // Try to find a matching voice
      const preferredVoices = voiceMap[voiceId] || voiceMap['alloy'];
      for (const voiceName of preferredVoices) {
        const voice = voices.find(v => v.name.includes(voiceName));
        if (voice) {
          selectedVoice = voice;
          break;
        }
      }

      // Fallback to default voice if no match found
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      utterance.volume = volume;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      utterance.onstart = () => {
        console.log(`▶️ SOUNDFX CLIENT: TTS started playing - "${text}"`);
      };

      utterance.onend = () => {
        console.log(`✅ SOUNDFX CLIENT: TTS finished playing - "${text}"`);
        synthRef.current = null;
        resolve();
      };

      utterance.onerror = (event) => {
        console.error('❌ SOUNDFX CLIENT: TTS error:', event);
        if (event.error === 'not-allowed') {
          console.warn('⚠️ SOUNDFX CLIENT: TTS blocked by browser - user interaction required');
          console.info('💡 SOUNDFX CLIENT: Click anywhere on the page to enable TTS audio');
        }
        synthRef.current = null;
        reject(event);
      };

      // Cancel any ongoing speech and speak
      speechSynthesis.cancel();
      
      // Small delay to ensure cancel completed
      setTimeout(() => {
        speechSynthesis.speak(utterance);
        console.log(`🗣️ SOUNDFX CLIENT: Speaking TTS - Voice: ${selectedVoice?.name || 'default'}, Text: "${text}"`);
      }, 100);
    });
  };

  const playAudioFile = async (fileName: string) => {
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(`/api/soundfx/files/${fileName}`);
      audioRef.current = audio;
      
      audio.volume = volume;
      
      audio.onended = () => {
        audioRef.current = null;
        resolve();
      };

      audio.onerror = (error) => {
        console.error('❌ SOUNDFX: Audio playback error:', error);
        audioRef.current = null;
        reject(error);
      };

      audio.play().catch(reject);
      
      console.log(`🔊 SOUNDFX: Playing audio file: ${fileName}`);
    });
  };

  const stopCurrentEffect = () => {
    if (synthRef.current) {
      speechSynthesis.cancel();
      synthRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }

    setIsPlaying(false);
    setCurrentEffect(null);
  };

  // Load voices and initialize TTS permissions
  useEffect(() => {
    if ('speechSynthesis' in window) {
      // Chrome loads voices asynchronously
      speechSynthesis.onvoiceschanged = () => {
        const voices = speechSynthesis.getVoices();
        console.log(`🎤 SOUNDFX: Loaded ${voices.length} TTS voices`);
      };
      
      // Try to load voices immediately as well
      speechSynthesis.getVoices();

      // Initialize TTS permissions on first user interaction
      const initializeTTS = () => {
        if (!speechSynthesis.speaking) {
          // Create a silent utterance to initialize TTS permissions
          const testUtterance = new SpeechSynthesisUtterance('');
          testUtterance.volume = 0;
          speechSynthesis.speak(testUtterance);
          console.log('🎤 SOUNDFX: TTS permissions initialized');
          
          // Remove the event listener after first use
          document.removeEventListener('click', initializeTTS);
          document.removeEventListener('keydown', initializeTTS);
          document.removeEventListener('touchstart', initializeTTS);
        }
      };

      // Add event listeners for user interaction
      document.addEventListener('click', initializeTTS, { once: true });
      document.addEventListener('keydown', initializeTTS, { once: true });
      document.addEventListener('touchstart', initializeTTS, { once: true });

      return () => {
        document.removeEventListener('click', initializeTTS);
        document.removeEventListener('keydown', initializeTTS);
        document.removeEventListener('touchstart', initializeTTS);
      };
    }
  }, []);

  return (
    <div style={{ display: 'none' }}>
      {/* Hidden component - only handles audio playback */}
      {isPlaying && currentEffect && (
        <div data-effect-id={currentEffect.id} data-effect-type={currentEffect.type} />
      )}
    </div>
  );
};

export default SoundFxPlayer;