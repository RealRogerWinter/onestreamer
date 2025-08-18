import React, { useEffect, useRef, useState } from 'react';
import './AudioLevelMeter.css';

interface AudioLevelMeterProps {
  stream: MediaStream | null;
  isActive?: boolean;
  isVisible?: boolean;
  onToggleVisibility?: () => void;
}

const AudioLevelMeter: React.FC<AudioLevelMeterProps> = ({ 
  stream, 
  isActive = true,
  isVisible = true,
  onToggleVisibility 
}) => {
  const [audioLevel, setAudioLevel] = useState(0); // 0-1 range
  const [decibelLevel, setDecibelLevel] = useState(-Infinity); // dB level
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (stream && isActive) {
      setupAudioAnalyzer();
    } else {
      cleanup();
    }

    return cleanup;
  }, [stream, isActive]);

  const setupAudioAnalyzer = () => {
    try {
      // Clean up existing setup
      cleanup();

      const audioTracks = stream?.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        console.warn('🎤 AUDIO METER: No audio tracks found in stream');
        return;
      }

      console.log('🎤 AUDIO METER: Setting up audio analyzer');

      // Create audio context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioContext = audioContextRef.current;

      // Create analyzer node
      analyserRef.current = audioContext.createAnalyser();
      const analyser = analyserRef.current;
      
      // Configure analyzer for better frequency resolution and less interference
      analyser.fftSize = 128; // Very small FFT for minimal processing impact
      analyser.smoothingTimeConstant = 0.8; // More smoothing to reduce processing load
      
      // Create data array for frequency data
      const bufferLength = analyser.frequencyBinCount;
      dataArrayRef.current = new Uint8Array(bufferLength);

      // Create source from stream - clone the stream to avoid interference
      const clonedStream = stream!.clone();
      sourceRef.current = audioContext.createMediaStreamSource(clonedStream);
      sourceRef.current.connect(analyser);

      // Start analyzing
      startAnalyzing();

    } catch (error) {
      console.error('❌ AUDIO METER: Failed to setup audio analyzer:', error);
    }
  };

  const startAnalyzing = () => {
    if (!analyserRef.current || !dataArrayRef.current) return;

    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;

    const analyze = () => {
      if (!analyser || !dataArray || !isActive) return;

      // Get frequency domain data
      analyser.getByteFrequencyData(dataArray);

      // Calculate RMS (Root Mean Square) for volume level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const value = dataArray[i] / 255; // Normalize to 0-1
        sum += value * value;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Convert to decibels
      // RMS of 0 = -Infinity dB, RMS of 1 = 0 dB
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      
      // Clamp dB range for display (-40 dB to 0 dB) - shorter range for faster color transitions
      const clampedDb = Math.max(-40, Math.min(0, db));
      
      // Convert to 0-1 range for display (0 = -40dB, 1 = 0dB)
      const normalizedLevel = (clampedDb + 40) / 40;

      setAudioLevel(normalizedLevel);
      setDecibelLevel(clampedDb);

      // Continue analyzing
      animationFrameRef.current = requestAnimationFrame(analyze);
    };

    analyze();
  };

  const cleanup = () => {
    // Cancel animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Disconnect audio nodes
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    dataArrayRef.current = null;
  };

  const formatDb = (db: number): string => {
    if (db === -Infinity || !isFinite(db)) {
      return '-∞ dB';
    }
    return `${Math.round(db)} dB`;
  };

  const getLevelColor = (level: number): string => {
    // Faster color transitions: green -> yellow -> orange -> red
    // level: 0 (quiet) -> 1 (loud)
    
    if (level < 0.4) {
      // Green to yellow range (quiet)
      const green = 255;
      const red = Math.round(255 * (level / 0.4));
      return `rgb(${red}, ${green}, 0)`;
    } else if (level < 0.7) {
      // Yellow to orange range (moderate)
      const normalizedLevel = (level - 0.4) / 0.3; // 0-1 range
      const red = 255;
      const green = Math.round(255 * (1 - normalizedLevel * 0.5)); // Fade to orange
      return `rgb(${red}, ${green}, 0)`;
    } else {
      // Orange to red range (loud)
      const normalizedLevel = (level - 0.7) / 0.3; // 0-1 range for red transition
      const red = 255;
      const green = Math.round(128 * (1 - normalizedLevel)); // From orange (128) to red (0)
      return `rgb(${red}, ${green}, 0)`;
    }
  };

  const getMeterBarColor = (position: number, currentLevel: number): string => {
    // position: 0-1 (left to right on meter)
    // currentLevel: 0-1 (current audio level)
    
    if (position <= currentLevel) {
      // Active part of the meter - use gradient
      return getLevelColor(position);
    } else {
      // Inactive part - dark gray
      return 'rgba(255, 255, 255, 0.1)';
    }
  };

  if (!stream || !isActive) {
    return null;
  }

  if (!isVisible) {
    return null;
  }

  return (
    <div className="audio-level-meter-container">
      <div className="audio-level-meter-row">
        <div className="audio-level-meter">
          {/* Create meter bars */}
          {Array.from({ length: 50 }, (_, i) => {
            const position = i / 49; // 0 to 1
            return (
              <div
                key={i}
                className="audio-meter-bar"
                style={{
                  backgroundColor: getMeterBarColor(position, audioLevel),
                  height: '100%',
                  width: '2%',
                  marginRight: '0.2%'
                }}
              />
            );
          })}
        </div>
        
        {onToggleVisibility && (
          <button
            className="audio-level-toggle-compact"
            onClick={onToggleVisibility}
            title="Hide audio meter"
          >
            ✕
          </button>
        )}
      </div>
      
      <div className="audio-level-labels">
        <span className="level-label quiet">-40</span>
        <span className="level-label medium">-20</span>
        <span className="level-label loud">0 dB</span>
      </div>
    </div>
  );
};

export default AudioLevelMeter;