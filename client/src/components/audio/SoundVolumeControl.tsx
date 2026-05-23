import React, { useState, useRef, useEffect } from 'react';
import './SoundVolumeControl.css';

interface SoundVolumeControlProps {
  volume: number;
  onVolumeChange: (volume: number) => void;
}

const SoundVolumeControl: React.FC<SoundVolumeControlProps> = ({ volume, onVolumeChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Convert volume to percentage (0-100)
  const volumePercent = Math.round(volume * 100);
  
  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(event.target.value);
    // Enforce minimum 20% volume
    const clampedVolume = Math.max(20, newVolume);
    onVolumeChange(clampedVolume / 100);
  };

  const getVolumeIcon = () => {
    if (volumePercent >= 66) {
      return '🔊'; // High volume
    } else if (volumePercent >= 33) {
      return '🔉'; // Medium volume
    } else {
      return '🔈'; // Low volume
    }
  };

  return (
    <div className="sound-volume-control" ref={menuRef}>
      <button
        className="volume-icon-button"
        onClick={() => setIsOpen(!isOpen)}
        title="Sound Effects Volume"
        aria-label="Sound Effects Volume Control"
      >
        <span className="volume-icon">{getVolumeIcon()}</span>
      </button>
      
      {isOpen && (
        <div className="volume-menu">
          <div className="volume-menu-header">
            <span className="volume-menu-title">Sound Effects Volume</span>
            <span className="volume-percentage">{volumePercent}%</span>
          </div>
          
          <div className="volume-slider-container">
            <span className="volume-label">🔈</span>
            <input
              type="range"
              min="20"
              max="100"
              value={volumePercent}
              onChange={handleVolumeChange}
              className="volume-slider"
              aria-label="Volume slider"
            />
            <span className="volume-label">🔊</span>
          </div>
          
          <div className="volume-info">
            <small>Controls TTS, soundboard, and effect sounds</small>
            <small className="volume-minimum">Min: 20%</small>
          </div>
        </div>
      )}
    </div>
  );
};

export default SoundVolumeControl;