import React, { useState, useEffect, useRef } from 'react';
import './ChatSettings.css';

interface ChatSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  currentColor: string;
  onColorChange: (color: string) => void;
  onSettingsChange: (settings: ChatUserSettings) => void;
  currentSettings: ChatUserSettings;
  username?: string;
}

export interface ChatUserSettings {
  showTimestamps: boolean;
  timestampFormat: 'short' | 'long' | 'relative';
  userColor: string;
}

const ChatSettings: React.FC<ChatSettingsProps> = ({
  isOpen,
  onClose,
  currentColor,
  onColorChange,
  onSettingsChange,
  currentSettings,
  username = 'User'
}) => {
  const [settings, setSettings] = useState<ChatUserSettings>(currentSettings);
  const [colorInput, setColorInput] = useState(currentColor);
  const [isValidColor, setIsValidColor] = useState(true);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSettings(currentSettings);
    setColorInput(currentSettings.userColor);
  }, [currentSettings]);

  useEffect(() => {
    // Close settings when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  const validateHexColor = (color: string): boolean => {
    return /^#[0-9A-F]{6}$/i.test(color);
  };

  const handleColorInputChange = (value: string) => {
    // Auto-add # if user starts typing hex without it
    let processedValue = value;
    if (value.length === 6 && !value.startsWith('#')) {
      processedValue = '#' + value;
    }
    
    setColorInput(processedValue);
    
    const isValid = validateHexColor(processedValue);
    setIsValidColor(isValid);
    
    if (isValid) {
      const newSettings = { ...settings, userColor: processedValue };
      setSettings(newSettings);
      onColorChange(processedValue);
      onSettingsChange(newSettings);
    }
  };

  const handleTimestampToggle = () => {
    const newSettings = { ...settings, showTimestamps: !settings.showTimestamps };
    setSettings(newSettings);
    onSettingsChange(newSettings);
  };

  const handleTimestampFormatChange = (format: 'short' | 'long' | 'relative') => {
    const newSettings = { ...settings, timestampFormat: format };
    setSettings(newSettings);
    onSettingsChange(newSettings);
  };

  const getRandomColor = () => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#6C5CE7', '#A29BFE', '#FD79A8',
      '#FDCB6E', '#6C63FF', '#00B894', '#00CEC9', '#0984E3'
    ];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    handleColorInputChange(randomColor);
  };

  const getPresetColors = () => {
    return [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#6C5CE7', '#A29BFE', '#FD79A8'
    ];
  };

  if (!isOpen) return null;

  return (
    <div className="chat-settings-overlay">
      <div className="chat-settings" ref={settingsRef}>
        <div className="chat-settings-header">
          <h3>Chat Settings</h3>
          <button className="chat-settings-close" onClick={onClose}>×</button>
        </div>
        
        <div className="chat-settings-content">
          {/* Timestamp Settings */}
          <div className="settings-section">
            <h4>Timestamps</h4>
            <div className="setting-item">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={settings.showTimestamps}
                  onChange={handleTimestampToggle}
                />
                <span className="toggle-slider"></span>
                <span className="setting-label">Show timestamps</span>
              </label>
            </div>
            
            {settings.showTimestamps && (
              <div className="setting-item">
                <label className="setting-label">Format:</label>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      name="timestampFormat"
                      value="short"
                      checked={settings.timestampFormat === 'short'}
                      onChange={() => handleTimestampFormatChange('short')}
                    />
                    <span>Short (12:34)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="timestampFormat"
                      value="long"
                      checked={settings.timestampFormat === 'long'}
                      onChange={() => handleTimestampFormatChange('long')}
                    />
                    <span>Long (12:34:56)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="timestampFormat"
                      value="relative"
                      checked={settings.timestampFormat === 'relative'}
                      onChange={() => handleTimestampFormatChange('relative')}
                    />
                    <span>Relative (2m ago)</span>
                  </label>
                </div>
              </div>
            )}
          </div>
          
          {/* Color Settings */}
          <div className="settings-section">
            <h4>Username Color</h4>
            <div className="setting-item">
              <div className="color-input-group">
                <input
                  type="text"
                  className={`color-hex-input ${!isValidColor ? 'invalid' : ''}`}
                  value={colorInput}
                  onChange={(e) => handleColorInputChange(e.target.value)}
                  placeholder="#000000"
                  maxLength={7}
                />
                <input
                  type="color"
                  className="color-picker-input"
                  value={isValidColor ? colorInput : currentColor}
                  onChange={(e) => handleColorInputChange(e.target.value)}
                />
                <button 
                  className="random-color-btn"
                  onClick={getRandomColor}
                  title="Random color"
                >
                  🎲
                </button>
              </div>
              {!isValidColor && (
                <div className="color-error">Please enter a valid hex color (e.g., #FF6B6B)</div>
              )}
            </div>
            
            <div className="setting-item">
              <div className="color-preview">
                <span>Preview: </span>
                <span className="username-preview" style={{ color: isValidColor ? colorInput : currentColor }}>
                  {username}
                </span>
              </div>
            </div>
            
            <div className="setting-item">
              <label className="setting-label">Quick colors:</label>
              <div className="preset-colors">
                {getPresetColors().map((color) => (
                  <button
                    key={color}
                    className={`preset-color ${colorInput === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => handleColorInputChange(color)}
                    title={color}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatSettings;