import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { WebRTCClientAdapter } from '../services/WebRTCClientAdapter';
import { ScreenCaptureService } from '../services/ScreenCaptureService';
import AudioLevelMeter from './AudioLevelMeter';
import { AudioSettingsConfig, VideoSettingsConfig, ScreenShareSettingsConfig } from './StreamerSettings';
import CanvasEffectOverlay from './canvas/CanvasEffectOverlay';
import { useStreamerViewManager } from '../hooks/useStreamerViewManager';
import { useVisualFxProcessor } from '../hooks/useVisualFxProcessor';
import './WebRTCViewer.css';

interface WebRTCStreamerProps {
  socket: Socket;
  isStreaming: boolean;
  onStreamStart?: () => void;
  onStreamStop?: () => void;
  className?: string;
  audioSettings?: AudioSettingsConfig;
  onAudioSettingsChange?: (settings: AudioSettingsConfig) => void;
  videoSettings?: VideoSettingsConfig;
  onVideoSettingsChange?: (settings: VideoSettingsConfig) => void;
  screenShareSettings?: ScreenShareSettingsConfig;
  isScreenSharing?: boolean;
  onScreenShareChange?: (isSharing: boolean) => void;
  onScreenShareMethodsReady?: (methods: { startScreenShare: () => void; stopScreenShare: () => void }) => void;
}

