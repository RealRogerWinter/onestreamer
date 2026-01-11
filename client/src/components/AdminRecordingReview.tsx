import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import authService from '../services/AuthService';
import PlaybackTimeline from './recording-review/PlaybackTimeline';
import SyncedChatReplay from './recording-review/SyncedChatReplay';
import StreamerList from './recording-review/StreamerList';
import ReviewSettings from './recording-review/ReviewSettings';
import './AdminRecordingReview.css';

interface AdminRecordingReviewProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

interface PlaybackInfo {
  sessionIds: string[];
  sessionCount: number;
  earliestRecording: number;
  latestRecording: number;
  totalDurationMs: number;
  totalChatMessages: number;
  streamUrl: string;
}

interface TimelineData {
  startTime: number;
  endTime: number;
  events: any[];
  recordings: any[];
}

type ViewMode = 'player' | 'settings';

// Time filter presets
type TimeFilterPreset = 'all' | 'today' | 'yesterday' | 'last_hour' | 'last_6_hours' | 'last_24_hours' | 'custom';

interface TimeFilterState {
  preset: TimeFilterPreset;
  customStart: number | null;
  customEnd: number | null;
}

// Helper to get time range for a preset
const getPresetTimeRange = (preset: TimeFilterPreset): { start: number | null; end: number | null } => {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'today':
      return { start: startOfToday.getTime(), end: now };
    case 'yesterday':
      return { start: startOfYesterday.getTime(), end: startOfToday.getTime() };
    case 'last_hour':
      return { start: now - 60 * 60 * 1000, end: now };
    case 'last_6_hours':
      return { start: now - 6 * 60 * 60 * 1000, end: now };
    case 'last_24_hours':
      return { start: now - 24 * 60 * 60 * 1000, end: now };
    case 'custom':
      return { start: null, end: null }; // Will use custom values
    default:
      return { start: null, end: null };
  }
};

