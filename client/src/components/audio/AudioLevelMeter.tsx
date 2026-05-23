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
  // CPU Optimization: Batch state updates into single object to reduce re-renders
  const [meterState, setMeterState] = useState({
    audioLevel: 0,      // 0-1 range
    decibelLevel: -60,  // dB level
    peakLevel: -60      // Peak hold level
  });
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Float32Array | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const peakHoldTimeRef = useRef<number>(0);
  const smoothedLevelRef = useRef<number>(-60);

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

      // console.log('🎤 AUDIO METER: Setting up audio analyzer');

      // Create audio context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioContext = audioContextRef.current;

      // Create analyzer node
      analyserRef.current = audioContext.createAnalyser();
      const analyser = analyserRef.current;
      
      // Configure analyzer for time domain analysis (better for level metering)
      // CPU Optimization: Reduced from 2048 to 256 - sufficient for level metering
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0; // No smoothing - we'll do our own
      
      // Create data array for time domain data
      const bufferLength = analyser.fftSize;
      dataArrayRef.current = new Float32Array(bufferLength);

      // Create source from stream
      sourceRef.current = audioContext.createMediaStreamSource(stream!);
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

    // CPU Optimization: Throttle to 30fps (33ms interval) instead of 60fps
    const METER_UPDATE_INTERVAL = 33;
    let lastUpdateTime = 0;

    const analyze = (timestamp: number = performance.now()) => {
      if (!analyser || !dataArray || !isActive) return;

      // Throttle updates to 30fps
      if (timestamp - lastUpdateTime < METER_UPDATE_INTERVAL) {
        animationFrameRef.current = requestAnimationFrame(analyze);
        return;
      }
      lastUpdateTime = timestamp;

      // Get time domain data (waveform)
      analyser.getFloatTimeDomainData(dataArray);

      // Calculate RMS (Root Mean Square) for accurate level measurement
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const value = dataArray[i];
        sum += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Convert to decibels (20 * log10 for amplitude)
      // Using -60 dB as floor for better dynamic range
      const instantDb = rms > 0.0001 ? 20 * Math.log10(rms) : -60;
      const peakDb = peak > 0.0001 ? 20 * Math.log10(peak) : -60;
      
      // Apply smoothing for more stable display
      const smoothingFactor = 0.85; // Higher = more smoothing
      smoothedLevelRef.current = smoothedLevelRef.current * smoothingFactor +
                                  instantDb * (1 - smoothingFactor);

      // Clamp dB range for display (-60 dB to 0 dB)
      const clampedDb = Math.max(-60, Math.min(0, smoothedLevelRef.current));

      // Convert to 0-1 range for display (0 = -60dB, 1 = 0dB)
      const normalizedLevel = (clampedDb + 60) / 60;

      // Update peak hold (use timestamp from RAF instead of Date.now())
      let newPeakLevel = meterState.peakLevel;
      if (peakDb > meterState.peakLevel || timestamp - peakHoldTimeRef.current > 2000) {
        newPeakLevel = peakDb;
        peakHoldTimeRef.current = timestamp;
      }

      // CPU Optimization: Single batched state update instead of 3 separate calls
      setMeterState({
        audioLevel: normalizedLevel,
        decibelLevel: clampedDb,
        peakLevel: newPeakLevel
      });

      // Continue analyzing (throttled to 30fps)
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
    if (db <= -60 || !isFinite(db)) {
      return '-∞';
    }
    return db.toFixed(1);
  };

  const getLevelColor = (db: number): string => {
    // Professional dB-based color scheme
    // -60 to -20 dB: Green (safe levels)
    // -20 to -6 dB: Yellow (optimal levels)
    // -6 to -3 dB: Orange (caution)
    // -3 to 0 dB: Red (clipping risk)
    
    if (db < -20) {
      return '#00ff00'; // Green
    } else if (db < -6) {
      return '#ffff00'; // Yellow
    } else if (db < -3) {
      return '#ff8800'; // Orange
    } else {
      return '#ff0000'; // Red
    }
  };

  const getMeterBarColor = (position: number, currentLevel: number, db: number): string => {
    // position: 0-1 (left to right on meter)
    // currentLevel: 0-1 (current audio level)
    // db: actual dB value
    
    if (position <= currentLevel) {
      // Map position to dB for color calculation
      const positionDb = -60 + (position * 60);
      return getLevelColor(positionDb);
    } else {
      // Inactive part - dark with slight color hint
      return 'rgba(40, 40, 40, 0.8)';
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
      <div className="meter-header">
        <span className="meter-title">AUDIO LEVEL</span>
        <span className="meter-db-value">{formatDb(meterState.decibelLevel)} dB</span>
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
      
      <div className="meter-scale">
        <div className="meter-scale-labels">
          <span>-60</span>
          <span>-40</span>
          <span>-20</span>
          <span>-12</span>
          <span>-6</span>
          <span>-3</span>
          <span>0</span>
        </div>
        
        <div className="meter-track">
          <div className="meter-segments">
            {/* Create segmented meter */}
            {Array.from({ length: 40 }, (_, i) => {
              const position = i / 39; // 0 to 1
              const isActive = position <= meterState.audioLevel;
              const segmentDb = -60 + (position * 60);
              
              return (
                <div
                  key={i}
                  className={`meter-segment ${isActive ? 'active' : ''}`}
                  style={{
                    backgroundColor: isActive ? getLevelColor(segmentDb) : 'transparent',
                  }}
                />
              );
            })}
          </div>
          
          {/* Peak indicator */}
          <div 
            className="meter-peak"
            style={{
              left: `${Math.max(0, Math.min(100, ((meterState.peakLevel + 60) / 60) * 100))}%`
            }}
          />
        </div>
        
        <div className="meter-markers">
          {/* dB scale markers */}
          <div className="marker" style={{ left: '0%' }} />
          <div className="marker" style={{ left: '33.3%' }} />
          <div className="marker" style={{ left: '66.7%' }} />
          <div className="marker" style={{ left: '80%' }} />
          <div className="marker" style={{ left: '90%' }} />
          <div className="marker" style={{ left: '95%' }} />
          <div className="marker" style={{ left: '100%' }} />
        </div>
      </div>
      
      <div className="meter-legend">
        <span className="legend-item green">SAFE</span>
        <span className="legend-item yellow">OPTIMAL</span>
        <span className="legend-item orange">CAUTION</span>
        <span className="legend-item red">PEAK</span>
      </div>
    </div>
  );
};

export default AudioLevelMeter;