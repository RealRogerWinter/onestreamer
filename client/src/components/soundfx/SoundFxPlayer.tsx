import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface SoundEffect {
  id: string;
  type: 'tts' | 'audio-file' | '101soundboard';
  userId: string;
  username: string;
  text?: string;
  voiceId?: string;
  voice?: {
    id: string;
    name: string;
  };
  fileName?: string;
  soundFileUrl?: string;
  soundName?: string;
  boardName?: string;
  duration?: number;
  maxDuration?: number;
  audioData?: any;
  timestamp: number;
  isItemSound?: boolean;  // Flag from server indicating if this is an item sound
}

interface SoundFxPlayerProps {
  socket: Socket | null;
  volume?: number;
}

const SoundFxPlayer: React.FC<SoundFxPlayerProps> = ({ socket, volume = 0.8 }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentEffect, setCurrentEffect] = useState<SoundEffect | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Track multiple simultaneous item sounds
  const itemSoundsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Use ref to always have current volume value
  const volumeRef = useRef(volume);
  
  // Detect Safari iOS for special handling
  const isSafariIOS = useRef<boolean>(
    /iPad|iPhone|iPod/.test(navigator.userAgent) && 
    !(window as any).MSStream && 
    /Safari/.test(navigator.userAgent)
  );

  // Update volume of existing audio elements when volume prop changes
  useEffect(() => {
    // Update ref to always have current value
    volumeRef.current = volume;
    
    // Update current playing audio
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
    
    // Update all item sounds
    itemSoundsRef.current.forEach((audio) => {
      audio.volume = volumeRef.current;
    });
    
    // Update speech synthesis if playing
    if (synthRef.current) {
      synthRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (!socket) return;

    const handleSoundEffect = (effect: SoundEffect) => {
      // console.log('🔊 SOUNDFX CLIENT: Received sound effect for all users:', {
      //   type: effect.type,
      //   text: effect.text,
      //   username: effect.username,
      //   voiceId: effect.voiceId,
      //   timestamp: new Date(effect.timestamp).toLocaleTimeString()
      // });
      playEffect(effect);
    };

    const handleStopEffect = (data: { effectId: string }) => {
      if (currentEffect && currentEffect.id === data.effectId) {
        stopCurrentEffect();
      }
    };

    const handleStopAll = () => {
      stopAllEffects();
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

  const playEffect = async (effect: SoundEffect) => {
    // Only stop current effect if this is NOT an item sound
    // Item sounds can play simultaneously
    const isItem = effect.isItemSound === true;
    
    if (!isItem) {
      // Stop any currently playing non-item effect
      stopCurrentEffect();
      setCurrentEffect(effect);
      setIsPlaying(true);
    }

    try {
      if (effect.type === 'tts' && effect.text) {
        await playTTS(effect.text, effect.voiceId || 'alloy');
      } else if (effect.type === 'audio-file' && effect.fileName) {
        await playAudioFile(effect.fileName);
      } else if (effect.type === '101soundboard' && effect.soundFileUrl) {
        await play101Soundboard(effect.soundFileUrl, effect.duration, effect.maxDuration, effect.isItemSound);
      }
    } catch (error) {
      console.error('❌ SOUNDFX: Error playing effect:', error);
    } finally {
      if (!isItem) {
        setIsPlaying(false);
        setCurrentEffect(null);
      }
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

      // Safari iOS fix: Always cancel first to clear any stuck state
      speechSynthesis.cancel();
      
      // Small delay after cancel for Safari iOS
      setTimeout(() => {
        const utterance = new SpeechSynthesisUtterance(text);
        // IMPORTANT: Keep reference to prevent garbage collection on Safari iOS
        synthRef.current = utterance;

        // Configure voice - Safari iOS specific handling
        const voices = speechSynthesis.getVoices();
        console.log(`🔊 SOUNDFX CLIENT: Available voices: ${voices.length}`);
        
        // Safari iOS: Set lang even if no voices available
        utterance.lang = 'en-US'; // Default to US English
        
        if (voices && voices.length > 0) {
          // Try to find an English voice for Safari iOS
          let selectedVoice = voices.find(v => v.lang.startsWith('en-'));
          
          // If no English voice, use first available
          if (!selectedVoice) {
            selectedVoice = voices[0];
          }
          
          if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang; // Match the voice's language
            console.log(`🎯 SOUNDFX CLIENT: Selected voice: ${selectedVoice.name} (${selectedVoice.lang})`);
          }
        }

        utterance.volume = volumeRef.current;
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
            console.warn('⚠️ SOUNDFX CLIENT: TTS blocked - user interaction required');
            if (isSafariIOS.current) {
              console.warn('🍎 SOUNDFX CLIENT: Safari iOS - tap the Enable Audio button');
            }
          }
          synthRef.current = null;
          reject(event);
        };

        // Speak the utterance
        try {
          speechSynthesis.speak(utterance);
          console.log(`🗣️ SOUNDFX CLIENT: Called speak() for: "${text}"`);
          
          // Safari iOS: Check if speaking actually started
          setTimeout(() => {
            if (!speechSynthesis.speaking && !speechSynthesis.pending) {
              console.error('❌ SOUNDFX CLIENT: Speech not started - may need user interaction');
              reject(new Error('Speech synthesis failed to start'));
            }
          }, 500);
        } catch (e) {
          console.error('❌ SOUNDFX CLIENT: Exception calling speak():', e);
          reject(e);
        }
      }, 50); // Delay after cancel
    });
  };

  const playAudioFile = async (fileName: string) => {
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(`/api/soundfx/files/${fileName}`);
      audioRef.current = audio;
      
      audio.volume = volumeRef.current;
      
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
      
      // console.log(`🔊 SOUNDFX: Playing audio file: ${fileName}`);
    });
  };

  const play101Soundboard = async (soundFileUrl: string, duration?: number, maxDuration?: number, isItemSound?: boolean) => {
    return new Promise<void>((resolve, reject) => {
      const isItem = isItemSound === true;
      console.log(`📣 SOUNDFX CLIENT: Playing 101soundboard${isItem ? ' (Item Sound - Simultaneous)' : ''}: ${soundFileUrl}`);
      console.log(`📣 SOUNDFX CLIENT: Duration: ${duration}ms, Max: ${maxDuration}ms`);
      
      const audio = new Audio(soundFileUrl);
      
      // For item sounds, track them separately to allow simultaneous playback
      if (isItem) {
        const soundId = `item_${Date.now()}_${Math.random()}`;
        itemSoundsRef.current.set(soundId, audio);
        
        // Clean up when sound ends
        audio.addEventListener('ended', () => {
          itemSoundsRef.current.delete(soundId);
        });
        audio.addEventListener('error', () => {
          itemSoundsRef.current.delete(soundId);
        });
      } else {
        // For regular sounds, use the single audioRef
        audioRef.current = audio;
      }
      
      audio.volume = volumeRef.current;
      // No need for crossOrigin since we're using our proxy
      
      // If duration exceeds max, set a timeout to stop playback
      let maxDurationTimeout: NodeJS.Timeout | null = null;
      if (maxDuration && duration && duration > maxDuration) {
        maxDurationTimeout = setTimeout(() => {
          console.log(`⏱️ SOUNDFX CLIENT: Stopping playback at ${maxDuration}ms limit`);
          if (!isItem && audioRef.current === audio) {
            audio.pause();
            audioRef.current = null;
            resolve();
          } else if (isItem) {
            audio.pause();
            resolve();
          }
        }, maxDuration);
      }
      
      audio.onended = () => {
        if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
        if (!isItem) {
          audioRef.current = null;
        }
        console.log(`✅ SOUNDFX CLIENT: 101soundboard playback ended${isItem ? ' (Item Sound)' : ''}`);
        resolve();
      };

      audio.onerror = (error) => {
        if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
        console.error('❌ SOUNDFX CLIENT: 101soundboard playback error:', error);
        if (!isItem) {
          audioRef.current = null;
        }
        reject(error);
      };

      audio.play().catch((err) => {
        if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
        console.error('❌ SOUNDFX CLIENT: Failed to play 101soundboard:', err);
        reject(err);
      });
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

    // Note: We don't stop item sounds here since they should play simultaneously
    // Only stop them if explicitly requested via stopAllEffects

    setIsPlaying(false);
    setCurrentEffect(null);
  };

  const stopAllEffects = () => {
    stopCurrentEffect();
    
    // Also stop all item sounds
    itemSoundsRef.current.forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
    itemSoundsRef.current.clear();
  };

  // Load voices and initialize TTS permissions
  useEffect(() => {
    if ('speechSynthesis' in window) {
      // Safari iOS fix: Try multiple times to load voices
      let voiceLoadAttempts = 0;
      const maxAttempts = 5;
      
      const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        if (voices.length > 0 || voiceLoadAttempts >= maxAttempts) {
          // console.log(`🎤 SOUNDFX: Loaded ${voices.length} TTS voices after ${voiceLoadAttempts} attempts`);
        } else {
          voiceLoadAttempts++;
          setTimeout(loadVoices, 500);
        }
      };
      
      // Chrome and other browsers load voices asynchronously
      speechSynthesis.onvoiceschanged = () => {
        const voices = speechSynthesis.getVoices();
        // console.log(`🎤 SOUNDFX: Loaded ${voices.length} TTS voices`);
      };
      
      // Try to load voices immediately
      loadVoices();

      // Initialize TTS permissions on first user interaction
      const initializeTTS = () => {
        try {
          console.log('🎤 SOUNDFX: Initializing TTS with user interaction');
          
          // Safari iOS: Cancel any stuck state first
          speechSynthesis.cancel();
          
          // Load voices
          const voices = speechSynthesis.getVoices();
          console.log(`🔊 SOUNDFX: Voices available on init: ${voices.length}`);
          
          // Create empty utterance to prime the system
          const testUtterance = new SpeechSynthesisUtterance('');
          testUtterance.volume = 0;
          
          // Must speak immediately in user interaction handler
          speechSynthesis.speak(testUtterance);
          console.log('✅ SOUNDFX: TTS initialized with empty utterance');
          
          // Store that we've initialized
          localStorage.setItem('tts_initialized', 'true');
          
          // Remove all event listeners
          document.removeEventListener('click', initializeTTS);
          document.removeEventListener('keydown', initializeTTS);
          document.removeEventListener('touchstart', initializeTTS);
          document.removeEventListener('touchend', initializeTTS);
        } catch (e) {
          console.error('❌ SOUNDFX: Failed to initialize TTS:', e);
        }
      };

      // Add event listeners for user interaction
      // Safari iOS needs both touchstart and touchend
      document.addEventListener('click', initializeTTS, { once: true });
      document.addEventListener('keydown', initializeTTS, { once: true });
      document.addEventListener('touchstart', initializeTTS, { once: true });
      document.addEventListener('touchend', initializeTTS, { once: true });

      return () => {
        document.removeEventListener('click', initializeTTS);
        document.removeEventListener('keydown', initializeTTS);
        document.removeEventListener('touchstart', initializeTTS);
        document.removeEventListener('touchend', initializeTTS);
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