const AdminRecordingReview: React.FC<AdminRecordingReviewProps> = ({ makeApiCall, addLog }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsStreamUrlRef = useRef<string | null>(null);
  const hlsVideoElementRef = useRef<HTMLVideoElement | null>(null); // Track which video element HLS is attached to

  const [viewMode, setViewMode] = useState<ViewMode>('player');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [hasRecordings, setHasRecordings] = useState(false);
  const [videoMounted, setVideoMounted] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [showStreamers, setShowStreamers] = useState(true);

  // Time filter state
  const [timeFilter, setTimeFilter] = useState<TimeFilterState>({
    preset: 'all',
    customStart: null,
    customEnd: null
  });
  const [showTimeFilter, setShowTimeFilter] = useState(false);

  // Callback ref to detect when video element is mounted
  const videoRefCallback = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node) {
      console.log('Video element mounted');
      setVideoMounted(true);
    } else {
      setVideoMounted(false);
    }
  }, []);

  // Fetch playback info and timeline on mount
  const fetchData = useCallback(async (isRefresh = false) => {
    try {
      // Only show loading spinner on initial load, not refreshes
      // This prevents unmounting the video element during refresh
      if (!isRefresh) {
        setLoading(true);
      }
      console.log(isRefresh ? 'Refreshing playback info...' : 'Fetching playback info...');

      // Fetch playback info
      const playbackResponse = await makeApiCall('/admin/review/playback');
      console.log('Playback response:', playbackResponse);
      if (playbackResponse.success && playbackResponse.hasRecordings) {
        console.log('Setting playback info:', playbackResponse.playback);
        setPlaybackInfo(playbackResponse.playback);
        setHasRecordings(true);
      } else {
        console.log('No recordings available');
        setHasRecordings(false);
      }

      // Fetch timeline data
      const timelineResponse = await makeApiCall('/admin/review/timeline?days=7');
      if (timelineResponse.success) {
        setTimeline(timelineResponse.timeline);
      }

      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load recording data');
    } finally {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }, [makeApiCall]);

  // Only fetch on initial mount - use ref to prevent re-fetching when makeApiCall changes
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchData();
    }
  }, [fetchData]);

  // Initialize HLS player when playback info is available
  useEffect(() => {
    console.log('HLS useEffect triggered:', {
      hasPlaybackInfo: !!playbackInfo,
      videoMounted: videoMounted,
      hasVideoRef: !!videoRef.current,
      streamUrl: playbackInfo?.streamUrl,
      alreadyInitialized: hlsStreamUrlRef.current
    });
    if (!playbackInfo || !videoMounted || !videoRef.current) return;

    const video = videoRef.current;
    const token = authService.getToken();
    const baseUrl = process.env.REACT_APP_SERVER_URL || '';
    const streamUrl = `${baseUrl}${playbackInfo.streamUrl}`;

    // Skip if HLS is already initialized for this URL AND attached to the same video element
    if (hlsStreamUrlRef.current === streamUrl && hlsRef.current && hlsVideoElementRef.current === video) {
      console.log('HLS: Already initialized for this URL and video element, skipping');
      return;
    }

    // If video element changed but HLS exists, reattach to new video element
    if (hlsRef.current && hlsVideoElementRef.current !== video) {
      console.log('HLS: Video element changed, reattaching HLS to new element');
      // First detach from old element, then attach to new one
      hlsRef.current.detachMedia();
      hlsRef.current.attachMedia(video);
      hlsVideoElementRef.current = video;
      // DON'T restart loading - let HLS.js resume from current position
      // The startLoad will happen automatically from the current media time
      return;
    }

    // Cleanup previous HLS instance if URL changed
    if (hlsRef.current) {
      console.log('HLS: Destroying previous instance (URL changed)');
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      console.log('HLS: Initializing with URL:', streamUrl);
      console.log('HLS: Auth token present:', !!token);

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        debug: true, // Enable debug to see what's happening
        // VOD-specific settings for better seeking with discontinuities
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferHole: 2, // Increased for discontinuities
        maxSeekHole: 5, // Increased for discontinuities
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 10,
        startPosition: 0.2, // Start slightly ahead to avoid initial gap issue (audio/video offset)
        // Important for streams with discontinuities
        backBufferLength: 60,
        // Specific discontinuity handling
        appendErrorMaxRetry: 5,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 4,
        // Gap/nudge settings to handle small gaps (critical for audio/video sync issues)
        nudgeOffset: 0.2, // How much to nudge when stuck
        nudgeMaxRetry: 10, // Increase max nudge attempts
        maxFragLookUpTolerance: 0.5, // More tolerance for fragment lookup
        // Audio/video sync tolerance - critical for our segments with 106ms A/V offset
        maxAudioFramesDrift: 2, // Allow more audio frame drift
        forceKeyFrameOnDiscontinuity: true, // Force keyframe on discontinuity
        // Start fragment preference
        startFragPrefetch: true,
        // Stall handling
        highBufferWatchdogPeriod: 3, // Check for stalls more frequently
        xhrSetup: (xhr: XMLHttpRequest, url: string) => {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
      });

      hlsRef.current = hls;
      hlsVideoElementRef.current = video; // Track which video element HLS is attached to
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_event: string, data: any) => {
        console.log('HLS: Manifest parsed, levels:', data.levels?.length);
        console.log('HLS: Total duration from manifest:', data.levels?.[0]?.details?.totalduration);
        // Mark as initialized
        hlsStreamUrlRef.current = streamUrl;
        // Don't auto-play yet - wait for buffer to be ready
      });

      // Track if we've done the initial nudge
      let initialNudgeDone = false;

      // Handle buffer appended - check if we need to nudge past initial gap
      hls.on(Hls.Events.BUFFER_APPENDED, () => {
        if (video.buffered.length > 0 && !initialNudgeDone) {
          const bufferStart = video.buffered.start(0);
          const bufferEnd = video.buffered.end(0);
          console.log('HLS: Buffer check - start:', bufferStart.toFixed(3), 'end:', bufferEnd.toFixed(3), 'currentTime:', video.currentTime.toFixed(3));

          // If current time is before buffer start, nudge forward
          if (video.currentTime < bufferStart && bufferEnd - bufferStart > 1) {
            console.log('HLS: Nudging past initial gap from', video.currentTime, 'to', bufferStart + 0.1);
            video.currentTime = bufferStart + 0.1;
            initialNudgeDone = true;
            // Now try to play
            video.play().catch(e => console.log('Auto-play after nudge blocked:', e));
          } else if (video.currentTime >= bufferStart) {
            // Already past the gap, can play
            if (video.paused && !initialNudgeDone) {
              initialNudgeDone = true;
              video.play().catch(e => console.log('Auto-play blocked:', e));
            }
          }
        }
      });

      // Log when first fragment is loaded to check PTS (use string event names for TypeScript compatibility)
      (hls as any).on('hlsFragLoaded', (_event: string, data: any) => {
        console.log('HLS: Fragment loaded:', data.frag?.sn, 'start:', data.frag?.start, 'startPTS:', data.frag?.startPTS);
      });

      // Log level loaded to see duration calculation
      (hls as any).on('hlsLevelLoaded', (_event: string, data: any) => {
        console.log('HLS: Level loaded, duration:', data.details?.totalduration, 'fragments:', data.details?.fragments?.length);
        if (data.details?.fragments?.[0]) {
          console.log('HLS: First fragment start:', data.details.fragments[0].start);
        }
      });

      hls.on(Hls.Events.ERROR, (_event: string, data: { fatal: boolean; details: string; type: string; response?: any; frag?: any }) => {
        console.error('HLS error:', data.type, data.details, data.response?.code, data.frag?.sn);

        // Handle specific error details
        const isFragError = data.details.includes('frag') || data.details.includes('FRAG');
        const isBufferError = data.details.includes('buffer') || data.details.includes('BUFFER');

        if (data.fatal) {
          // Try to recover based on error type
          switch (data.type) {
            case 'networkError':
              console.log('HLS: Attempting recovery from network error');
              // If it's a fragment error, try to skip to next fragment
              if (isFragError && data.frag) {
                console.log('HLS: Skipping bad fragment', data.frag.sn);
                hls.startLoad(data.frag.sn + 1);
              } else {
                hls.startLoad();
              }
              break;
            case 'mediaError':
              console.log('HLS: Attempting recovery from media error');
              hls.recoverMediaError();
              break;
            default:
              console.log('HLS: Fatal error, attempting full reload');
              // Don't destroy - try to recover instead
              hls.startLoad();
              break;
          }
        } else {
          // Non-fatal error - handle specifically
          if (isFragError) {
            console.log('HLS: Non-fatal fragment error, continuing...');
          } else if (isBufferError) {
            console.log('HLS: Buffer error, attempting to restart loading');
            hls.startLoad();
          }
        }
      });

      // Periodic gap check - every 2 seconds, check if video is paused unexpectedly
      const gapCheckInterval = setInterval(() => {
        if (!video.paused && !video.ended && video.readyState >= 2) {
          return; // Playing fine
        }

        // Video is paused - check if it should be playing
        if (video.paused && !video.ended && video.buffered.length > 0) {
          const currentTime = video.currentTime;
          const duration = video.duration || (playbackInfo?.totalDurationMs || 0) / 1000;

          // Check if we're not near the end
          if (currentTime < duration - 5) {
            // Check if there's buffer ahead
            for (let i = 0; i < video.buffered.length; i++) {
              const bufStart = video.buffered.start(i);
              const bufEnd = video.buffered.end(i);

              // If current time is in a gap before this buffer range
              if (currentTime < bufStart - 0.1) {
                console.log('Periodic check: Found gap, currentTime:', currentTime, 'bufferStart:', bufStart);
                console.log('Periodic check: Nudging to', bufStart + 0.1);
                video.currentTime = bufStart + 0.1;
                video.play().catch(() => {});
                break;
              }

              // If current time is within buffer but video is paused
              if (currentTime >= bufStart && currentTime <= bufEnd - 1) {
                console.log('Periodic check: Buffer available but paused at', currentTime);
                video.play().catch(() => {});
                break;
              }
            }
          }
        }
      }, 2000);

      // Store interval for cleanup
      (hls as any)._gapCheckInterval = gapCheckInterval;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = streamUrl;
      video.play().catch(e => console.log('Auto-play blocked:', e));
    }

    // Video event handlers
    const handleTimeUpdate = () => {
      setCurrentTimeMs(Math.floor(video.currentTime * 1000));
    };

    const handleDurationChange = () => {
      if (video.duration && !isNaN(video.duration) && isFinite(video.duration)) {
        console.log('Video duration updated:', video.duration, 'seconds');
        setVideoDurationMs(Math.floor(video.duration * 1000));
      }
    };

    const handlePlay = () => {
      console.log('Video PLAY event at', video.currentTime);
      setIsPlaying(true);
    };

    // Track if pause was user-initiated
    let userInitiatedPause = false;
    const handlePause = () => {
      const currentTime = video.currentTime;
      const duration = video.duration || (playbackInfo?.totalDurationMs || 0) / 1000;
      const nearEnd = currentTime > duration - 2;

      console.log('=== Video PAUSE event ===');
      console.log('  currentTime:', currentTime);
      console.log('  duration:', duration);
      console.log('  nearEnd:', nearEnd);
      console.log('  readyState:', video.readyState);
      console.log('  networkState:', video.networkState);
      console.log('  error:', video.error);

      if (video.buffered.length > 0) {
        for (let i = 0; i < video.buffered.length; i++) {
          console.log(`  buffered[${i}]: ${video.buffered.start(i).toFixed(3)} - ${video.buffered.end(i).toFixed(3)}`);
        }
      }

      setIsPlaying(false);

      // If video paused unexpectedly (not near end, not user-initiated), try to recover
      if (!nearEnd && !userInitiatedPause && video.readyState >= 2) {
        console.log('Unexpected pause detected, attempting recovery in 1s...');
        setTimeout(() => {
          if (video.paused && !video.ended) {
            // Check if we're in a gap
            if (video.buffered.length > 0) {
              const bufStart = video.buffered.start(0);
              if (currentTime < bufStart - 0.05) {
                console.log('Recovery: Nudging past gap to', bufStart + 0.1);
                video.currentTime = bufStart + 0.1;
              }
            }
            console.log('Recovery: Attempting to resume playback');
            video.play().catch(e => console.log('Recovery play failed:', e));
          }
        }, 1000);
      }
      userInitiatedPause = false;
    };

    // Intercept user-initiated pause
    video.addEventListener('click', () => { userInitiatedPause = true; }, true);

    // Handle stalls - video waiting for data
    let stallRecoveryTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleWaiting = () => {
      const currentTime = video.currentTime;
      console.log('Video waiting for data at', currentTime);

      // Check if we're stuck before a buffer gap
      if (video.buffered.length > 0) {
        let foundGap = false;
        for (let i = 0; i < video.buffered.length; i++) {
          const start = video.buffered.start(i);
          const end = video.buffered.end(i);
          console.log(`  Buffer range ${i}: ${start.toFixed(3)} - ${end.toFixed(3)}`);

          // If current time is before this buffer range, we're in a gap
          if (currentTime < start) {
            console.log(`  Detected gap! currentTime ${currentTime.toFixed(3)} < buffer start ${start.toFixed(3)}`);
            console.log(`  Nudging forward to ${start + 0.1}`);
            video.currentTime = start + 0.1;
            foundGap = true;
            setTimeout(() => video.play().catch(() => {}), 100);
            break;
          }

          // If current time is within this range, we should be fine
          if (currentTime >= start && currentTime <= end) {
            console.log(`  currentTime is within buffer range ${i}`);
            break;
          }
        }

        if (!foundGap) {
          // Standard recovery - wait then try to nudge
          if (stallRecoveryTimeout) clearTimeout(stallRecoveryTimeout);
          stallRecoveryTimeout = setTimeout(() => {
            if (video.paused || video.readyState < 3) {
              console.log('Video stalled for 2s, attempting recovery');
              // Nudge forward slightly
              video.currentTime = video.currentTime + 0.1;
              video.play().catch(() => {});
            }
          }, 2000);
        }
      } else {
        // No buffer at all - wait for data
        if (stallRecoveryTimeout) clearTimeout(stallRecoveryTimeout);
        stallRecoveryTimeout = setTimeout(() => {
          if (hlsRef.current) {
            console.log('No buffer after 3s, restarting HLS load');
            hlsRef.current.startLoad();
          }
        }, 3000);
      }
    };

    const handleStalled = () => {
      console.log('Video stalled event at', video.currentTime);
      // Try to restart loading if HLS.js is available
      if (hlsRef.current) {
        console.log('HLS: Attempting to restart loading after stall');
        hlsRef.current.startLoad();
      }
    };

    const handlePlaying = () => {
      // Clear stall recovery timeout when video starts playing again
      if (stallRecoveryTimeout) {
        clearTimeout(stallRecoveryTimeout);
        stallRecoveryTimeout = null;
      }
    };

    // Handle ended event - this might fire prematurely with HLS discontinuities
    const handleEnded = () => {
      console.log('=== VIDEO ENDED EVENT ===');
      console.log('video.currentTime:', video.currentTime);
      console.log('video.duration:', video.duration);
      console.log('video.paused:', video.paused);
      console.log('video.ended:', video.ended);
      console.log('video.readyState:', video.readyState);

      // Log buffered ranges
      if (video.buffered.length > 0) {
        for (let i = 0; i < video.buffered.length; i++) {
          console.log(`Buffered range ${i}: ${video.buffered.start(i).toFixed(2)} - ${video.buffered.end(i).toFixed(2)}`);
        }
      } else {
        console.log('No buffered ranges!');
      }

      // Check if we actually reached the end of the video
      const serverDuration = (playbackInfo?.totalDurationMs || 0) / 1000;
      const videoDuration = video.duration || serverDuration;
      const isNearEnd = video.currentTime > videoDuration - 5; // Within 5 seconds of end

      console.log('Server duration:', serverDuration, 'Video duration:', videoDuration, 'Near end:', isNearEnd);

      if (!isNearEnd && hlsRef.current) {
        console.log('Video ended prematurely! Attempting recovery...');
        console.log(`Current: ${video.currentTime}s, Expected duration: ${serverDuration}s`);

        // Try to restart playback from current position
        const currentPos = video.currentTime;

        // Force HLS.js to reload
        hlsRef.current.startLoad();

        // After a brief delay, seek back slightly and play
        setTimeout(() => {
          if (video.paused) {
            const seekPos = Math.max(0, currentPos - 0.5);
            console.log('Recovery: seeking to', seekPos, 'and playing');
            video.currentTime = seekPos;
            video.play().catch(e => console.log('Recovery play failed:', e));
          }
        }, 500);
      }
    };

    // Handle error event - log and attempt recovery
    const handleError = (e: Event) => {
      console.error('Video element error:', video.error?.message, video.error?.code);
      if (hlsRef.current && !video.ended) {
        console.log('Attempting HLS recovery after video error');
        hlsRef.current.startLoad();
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('loadedmetadata', handleDurationChange);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('stalled', handleStalled);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('loadedmetadata', handleDurationChange);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('stalled', handleStalled);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
      if (stallRecoveryTimeout) {
        clearTimeout(stallRecoveryTimeout);
      }
      // Note: Don't destroy HLS on every effect re-run, only on unmount
    };
  }, [playbackInfo, videoMounted]);

  // Cleanup HLS on unmount only
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        // Clear the gap check interval if it exists
        if ((hlsRef.current as any)._gapCheckInterval) {
          clearInterval((hlsRef.current as any)._gapCheckInterval);
        }
        hlsRef.current.destroy();
        hlsRef.current = null;
        hlsStreamUrlRef.current = null;
        hlsVideoElementRef.current = null;
      }
    };
  }, []);

  // Handle seek from timeline
  const handleSeek = useCallback((timeMs: number) => {
    if (videoRef.current && playbackInfo) {
      const video = videoRef.current;
      const seekTimeSec = timeMs / 1000;
      // Use server-provided duration for clamping (more stable than video.duration)
      const maxDuration = (playbackInfo.totalDurationMs || 0) / 1000;
      const clampedSec = Math.max(0, Math.min(seekTimeSec, maxDuration - 1)); // Stay 1s from end

      console.log('Seeking to:', {
        timeMs,
        seekTimeSec,
        clampedSec,
        maxDuration,
        currentTime: video.currentTime,
        videoReadyState: video.readyState,
        videoDuration: video.duration,
        hlsAvailable: !!hlsRef.current,
        currentBuffered: video.buffered.length > 0 ?
          `${video.buffered.start(0)}-${video.buffered.end(0)}` : 'none'
      });

      // For HLS.js, force segment reload to ensure seeking works reliably
      // This is especially important for backward seeks where buffers might be stale
      if (hlsRef.current) {
        // Tell HLS.js to start loading from the new position
        hlsRef.current.startLoad(clampedSec);
      }

      // Set the new time
      video.currentTime = clampedSec;
      setCurrentTimeMs(clampedSec * 1000);

      // Simple play attempt with retry
      const attemptPlay = () => {
        video.play().catch(e => {
          console.log('Play attempt failed:', e.name, e.message);
          // Retry once after a short delay
          setTimeout(() => {
            video.play().catch(() => {});
          }, 200);
        });
      };

      // Wait briefly for HLS to process, then play
      setTimeout(attemptPlay, 100);
    }
  }, [playbackInfo]);

  // Skip forward/back by specified seconds
  const handleSkip = useCallback((seconds: number) => {
    if (videoRef.current && playbackInfo) {
      const newTimeMs = currentTimeMs + (seconds * 1000);
      handleSeek(newTimeMs);
    }
  }, [currentTimeMs, playbackInfo, handleSeek]);

  // Keyboard shortcuts for video controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          handleSkip(-5); // Skip back 5 seconds
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSkip(5); // Skip forward 5 seconds
          break;
        case ' ':
          e.preventDefault();
          if (videoRef.current) {
            if (videoRef.current.paused) {
              videoRef.current.play().catch(() => {});
            } else {
              videoRef.current.pause();
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSkip]);

  // Format duration for display
  const formatDuration = (ms: number) => {
    if (!ms || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Format date for display
  const formatDate = (ms: number) => {
    return new Date(ms).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Format time (HH:MM:SS)
  const formatTime = (ms: number) => {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Get platform icon
  const getPlatformIcon = (platform: string, sourceUrl?: string) => {
    const p = platform?.toLowerCase() || '';
    if (sourceUrl?.includes('playback.live-video.net')) return '🟢'; // Kick
    if (p.includes('twitch')) return '🟣';
    if (p.includes('kick')) return '🟢';
    return '📺';
  };

  // Get display name (clean up suffixes)
  const getDisplayName = (name: string, sourceUrl?: string) => {
    let displayName = name || 'Unknown';
    displayName = displayName.replace(/\s*\([^)]+\)\s*$/, '').trim();
    if ((displayName === 'Unknown' || displayName === 'Kick') && sourceUrl) {
      const twitchMatch = sourceUrl.match(/twitch\.tv\/([^/?]+)/i);
      if (twitchMatch) displayName = twitchMatch[1];
    }
    return displayName;
  };

  // Use timeline.startTime as the single source of truth for the reference point
  // This is the time the first event/recording started
  const recordingStartTime = useMemo(() => {
    // Prefer timeline.startTime as it represents when actual content starts
    // Fall back to playbackInfo.earliestRecording if timeline not available
    return timeline?.startTime || playbackInfo?.earliestRecording || 0;
  }, [timeline, playbackInfo]);

  // Filtered timeline based on time filter
  const filteredTimeline = useMemo((): TimelineData | null => {
    if (!timeline) return null;

    // Get filter time range
    let filterStart: number | null = null;
    let filterEnd: number | null = null;

    if (timeFilter.preset === 'custom') {
      filterStart = timeFilter.customStart;
      filterEnd = timeFilter.customEnd;
    } else {
      const presetRange = getPresetTimeRange(timeFilter.preset);
      filterStart = presetRange.start;
      filterEnd = presetRange.end;
    }

    // If no filter, return original timeline
    if (filterStart === null && filterEnd === null) {
      return timeline;
    }

    // Filter events that overlap with the time range
    const filteredEvents = timeline.events.filter(event => {
      const eventStart = event.startTime;
      const eventEnd = event.endTime;

      // Check if event overlaps with filter range
      if (filterStart !== null && filterEnd !== null) {
        return eventEnd >= filterStart && eventStart <= filterEnd;
      } else if (filterStart !== null) {
        return eventEnd >= filterStart;
      } else if (filterEnd !== null) {
        return eventStart <= filterEnd;
      }
      return true;
    });

    // Calculate new timeline boundaries
    const newStartTime = filterStart !== null
      ? Math.max(timeline.startTime, filterStart)
      : timeline.startTime;
    const newEndTime = filterEnd !== null
      ? Math.min(timeline.endTime, filterEnd)
      : timeline.endTime;

    return {
      ...timeline,
      startTime: newStartTime,
      endTime: newEndTime,
      events: filteredEvents
    };
  }, [timeline, timeFilter]);

  // Get current filter description for display
  const filterDescription = useMemo(() => {
    switch (timeFilter.preset) {
      case 'all': return 'All Data';
      case 'today': return 'Today';
      case 'yesterday': return 'Yesterday';
      case 'last_hour': return 'Last Hour';
      case 'last_6_hours': return 'Last 6 Hours';
      case 'last_24_hours': return 'Last 24 Hours';
      case 'custom': return 'Custom Range';
      default: return 'All Data';
    }
  }, [timeFilter.preset]);

  // Compute the current streamer based on playhead position
  // This is the SINGLE source of truth - pass this to all child components
  const currentStreamer = useMemo(() => {
    if (!timeline?.events || !recordingStartTime) return null;

    // Convert current video time (relative) to absolute timestamp
    const absoluteTimeMs = recordingStartTime + currentTimeMs;

    // Find all events that contain the current playhead position
    // Then pick the most specific one (smallest duration) to handle overlapping events
    // This fixes issues where active streams have endTime = Date.now() which spans everything
    let bestMatch: typeof timeline.events[0] | null = null;
    let bestMatchDuration = Infinity;

    for (const event of timeline.events) {
      if (absoluteTimeMs >= event.startTime && absoluteTimeMs <= event.endTime) {
        const eventDuration = event.endTime - event.startTime;
        // Prefer events with smaller duration (more specific match)
        // Also prefer events that start closer to the current time
        if (eventDuration < bestMatchDuration) {
          bestMatch = event;
          bestMatchDuration = eventDuration;
        }
      }
    }

    if (!bestMatch) return null;

    const event = bestMatch;
    const relativeStartMs = event.startTime - recordingStartTime;
    const relativeEndMs = event.endTime - recordingStartTime;
    const segmentDurationMs = event.endTime - event.startTime;
    const progressWithinSegment = Math.min(1, Math.max(0, (currentTimeMs - relativeStartMs) / segmentDurationMs));

    return {
      ...event,
      id: event.id || `event-${event.startTime}`,
      displayName: getDisplayName(event.name, event.sourceUrl),
      platformIcon: getPlatformIcon(event.platform, event.sourceUrl),
      absoluteStartTime: event.startTime,
      absoluteEndTime: event.endTime,
      relativeStartMs,
      relativeEndMs,
      segmentDurationMs,
      progressWithinSegment
    };
  }, [timeline, recordingStartTime, currentTimeMs]);

  // Only show loading spinner on initial load, not refreshes
  if (loading && !initialLoadComplete) {
    return (
      <div className="admin-recording-review loading">
        <div className="loading-spinner">Loading recordings...</div>
      </div>
    );
  }

  return (
    <div className="admin-recording-review fullscreen-player">
      {/* Header bar */}
      <div className="review-header-bar">
        <div className="header-left">
          <h2>Recording Review</h2>
          {playbackInfo && (
            <span className="recording-info">
              {formatDate(playbackInfo.earliestRecording)} - {formatDate(playbackInfo.latestRecording)}
              {' | '}
              {playbackInfo.totalChatMessages} chat messages
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            className={`header-btn ${showTimeFilter ? 'active' : ''} ${timeFilter.preset !== 'all' ? 'filter-active' : ''}`}
            onClick={() => setShowTimeFilter(!showTimeFilter)}
          >
            {filterDescription}
          </button>
          <button
            className={`header-btn ${showStreamers ? 'active' : ''}`}
            onClick={() => setShowStreamers(!showStreamers)}
          >
            {showStreamers ? 'Hide Streamers' : 'Streamers'}
          </button>
          <button
            className={`header-btn ${showChat ? 'active' : ''}`}
            onClick={() => setShowChat(!showChat)}
          >
            {showChat ? 'Hide Chat' : 'Show Chat'}
          </button>
          <button
            className={`header-btn ${viewMode === 'settings' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'settings' ? 'player' : 'settings')}
          >
            Settings
          </button>
          <button className="header-btn" onClick={() => fetchData(true)}>
            Refresh
          </button>
        </div>
      </div>

      {/* Time filter bar (collapsible) */}
      {showTimeFilter && (
        <div className="time-filter-bar">
          <div className="filter-presets">
            <button
              className={`preset-btn ${timeFilter.preset === 'all' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'all', customStart: null, customEnd: null })}
            >
              All Data
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'last_hour' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'last_hour', customStart: null, customEnd: null })}
            >
              Last Hour
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'last_6_hours' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'last_6_hours', customStart: null, customEnd: null })}
            >
              Last 6 Hours
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'last_24_hours' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'last_24_hours', customStart: null, customEnd: null })}
            >
              Last 24 Hours
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'today' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'today', customStart: null, customEnd: null })}
            >
              Today
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'yesterday' ? 'active' : ''}`}
              onClick={() => setTimeFilter({ preset: 'yesterday', customStart: null, customEnd: null })}
            >
              Yesterday
            </button>
            <button
              className={`preset-btn ${timeFilter.preset === 'custom' ? 'active' : ''}`}
              onClick={() => setTimeFilter(prev => ({ ...prev, preset: 'custom' }))}
            >
              Custom
            </button>
          </div>

          {/* Custom date/time inputs */}
          {timeFilter.preset === 'custom' && (
            <div className="custom-filter">
              <div className="custom-input-group">
                <label>From:</label>
                <input
                  type="datetime-local"
                  value={timeFilter.customStart ? new Date(timeFilter.customStart).toISOString().slice(0, 16) : ''}
                  onChange={(e) => {
                    const val = e.target.value ? new Date(e.target.value).getTime() : null;
                    setTimeFilter(prev => ({ ...prev, customStart: val }));
                  }}
                />
              </div>
              <div className="custom-input-group">
                <label>To:</label>
                <input
                  type="datetime-local"
                  value={timeFilter.customEnd ? new Date(timeFilter.customEnd).toISOString().slice(0, 16) : ''}
                  onChange={(e) => {
                    const val = e.target.value ? new Date(e.target.value).getTime() : null;
                    setTimeFilter(prev => ({ ...prev, customEnd: val }));
                  }}
                />
              </div>
              <button
                className="clear-custom-btn"
                onClick={() => setTimeFilter({ preset: 'all', customStart: null, customEnd: null })}
              >
                Clear
              </button>
            </div>
          )}

          {/* Filter summary */}
          {filteredTimeline && timeFilter.preset !== 'all' && (
            <div className="filter-summary">
              Showing {filteredTimeline.events.length} events
              {timeline && ` (of ${timeline.events.length} total)`}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="review-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {viewMode === 'settings' ? (
        <div className="settings-container">
          <ReviewSettings
            makeApiCall={makeApiCall}
            addLog={addLog}
            onRefresh={() => fetchData(true)}
          />
        </div>
      ) : !hasRecordings ? (
        <div className="no-recordings">
          <div className="no-recordings-icon">📹</div>
          <h3>No Recordings Available</h3>
          <p>Recording data will appear here once streams are captured.</p>
          <button onClick={() => fetchData()}>Check Again</button>
        </div>
      ) : (
        <div className={`player-layout ${showStreamers ? 'with-streamers' : ''} ${showChat ? 'with-chat' : ''}`}>
          {/* Streamers sidebar */}
          {showStreamers && (
            <div className="streamer-sidebar">
              <StreamerList
                timeline={filteredTimeline}
                currentTimeMs={currentTimeMs}
                recordingStartTime={recordingStartTime}
                currentStreamerId={currentStreamer?.id}
                onSeek={handleSeek}
                formatDuration={formatDuration}
              />
            </div>
          )}

          {/* Main video area */}
          <div className="video-area">
            {/* Now Playing indicator */}
            {currentStreamer && (
              <div className="now-playing-bar" style={{ borderLeftColor: currentStreamer.color }}>
                <div className="now-playing-left">
                  <span className="now-playing-label">NOW PLAYING</span>
                  <span className="now-playing-icon">{currentStreamer.platformIcon}</span>
                  <span className="now-playing-name">{currentStreamer.displayName}</span>
                  {currentStreamer.isActive && <span className="live-indicator">LIVE</span>}
                </div>
                <div className="now-playing-right">
                  <div className="now-playing-times">
                    <span className="time-label">Started:</span>
                    <span className="time-value">{formatTime(currentStreamer.absoluteStartTime)}</span>
                    <span className="time-separator">-</span>
                    <span className="time-label">Ends:</span>
                    <span className="time-value">{formatTime(currentStreamer.absoluteEndTime)}</span>
                  </div>
                  <div className="now-playing-duration">
                    <span className="duration-label">Duration:</span>
                    <span className="duration-value">{formatDuration(currentStreamer.segmentDurationMs)}</span>
                  </div>
                </div>
                <div className="now-playing-progress">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${currentStreamer.progressWithinSegment * 100}%`,
                      backgroundColor: currentStreamer.color
                    }}
                  />
                </div>
              </div>
            )}

            <div className="video-container">
              <video
                ref={videoRefCallback}
                controls
                autoPlay
                playsInline
              />
            </div>

            {/* Playback info bar */}
            <div className="playback-info-bar">
              <div className="skip-controls">
                <button
                  className="skip-btn"
                  onClick={() => handleSkip(-5)}
                  title="Skip back 5 seconds (←)"
                >
                  ⏪ 5s
                </button>
                <button
                  className="skip-btn"
                  onClick={() => handleSkip(5)}
                  title="Skip forward 5 seconds (→)"
                >
                  5s ⏩
                </button>
              </div>
              <div className="time-display">
                <span className="current-time">{formatDuration(currentTimeMs)}</span>
                <span className="separator">/</span>
                <span className="total-time">{formatDuration(playbackInfo?.totalDurationMs || 0)}</span>
              </div>
              <div className="playback-status">
                {isPlaying ? '▶ Playing' : '⏸ Paused'}
                <span className="keyboard-hint">(Space to toggle, ← → to skip)</span>
              </div>
            </div>

            {/* Timeline */}
            <PlaybackTimeline
              timeline={filteredTimeline}
              currentTimeMs={currentTimeMs}
              totalDurationMs={playbackInfo?.totalDurationMs || videoDurationMs || 0}
              recordingStartTime={recordingStartTime}
              onSeek={handleSeek}
              formatDuration={formatDuration}
            />
          </div>

          {/* Chat sidebar */}
          {showChat && (
            <div className="chat-sidebar">
              <SyncedChatReplay
                currentTimeMs={currentTimeMs}
                recordingStartTime={recordingStartTime}
                isPlaying={isPlaying}
                makeApiCall={makeApiCall}
                formatDuration={formatDuration}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminRecordingReview;
