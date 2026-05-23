import { useCallback, useState } from 'react';
import CookieService, { COOKIE_NAMES } from '../services/CookieService';
import type {
  AudioSettingsConfig,
  VideoSettingsConfig,
  StreamerSettingsConfig,
} from '../components/stream/StreamerSettings';

/**
 * Owns the streamer's audio/video/screen-share settings and their
 * cookie-backed persistence.
 *
 * Owns:
 *   - `audioSettings`, `videoSettings`, `streamerSettings` initialized
 *     from cookies (`AUDIO_SETTINGS`, `VIDEO_SETTINGS`,
 *     `STREAMER_SETTINGS`) with the original defaults preserved.
 *   - `updateStreamerSettings(next)` — replaces the full settings object
 *     and persists it to the `STREAMER_SETTINGS` cookie.
 *   - `updateAudioSettings(next)` — merges into `streamerSettings.audio`,
 *     persists to both `AUDIO_SETTINGS` and `STREAMER_SETTINGS` cookies
 *     (same dual-write pattern the original inline handler used).
 *   - `updateVideoSettings(next)` — merges into `streamerSettings.video`,
 *     persists to both `VIDEO_SETTINGS` and `STREAMER_SETTINGS` cookies.
 *
 * Does NOT own:
 *   - Cookie consent — handled separately by `CookieConsentService`.
 *   - The deep child components (e.g. the `<StreamerSettings>` widget)
 *     that may persist their own slice of settings; those still receive
 *     a `setStreamerSettings` setter via `setStreamerSettings` exposed
 *     here for the original "settings already saved to cookies by
 *     StreamerSettings component" path in App.tsx.
 *
 * Behavior is preserved verbatim from the original inline state in
 * App.tsx: same cookie keys, same defaults, same dual-write order, same
 * `screenShare` fallback object when an older cookie shape is loaded.
 */
export interface StreamerSettingsState {
  audioSettings: AudioSettingsConfig;
  videoSettings: VideoSettingsConfig;
  streamerSettings: StreamerSettingsConfig;
  /**
   * Replace the entire `streamerSettings` object. Persists to the
   * `STREAMER_SETTINGS` cookie.
   */
  updateStreamerSettings: (next: StreamerSettingsConfig) => void;
  /**
   * Merge a new audio slice into `streamerSettings.audio` and persist to
   * both the audio-only and the combined settings cookies. Mirrors the
   * `onAudioSettingsChange` handler that used to live inline in App.tsx.
   */
  updateAudioSettings: (next: AudioSettingsConfig) => void;
  /**
   * Merge a new video slice into `streamerSettings.video` and persist to
   * both the video-only and the combined settings cookies. Mirrors the
   * `onVideoSettingsChange` handler that used to live inline in App.tsx.
   */
  updateVideoSettings: (next: VideoSettingsConfig) => void;
  /**
   * Raw state setter for `streamerSettings`. Exposed for code paths
   * where a child component (e.g. `<StreamerSettings>`) has already
   * persisted to cookies on its own and only needs the parent state to
   * track the new value.
   */
  setStreamerSettings: React.Dispatch<React.SetStateAction<StreamerSettingsConfig>>;
}

const DEFAULT_AUDIO_SETTINGS: AudioSettingsConfig = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: 48000,
  channelCount: 2,
  profile: 'raw',
};

const DEFAULT_VIDEO_SETTINGS: VideoSettingsConfig = {
  resolution: '720p',
  frameRate: 30,
  facingMode: 'user',
  bitrate: 2000,
  videoEnabled: true,
  mirror: false,
};

const DEFAULT_SCREEN_SHARE = {
  cursor: 'always' as const,
  audio: false,
  displaySurface: 'monitor' as const,
};

export function useStreamerSettings(): StreamerSettingsState {
  const [audioSettings] = useState<AudioSettingsConfig>(() => {
    const savedAudioSettings = CookieService.getCookie(COOKIE_NAMES.AUDIO_SETTINGS);
    return savedAudioSettings || DEFAULT_AUDIO_SETTINGS;
  });

  const [videoSettings] = useState<VideoSettingsConfig>(() => {
    const savedVideoSettings = CookieService.getCookie(COOKIE_NAMES.VIDEO_SETTINGS);
    return savedVideoSettings || DEFAULT_VIDEO_SETTINGS;
  });

  const [streamerSettings, setStreamerSettings] = useState<StreamerSettingsConfig>(() => {
    const savedSettings = CookieService.getCookie(COOKIE_NAMES.STREAMER_SETTINGS);
    return savedSettings
      ? {
          ...savedSettings,
          screenShare: savedSettings.screenShare || DEFAULT_SCREEN_SHARE,
        }
      : {
          audio: audioSettings,
          video: videoSettings,
          screenShare: DEFAULT_SCREEN_SHARE,
        };
  });

  const updateStreamerSettings = useCallback((next: StreamerSettingsConfig) => {
    setStreamerSettings(next);
    CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, next);
  }, []);

  const updateAudioSettings = useCallback((next: AudioSettingsConfig) => {
    setStreamerSettings(prev => {
      const merged = { ...prev, audio: next };
      // Persist both the audio-only cookie and the combined cookie,
      // exactly as the original inline handler did.
      CookieService.setCookie(COOKIE_NAMES.AUDIO_SETTINGS, next);
      CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, merged);
      return merged;
    });
  }, []);

  const updateVideoSettings = useCallback((next: VideoSettingsConfig) => {
    setStreamerSettings(prev => {
      const merged = { ...prev, video: next };
      CookieService.setCookie(COOKIE_NAMES.VIDEO_SETTINGS, next);
      CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, merged);
      return merged;
    });
  }, []);

  return {
    audioSettings,
    videoSettings,
    streamerSettings,
    updateStreamerSettings,
    updateAudioSettings,
    updateVideoSettings,
    setStreamerSettings,
  };
}

export default useStreamerSettings;
