import { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import authService from '../../../services/AuthService';
import { PlaybackInfo } from './types';

interface UseHlsPlayer {
  videoRefCallback: (node: HTMLVideoElement | null) => void;
  currentTimeMs: number;
  setCurrentTimeMs: React.Dispatch<React.SetStateAction<number>>;
  videoDurationMs: number;
  isPlaying: boolean;
  handleSeek: (timeMs: number) => void;
  handleSkip: (seconds: number) => void;
}

// Owns the HLS.js playback pipeline: video element wiring, HLS init/recovery,
// gap nudging, seek/skip, and keyboard shortcuts. This is a verbatim move of the
// original component's video/HLS effects and callbacks so playback behavior is
// unchanged. (In jsdom the hls.js mock + missing media pipeline make these
// effects effectively no-ops, which is why the characterization test mocks
// hls.js and never exercises real playback.)
export function useHlsPlayer(playbackInfo: PlaybackInfo | null): UseHlsPlayer {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsStreamUrlRef = useRef<string | null>(null);
  const hlsVideoElementRef = useRef<HTMLVideoElement | null>(null); // Track which video element HLS is attached to

  const [videoMounted, setVideoMounted] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

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

  return {
    videoRefCallback,
    currentTimeMs,
    setCurrentTimeMs,
    videoDurationMs,
    isPlaying,
    handleSeek,
    handleSkip,
  };
}