const WebRTCStreamer: React.FC<WebRTCStreamerProps> = ({
  socket,
  isStreaming,
  onStreamStart,
  onStreamStop,
  className = '',
  audioSettings: externalAudioSettings,
  onAudioSettingsChange: externalOnAudioSettingsChange,
  videoSettings: externalVideoSettings,
  onVideoSettingsChange: externalOnVideoSettingsChange,
  screenShareSettings,
  isScreenSharing = false,
  onScreenShareChange,
  onScreenShareMethodsReady
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const mediasoupClientRef = useRef<WebRTCClientAdapter | null>(null);
  const screenCaptureRef = useRef<ScreenCaptureService>(new ScreenCaptureService());
  const isProcessingRef = useRef(false);
  const lastStreamAttemptRef = useRef(0);
  const STREAM_DEBOUNCE_TIME = 2000; // 2 seconds between attempts
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAudioMeter, setShowAudioMeter] = useState(true);
  
  // Load audio settings from localStorage or use defaults
  const loadAudioSettings = (): AudioSettingsConfig => {
    const saved = localStorage.getItem('streamerSettings');
    if (saved) {
      try {
        const settings = JSON.parse(saved);
        return settings.audio || {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
          profile: 'raw',
          inputDeviceId: undefined,
          outputDeviceId: undefined
        };
      } catch (e) {
        console.warn('Failed to load saved audio settings:', e);
      }
    }
    // Default to raw audio for best quality
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
      channelCount: 2,
      profile: 'raw',
      inputDeviceId: undefined,
      outputDeviceId: undefined
    };
  };
  
  // Load video settings from localStorage or use defaults
  const loadVideoSettings = (): VideoSettingsConfig => {
    const saved = localStorage.getItem('streamerSettings');
    if (saved) {
      try {
        const settings = JSON.parse(saved);
        return settings.video || {
          resolution: '720p',
          frameRate: 30,
          bitrate: 1500000,
          facingMode: 'user',
          videoEnabled: true,
          mirror: false
        };
      } catch (e) {
        console.warn('Failed to load saved video settings:', e);
      }
    }
    return {
      resolution: '720p',
      frameRate: 30,
      bitrate: 1500000,
      facingMode: 'user',
      videoEnabled: true,
      mirror: false
    };
  };
  
  // Use external settings if provided, otherwise use local state
  const [localAudioSettings, setLocalAudioSettings] = useState<AudioSettingsConfig>(loadAudioSettings());
  const [localVideoSettings, setLocalVideoSettings] = useState<VideoSettingsConfig>(loadVideoSettings());
  const audioSettings = externalAudioSettings || localAudioSettings;
  const videoSettings = externalVideoSettings || localVideoSettings;
  
  // Replace audio track in real-time
  const replaceAudioTrack = async (newDeviceId: string) => {
    // console.log('🎤 Replacing audio track with device:', newDeviceId);
    
    if (!streamRef.current) {
      console.warn('No active stream to replace audio track');
      return;
    }

    try {
      // Build audio constraints with new device
      const audioConstraints: any = {
        deviceId: { exact: newDeviceId },
        // Standard W3C constraints
        echoCancellation: audioSettings.echoCancellation,
        noiseSuppression: audioSettings.noiseSuppression,
        autoGainControl: audioSettings.autoGainControl,
        sampleRate: { ideal: audioSettings.sampleRate },
        channelCount: { ideal: audioSettings.channelCount },
        sampleSize: { ideal: 16 },
        latency: { ideal: 0.01 },
        
        // Disable all voice activity detection
        voiceActivityDetection: false
      };

      // Log constraints to debug
      // console.log('🎤 Replacing audio with constraints:', audioConstraints);
      
      // Get new audio stream
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      const newAudioTrack = newStream.getAudioTracks()[0];
      const oldAudioTrack = streamRef.current.getAudioTracks()[0];

      if (oldAudioTrack && newAudioTrack) {
        // Replace track in the stream
        streamRef.current.removeTrack(oldAudioTrack);
        streamRef.current.addTrack(newAudioTrack);
        
        // Replace in MediaSoup if active
        if (mediasoupClientRef.current && mediasoupClientRef.current.hasAudioProducer) {
          await mediasoupClientRef.current.replaceAudioTrack(newAudioTrack);
        }
        
        // Stop old track
        oldAudioTrack.stop();
        
        // Audio track replaced successfully
      }
    } catch (error) {
      console.error('❌ Failed to replace audio track:', error);
    }
  };

  // Replace video track in real-time
  const replaceVideoTrack = async (newDeviceId: string) => {
    // console.log('📹 Replacing video track with device:', newDeviceId);
    // console.log('📹 Current video settings:', videoSettings);
    
    if (!streamRef.current) {
      console.warn('No active stream to replace video track');
      return;
    }

    try {
      // Log current tracks before replacement
      // console.log('📹 Current video tracks:', streamRef.current.getVideoTracks());
      
      // Build video constraints based on settings
      const getResolutionConstraints = () => {
        switch (videoSettings.resolution) {
          case '480p':
            return { width: { ideal: 854 }, height: { ideal: 480 } };
          case '720p':
            return { width: { ideal: 1280 }, height: { ideal: 720 } };
          default:
            return { width: { ideal: 1280 }, height: { ideal: 720 } };
        }
      };
      
      const videoConstraints: any = {
        deviceId: { exact: newDeviceId },
        ...getResolutionConstraints(),
        frameRate: { ideal: videoSettings.frameRate },
        aspectRatio: { ideal: 16/9 }
      };

      // console.log('📹 Requesting new video stream with constraints:', videoConstraints);

      // Get new video stream
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = streamRef.current.getVideoTracks()[0];

      // console.log('📹 New video track:', newVideoTrack);
      // console.log('📹 Old video track:', oldVideoTrack);

      if (oldVideoTrack && newVideoTrack) {
        // Replace track in the stream
        streamRef.current.removeTrack(oldVideoTrack);
        streamRef.current.addTrack(newVideoTrack);
        
        // console.log('📹 Track replaced in stream, updating video element...');
        
        // Update video element - need to force refresh
        if (videoRef.current) {
          // Store current time and playback state
          const wasPaused = videoRef.current.paused;
          
          // Detach and reattach the stream to force update
          videoRef.current.srcObject = null;
          await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
          videoRef.current.srcObject = streamRef.current;
          
          // Restore playback if it was playing
          if (!wasPaused) {
            try {
              await videoRef.current.play();
              // console.log('📹 Video element updated and playing');
            } catch (playErr) {
              console.error('📹 Error playing video after track replacement:', playErr);
            }
          }
        }
        
        // Replace in MediaSoup if active
        if (mediasoupClientRef.current && mediasoupClientRef.current.hasVideoProducer) {
          // console.log('📹 Replacing track in MediaSoup producer...');
          await mediasoupClientRef.current.replaceVideoTrack(newVideoTrack);
          // console.log('📹 MediaSoup track replaced');
        }
        
        // Stop old track
        oldVideoTrack.stop();
        // console.log('📹 Old track stopped');
        
        // console.log('✅ Video track replaced successfully');
      } else {
        console.warn('📹 Missing tracks - old:', !!oldVideoTrack, 'new:', !!newVideoTrack);
      }
    } catch (error) {
      console.error('❌ Failed to replace video track:', error);
    }
  };

  // Watch for audio device changes during streaming
  useEffect(() => {
    if (isStreaming && externalAudioSettings) {
      // Check if device changed
      if (localAudioSettings.inputDeviceId !== externalAudioSettings.inputDeviceId && externalAudioSettings.inputDeviceId) {
        // console.log('🎵 Audio device changed externally, replacing track...');
        replaceAudioTrack(externalAudioSettings.inputDeviceId);
        setLocalAudioSettings(externalAudioSettings);
      }
    }
  }, [externalAudioSettings?.inputDeviceId, isStreaming]);

  // Watch for video device changes during streaming
  useEffect(() => {
    if (isStreaming && externalVideoSettings) {
      // Check if device changed
      if (localVideoSettings.videoDeviceId !== externalVideoSettings.videoDeviceId && externalVideoSettings.videoDeviceId) {
        // console.log('📹 Video device changed externally, replacing track...');
        replaceVideoTrack(externalVideoSettings.videoDeviceId);
        setLocalVideoSettings(externalVideoSettings);
      }
    }
  }, [externalVideoSettings?.videoDeviceId, isStreaming]);

  // Save audio settings when they change
  const handleAudioSettingsChange = async (newSettings: AudioSettingsConfig) => {
    const oldSettings = audioSettings;
    
    if (externalOnAudioSettingsChange) {
      externalOnAudioSettingsChange(newSettings);
    } else {
      setLocalAudioSettings(newSettings);
      const current = localStorage.getItem('streamerSettings');
      const settings = current ? JSON.parse(current) : {};
      settings.audio = newSettings;
      localStorage.setItem('streamerSettings', JSON.stringify(settings));
    }
    // console.log('🎵 Audio settings saved:', newSettings);
    
    // If streaming and any audio setting changed that requires track replacement (for local settings only)
    if (!externalOnAudioSettingsChange && isStreaming) {
      // Check if any audio processing setting changed or device changed
      const processingChanged = 
        oldSettings.echoCancellation !== newSettings.echoCancellation ||
        oldSettings.noiseSuppression !== newSettings.noiseSuppression ||
        oldSettings.autoGainControl !== newSettings.autoGainControl;
      
      const deviceChanged = oldSettings.inputDeviceId !== newSettings.inputDeviceId && newSettings.inputDeviceId;
      
      if (processingChanged || deviceChanged) {
        // Use the current device ID or the new one if changed
        const deviceId = newSettings.inputDeviceId || oldSettings.inputDeviceId;
        if (deviceId) {
          await replaceAudioTrack(deviceId);
        }
      }
    }
  };
  
  // Save video settings when they change
  const handleVideoSettingsChange = async (newSettings: VideoSettingsConfig) => {
    const oldSettings = videoSettings;
    
    // console.log('📹 handleVideoSettingsChange called');
    // console.log('📹 Old settings:', oldSettings);
    // console.log('📹 New settings:', newSettings);
    // console.log('📹 Is streaming:', isStreaming);
    // console.log('📹 Device changed:', oldSettings.videoDeviceId !== newSettings.videoDeviceId);
    
    if (externalOnVideoSettingsChange) {
      externalOnVideoSettingsChange(newSettings);
    } else {
      setLocalVideoSettings(newSettings);
      const current = localStorage.getItem('streamerSettings');
      const settings = current ? JSON.parse(current) : {};
      settings.video = newSettings;
      localStorage.setItem('streamerSettings', JSON.stringify(settings));
    }
    // console.log('📹 Video settings saved:', newSettings);
    
    // If streaming and device changed, replace the track in real-time (for local settings only)
    if (!externalOnVideoSettingsChange && isStreaming && oldSettings.videoDeviceId !== newSettings.videoDeviceId && newSettings.videoDeviceId) {
      // console.log('📹 Triggering video track replacement...');
      await replaceVideoTrack(newSettings.videoDeviceId);
    } else if (externalOnVideoSettingsChange) {
      // console.log('📹 Using external handler, track replacement will be handled by useEffect');
    } else {
      // console.log('📹 Not replacing track - streaming:', isStreaming, 'device changed:', oldSettings.videoDeviceId !== newSettings.videoDeviceId);
    }
  };

  // Initialize StreamerViewManager for automatic view switching
  const { viewState, manager } = useStreamerViewManager(videoRef, socket, isStreaming);
  
  // Initialize Visual FX processor for streamer preview
  const visualFxProcessor = useVisualFxProcessor(videoRef, socket, true);

  useEffect(() => {
    if (isStreaming) {
      startStreaming();
    } else {
      stopStreaming();
    }

    return () => {
      cleanup();
    };
  }, [isStreaming]);

  // Get default screen share settings
  const getDefaultScreenShareSettings = (): ScreenShareSettingsConfig => ({
    cursor: 'always',
    audio: false,
    displaySurface: 'monitor'
  });

  // Get effective screen share settings
  const effectiveScreenShareSettings = screenShareSettings || getDefaultScreenShareSettings();

  // Start screen sharing
  const startScreenShare = useCallback(async () => {
    console.log('🖥️ Starting screen share...');

    if (!isStreaming) {
      console.warn('Cannot start screen share - not streaming');
      return;
    }

    if (!mediasoupClientRef.current) {
      console.warn('Cannot start screen share - no WebRTC client');
      return;
    }

    try {
      // Get screen stream with settings
      console.log('🖥️ Screen share settings:', effectiveScreenShareSettings);
      const screenStream = await screenCaptureRef.current.getScreenStream({
        cursor: effectiveScreenShareSettings.cursor,
        // Don't pass displaySurface - let browser show all options (screen, window, tab)
        // This is important for Windows system audio capture from entire screen
        audio: effectiveScreenShareSettings.audio,
        systemAudio: effectiveScreenShareSettings.audio ? 'include' : 'exclude',
      });

      // Log what we got
      console.log('🖥️ Screen stream obtained:', {
        videoTracks: screenStream.getVideoTracks().length,
        audioTracks: screenStream.getAudioTracks().length,
        audioEnabled: screenStream.getAudioTracks()[0]?.enabled,
        audioLabel: screenStream.getAudioTracks()[0]?.label
      });

      // Set up callback for when user stops sharing via browser UI
      screenCaptureRef.current.onStreamEnd(() => {
        console.log('🖥️ Screen share ended by user');
        stopScreenShare();
      });

      // Store current camera stream for later
      if (streamRef.current) {
        cameraStreamRef.current = streamRef.current;
      }

      // Switch to screen share in WebRTC
      console.log('🖥️ Switching main video to screen share');
      await mediasoupClientRef.current.switchToScreenShare(screenStream);

      // Update local preview to show screen
      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          console.warn('Video play after screen share failed:', playErr);
        }
      }

      streamRef.current = screenStream;
      onScreenShareChange?.(true);
      console.log('✅ Screen share started successfully');

    } catch (error: any) {
      console.error('❌ Failed to start screen share:', error);

      // Clean up on failure
      screenCaptureRef.current.stopScreenShare();

      // Show user-friendly error
      if (!error.message.includes('cancelled') && !error.message.includes('denied')) {
        setError(`Screen share failed: ${error.message}`);
        setTimeout(() => setError(null), 5000);
      }
    }
  }, [isStreaming, effectiveScreenShareSettings, onScreenShareChange]);

  // Stop screen sharing
  const stopScreenShare = useCallback(async () => {
    console.log('🖥️ Stopping screen share...');

    try {
      // Stop screen capture
      screenCaptureRef.current.stopScreenShare();

      // If we have a stored camera stream, switch back to it
      if (cameraStreamRef.current && mediasoupClientRef.current) {
        // Check if camera stream is still active
        const videoTrack = cameraStreamRef.current.getVideoTracks()[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          console.log('🖥️ Switching back to camera...');
          await mediasoupClientRef.current.switchToCamera(cameraStreamRef.current);

          // Update preview
          if (videoRef.current) {
            videoRef.current.srcObject = cameraStreamRef.current;
            try {
              await videoRef.current.play();
            } catch (playErr) {
              console.warn('Video play after camera restore failed:', playErr);
            }
          }

          streamRef.current = cameraStreamRef.current;
        } else {
          console.log('🖥️ Camera stream expired, need to restart');
          // Camera stream is dead, need to restart streaming
        }
      }

      onScreenShareChange?.(false);
      console.log('✅ Screen share stopped');

    } catch (error: any) {
      console.error('❌ Failed to stop screen share:', error);
      onScreenShareChange?.(false);
    }
  }, [onScreenShareChange]);

  // Expose screen share methods to parent
  useEffect(() => {
    if (onScreenShareMethodsReady) {
      onScreenShareMethodsReady({
        startScreenShare,
        stopScreenShare
      });
    }
  }, [onScreenShareMethodsReady, startScreenShare, stopScreenShare]);

  const startStreaming = async () => {
    // Prevent multiple simultaneous stream starts
    if (isProcessingRef.current) {
      // console.log('🎬 WEBRTC STREAMER: Already processing, skipping...');
      return;
    }

    // Debounce rapid stream attempts
    const now = Date.now();
    if (now - lastStreamAttemptRef.current < STREAM_DEBOUNCE_TIME) {
      // console.log('🎬 WEBRTC STREAMER: Stream attempt too soon, debouncing...');
      return;
    }
    lastStreamAttemptRef.current = now;

    try {
      isProcessingRef.current = true;
      setIsLoading(true);
      setError(null);
      
      // console.log('🎬 WEBRTC STREAMER: Starting stream...');

      // Get user media with user-configured audio settings
      // console.log('📷 WEBRTC STREAMER: Requesting camera access...');
      // console.log('🎵 Audio settings:', audioSettings);
      
      // Build audio constraints with device selection
      const audioConstraints: any = {
        // Standard W3C constraints
        echoCancellation: audioSettings.echoCancellation,
        noiseSuppression: audioSettings.noiseSuppression,
        autoGainControl: audioSettings.autoGainControl,
        sampleRate: { ideal: audioSettings.sampleRate },
        channelCount: { ideal: audioSettings.channelCount },
        sampleSize: { ideal: 16 },
        latency: { ideal: 0.01 }, // Low latency for real-time
        
        // Always disable VAD to prevent audio cutoff
        voiceActivityDetection: false
      };

      // Add device ID if specified
      if (audioSettings.inputDeviceId) {
        audioConstraints.deviceId = { exact: audioSettings.inputDeviceId };
      }

      // Build video constraints based on settings
      const getResolutionConstraints = (resolution: string) => {
        switch (resolution) {
          case '480p':
            return { width: { ideal: 854 }, height: { ideal: 480 } };
          case '720p':
            return { width: { ideal: 1280 }, height: { ideal: 720 } };
          default:
            return { width: { ideal: 1280 }, height: { ideal: 720 } };
        }
      };
      
      let videoConstraints: any = false;
      if (videoSettings.videoEnabled) {
        videoConstraints = {
          ...getResolutionConstraints(videoSettings.resolution),
          frameRate: { ideal: videoSettings.frameRate },
          aspectRatio: { ideal: 16/9 }
        };
        
        // Add device ID if specified, otherwise use facingMode
        if (videoSettings.videoDeviceId) {
          videoConstraints.deviceId = { exact: videoSettings.videoDeviceId };
        } else {
          videoConstraints.facingMode = videoSettings.facingMode;
        }
      }
      
      // Check if mediaDevices is available (requires HTTPS or localhost)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('❌ WEBRTC STREAMER: navigator.mediaDevices not available. HTTPS or localhost required for WebRTC.');
        // Open info page in new tab
        window.open('/webrtc-info.html', '_blank');
        throw new Error('WebRTC requires HTTPS or localhost. See the opened tab for solutions.');
      }

      // Log the constraints being requested
      // console.log('🎤 WEBRTC STREAMER: Requesting getUserMedia with audio constraints:', audioConstraints);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints
      });

      // console.log('📷 WEBRTC STREAMER: Got media stream:', stream);
      // console.log('📷 WEBRTC STREAMER: Video tracks:', stream.getVideoTracks().length);
      // console.log('📷 WEBRTC STREAMER: Audio tracks:', stream.getAudioTracks().length);
      
      // Log actual audio track settings to verify what was applied
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.getSettings) {
        const actualSettings = audioTrack.getSettings();
        // console.log('🎤 WEBRTC STREAMER: Actual audio track settings:', actualSettings);
        // console.log('🎤 WEBRTC STREAMER: Requested vs Actual:');
        // console.log('   echoCancellation: requested=' + audioSettings.echoCancellation + ', actual=' + actualSettings.echoCancellation);
        // console.log('   noiseSuppression: requested=' + audioSettings.noiseSuppression + ', actual=' + actualSettings.noiseSuppression);
        // console.log('   autoGainControl: requested=' + audioSettings.autoGainControl + ', actual=' + actualSettings.autoGainControl);
      }

      streamRef.current = stream;

      // Display local video
      if (videoRef.current) {
        // console.log('📺 WEBRTC STREAMER: Setting video srcObject...');
        const video = videoRef.current;
        
        // Ensure clean video element state
        video.pause();
        video.srcObject = null;
        video.load();
        
        // Wait a moment for video element to reset
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Set new stream
        video.srcObject = stream;
        
        try {
          await video.play();
          // console.log('▶️ WEBRTC STREAMER: Video playing successfully');
        } catch (playError) {
          console.error('❌ WEBRTC STREAMER: Video play failed:', playError);
          // Don't fail the whole streaming process for local video playback issues
        }
      } else {
        console.error('❌ WEBRTC STREAMER: No video ref available');
      }

      // Cleanup any existing MediasoupClient first to avoid conflicts
      if (mediasoupClientRef.current) {
        // console.log('🧹 WEBRTC STREAMER: Cleaning up existing MediasoupClient...');
        try {
          await mediasoupClientRef.current.cleanup();
        } catch (cleanupError) {
          console.warn('⚠️ WEBRTC STREAMER: Error during pre-cleanup:', cleanupError);
        }
        mediasoupClientRef.current = null;
        // Wait longer for complete cleanup to prevent race conditions
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Create MediasoupClient for remote streaming with proper error handling
      try {
        // console.log('🌐 WEBRTC STREAMER: Initializing mediasoup for remote streaming...');
        const serverUrl = process.env.REACT_APP_API_URL || `https://${window.location.hostname}`;
        // console.log('🌐 WEBRTC STREAMER: Using server URL:', serverUrl);
        mediasoupClientRef.current = new WebRTCClientAdapter({ socket, serverUrl });
        
        // Add timeout for initialization
        const initPromise = mediasoupClientRef.current.initialize();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('MediaSoup initialization timeout')), 10000)
        );
        
        await Promise.race([initPromise, timeoutPromise]);
        // console.log('✅ WEBRTC STREAMER: Device initialized');
        
        // Create send transport with timeout
        const transportPromise = mediasoupClientRef.current.createSendTransport();
        const transportTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transport creation timeout')), 8000)
        );
        
        await Promise.race([transportPromise, transportTimeoutPromise]);
        // console.log('✅ WEBRTC STREAMER: Send transport created');
        
        // Start producing with timeout
        const producePromise = mediasoupClientRef.current.produce(stream);
        const produceTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Producer creation timeout')), 8000)
        );
        
        await Promise.race([producePromise, produceTimeoutPromise]);
        // console.log('✅ WEBRTC STREAMER: Started producing media');
        
      } catch (mediasoupError) {
        console.warn('⚠️ WEBRTC STREAMER: MediaSoup failed, but local video should still work:', mediasoupError);
        // Clean up failed MediaSoup client
        if (mediasoupClientRef.current) {
          try {
            await mediasoupClientRef.current.cleanup();
          } catch (cleanupErr) {
            console.warn('⚠️ WEBRTC STREAMER: Error cleaning up failed MediaSoup client:', cleanupErr);
          }
          mediasoupClientRef.current = null;
        }
        // Don't fail completely if mediasoup fails - local video should still show
      }
      
      setIsLoading(false);
      onStreamStart?.();
      // console.log('✅ WEBRTC STREAMER: Local video setup completed');
      
    } catch (error) {
      console.error('❌ WEBRTC STREAMER: Failed to start stream:', error);
      setError(error instanceof Error ? error.message : 'Failed to start streaming');
      setIsLoading(false);
      cleanup();
    } finally {
      // Reset processing flag after a delay to prevent rapid retries
      setTimeout(() => {
        isProcessingRef.current = false;
      }, 1000);
    }
  };

  const stopStreaming = async () => {
    // console.log('⏹️ WEBRTC STREAMER: Stopping stream...');
    await cleanup();
    onStreamStop?.();
  };

  const cleanup = async () => {
    // console.log('🧹 WEBRTC STREAMER: Cleaning up...');

    // Reset processing flag
    isProcessingRef.current = false;

    // Stop screen sharing if active
    if (screenCaptureRef.current.isActive()) {
      screenCaptureRef.current.stopScreenShare();
      onScreenShareChange?.(false);
    }

    // Clean up camera stream ref
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
    }

    if (mediasoupClientRef.current) {
      try {
        await mediasoupClientRef.current.stopProducing();
        await mediasoupClientRef.current.cleanup();
        // console.log('✅ WEBRTC STREAMER: MediaSoup cleaned up');
      } catch (error) {
        console.warn('⚠️ WEBRTC STREAMER: Error during MediaSoup cleanup:', error);
      }
      mediasoupClientRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        // console.log('🛑 WEBRTC STREAMER: Stopping track:', track.kind);
        track.stop();
      });
      streamRef.current = null;
    }
    
    if (videoRef.current) {
      // Pause first to avoid interruption errors
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.load(); // Reset video element
    }
    
    setIsLoading(false);
    setError(null);
  };

  return (
    <div className={`webrtc-streamer ${className}`} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Canvas Effect Overlay - Only render when streaming */}
      {isStreaming && (
        <CanvasEffectOverlay
          videoRef={videoRef}
          socket={socket}
          isActive={isStreaming}
          className="stream-effects-overlay"
        />
      )}
      
      {isLoading && (
        <div className="webrtc-loading">
          <div className="loading-spinner"></div>
          <p>Starting stream...</p>
        </div>
      )}
      
      {error && (
        <div className="webrtc-error">
          <p>⚠️ {error}</p>
        </div>
      )}
      
      <video
        ref={videoRef}
        className="webrtc-video"
        controls={false}
        autoPlay
        muted
        playsInline
        webkit-playsinline="true"
        crossOrigin="anonymous"
        preload="auto"
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000',
          objectFit: 'contain', // Changed to contain to show full frame without cropping
          // Removed horizontal flip - streamer now sees themselves as viewers see them
          // Mobile Chrome specific fixes
          WebkitTransform: 'translateZ(0)', // Force hardware acceleration without mirror
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden'
        }}
      />
      
      {/* View Mode Indicator */}
      {isStreaming && viewState.mode === 'self-stream' && (
        <div style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          background: 'rgba(255, 107, 107, 0.9)',
          color: 'white',
          padding: '8px 12px',
          borderRadius: '20px',
          fontSize: '12px',
          fontWeight: 'bold',
          zIndex: 1000,
          pointerEvents: 'none',
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          animation: 'pulse 2s infinite'
        }}>
          🔴 VIEWING PROCESSED STREAM ({viewState.activeEffects.length})
        </div>
      )}
      
      {!isStreaming && !isLoading && !error && (
        <div className="webrtc-preview">
          <p>Click "Start Streaming" to begin broadcasting</p>
        </div>
      )}
      
      {/* Audio Level Meter overlay on stream */}
      {isStreaming && streamRef.current && showAudioMeter && (
        <div 
          style={{
            position: 'absolute',
            bottom: '15px',
            left: '15px',
            right: '15px',
            zIndex: 20,
            pointerEvents: 'auto'
          }}
        >
          <AudioLevelMeter 
            stream={streamRef.current} 
            isActive={isStreaming}
            isVisible={showAudioMeter}
            onToggleVisibility={() => setShowAudioMeter(!showAudioMeter)}
          />
        </div>
      )}
      
      {/* Mini microphone icon when meter is hidden */}
      {isStreaming && streamRef.current && !showAudioMeter && (
        <div
          className="audio-meter-mini-icon"
          onClick={() => setShowAudioMeter(true)}
          title="Show audio meter"
        >
          <span>🎤</span>
        </div>
      )}
    </div>
  );
};

export default WebRTCStreamer;