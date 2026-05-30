// Config types for the StreamerSettings panel. Extracted verbatim from
// StreamerSettings.tsx; re-exported from there so existing importers keep
// working. No behavior change.

export interface VideoSettingsConfig {
  resolution: '480p' | '720p';
  frameRate: 15 | 24 | 30 | 60;
  bitrate: number;
  facingMode: 'user' | 'environment';
  videoEnabled: boolean;
  mirror: boolean;
  videoDeviceId?: string;
}

export interface AudioSettingsConfig {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate: number;
  channelCount: number;
  profile: 'raw' | 'microphone' | 'music' | 'streaming';
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export type PipPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface ScreenShareSettingsConfig {
  cursor: 'always' | 'motion' | 'never';
  audio: boolean;
  mixWithMic: boolean;  // Mix system audio with microphone
  micGain: number;      // 0-100, microphone volume in mix
  systemGain: number;   // 0-100, system audio volume in mix
  displaySurface: 'monitor' | 'window' | 'browser';
  // Picture-in-Picture settings
  pipEnabled: boolean;       // Show webcam overlay on screen share
  pipPosition: PipPosition;  // Corner position of PiP
  pipSize: number;           // 10-50, percentage of screen width
}

export interface StreamerSettingsConfig {
  audio: AudioSettingsConfig;
  video: VideoSettingsConfig;
  screenShare?: ScreenShareSettingsConfig;
}

export const getDefaultScreenShareSettings = (): ScreenShareSettingsConfig => ({
  cursor: 'always',
  audio: false,
  mixWithMic: true,  // Default to mixing with mic when system audio is enabled
  micGain: 100,      // Default 100%
  systemGain: 100,   // Default 100%
  displaySurface: 'monitor',
  // PiP defaults
  pipEnabled: false,  // Disabled by default
  pipPosition: 'bottom-right',
  pipSize: 25         // 25% of screen width
});
