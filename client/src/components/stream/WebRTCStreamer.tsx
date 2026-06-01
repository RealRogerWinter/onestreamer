import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { WebRTCClientAdapter } from '../../services/WebRTCClientAdapter';
import { ScreenCaptureService } from '../../services/ScreenCaptureService';
import { AudioMixer } from '../../services/AudioMixer';
import { VideoCompositor } from '../../services/VideoCompositor';
import AudioLevelMeter from '../audio/AudioLevelMeter';
import { AudioSettingsConfig, VideoSettingsConfig, ScreenShareSettingsConfig } from './StreamerSettings';
import CanvasEffectOverlay from '../canvas/CanvasEffectOverlay';
import { useStreamerViewManager } from '../../hooks/useStreamerViewManager';
import { resolutionConstraints } from '../../utils/resolutionConstraints';
import {
  StreamLoadingOverlay,
  StreamErrorOverlay,
  StreamIdlePreview,
} from './webrtcStreamer/StreamStatusOverlays';
import { ViewModeIndicator } from './webrtcStreamer/ViewModeIndicator';
import { webrtcVideoStyle } from './webrtcStreamer/videoStyles';
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
  const audioMixerRef = useRef<AudioMixer>(new AudioMixer());
  const videoCompositorRef = useRef<VideoCompositor>(new VideoCompositor());
  const currentVideoDeviceRef = useRef<string | undefined>(undefined);
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
      const getResolutionConstraints = () => resolutionConstraints(videoSettings.resolution);
      
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
        console.log('🎵 Audio device changed externally...', {
          isScreenSharing,
          isMixerActive: audioMixerRef.current.getIsActive()
        });

        if (isScreenSharing) {
          // During screen sharing, handle audio changes carefully
          if (audioMixerRef.current.getIsActive()) {
            // Mixer is active (mic + system audio) - update mic in mixer
            console.log('🎵 Screen sharing with mixer active - updating mic in mixer...');
            updateMicForMixer(externalAudioSettings.inputDeviceId);
          } else {
            // Screen sharing but mixer not active
            // This means either: no system audio, or mixWithMic disabled
            // Just update the stored camera stream's audio for when we switch back
            console.log('🎵 Screen sharing without mixer - updating stored camera audio...');
            updateStoredCameraAudio(externalAudioSettings.inputDeviceId);
          }
        } else {
          // Not screen sharing - normal audio track replacement
          replaceAudioTrack(externalAudioSettings.inputDeviceId);
        }
        setLocalAudioSettings(externalAudioSettings);
      }
    }
  }, [externalAudioSettings?.inputDeviceId, isStreaming, isScreenSharing]);

  // Update the stored camera stream's audio (for when we return from screen share)
  const updateStoredCameraAudio = async (newDeviceId: string) => {
    try {
      console.log('🎤 Updating stored camera audio for later...');

      const audioConstraints: any = {
        deviceId: { exact: newDeviceId },
        echoCancellation: audioSettings.echoCancellation,
        noiseSuppression: audioSettings.noiseSuppression,
        autoGainControl: audioSettings.autoGainControl,
        sampleRate: { ideal: audioSettings.sampleRate },
        channelCount: { ideal: audioSettings.channelCount }
      };

      const newMicStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      if (cameraStreamRef.current) {
        const oldAudioTrack = cameraStreamRef.current.getAudioTracks()[0];
        if (oldAudioTrack) {
          cameraStreamRef.current.removeTrack(oldAudioTrack);
          oldAudioTrack.stop();
        }
        const newAudioTrack = newMicStream.getAudioTracks()[0];
        if (newAudioTrack) {
          cameraStreamRef.current.addTrack(newAudioTrack);
        }
      }

      console.log('🎤 ✅ Stored camera audio updated');
    } catch (error) {
      console.error('🎤 ❌ Failed to update stored camera audio:', error);
    }
  };

  // Update microphone track in the AudioMixer during screen share
  const updateMicForMixer = async (newDeviceId: string) => {
    try {
      console.log('🎤 updateMicForMixer called', {
        newDeviceId,
        mixerActive: audioMixerRef.current.getIsActive(),
        hasCameraStream: !!cameraStreamRef.current
      });
      console.log('🎤 Getting new mic stream for mixer...');

      // Build audio constraints
      const audioConstraints: any = {
        deviceId: { exact: newDeviceId },
        echoCancellation: audioSettings.echoCancellation,
        noiseSuppression: audioSettings.noiseSuppression,
        autoGainControl: audioSettings.autoGainControl,
        sampleRate: { ideal: audioSettings.sampleRate },
        channelCount: { ideal: audioSettings.channelCount }
      };

      // Get new mic stream
      const newMicStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      // Update the camera stream ref with the new audio track
      if (cameraStreamRef.current) {
        // Remove old audio track from camera stream ref
        const oldAudioTrack = cameraStreamRef.current.getAudioTracks()[0];
        if (oldAudioTrack) {
          cameraStreamRef.current.removeTrack(oldAudioTrack);
          oldAudioTrack.stop();
        }
        // Add new audio track
        const newAudioTrack = newMicStream.getAudioTracks()[0];
        if (newAudioTrack) {
          cameraStreamRef.current.addTrack(newAudioTrack);
        }
      }

      // Update the AudioMixer with new mic track
      const newMicTrack = newMicStream.getAudioTracks()[0];
      if (newMicTrack) {
        await audioMixerRef.current.updateMicTrack(newMicTrack);
        console.log('🎤 ✅ Mic updated in mixer successfully');
      }

    } catch (error) {
      console.error('🎤 ❌ Failed to update mic for mixer:', error);
    }
  };

  // Watch for video device changes during streaming
  useEffect(() => {
    const newDeviceId = externalVideoSettings?.videoDeviceId || videoSettings.videoDeviceId;

    if (isStreaming && newDeviceId && newDeviceId !== currentVideoDeviceRef.current) {
      console.log('📹 Video device changed:', {
        from: currentVideoDeviceRef.current,
        to: newDeviceId,
        isScreenSharing,
        isPipActive: videoCompositorRef.current.getIsActive()
      });

      // Update the ref to track current device
      currentVideoDeviceRef.current = newDeviceId;

      // If screen sharing with PiP active, update the camera for PiP overlay
      if (isScreenSharing && videoCompositorRef.current.getIsActive()) {
        console.log('📹 Screen sharing with PiP - updating webcam overlay...');
        updateCameraForPiP(newDeviceId);
      } else if (!isScreenSharing) {
        // Normal camera replacement when not screen sharing
        replaceVideoTrack(newDeviceId);
      }
      // If screen sharing without PiP, just update the stored camera stream
      else if (isScreenSharing && !videoCompositorRef.current.getIsActive()) {
        console.log('📹 Screen sharing without PiP - updating stored camera...');
        updateStoredCameraVideo(newDeviceId);
      }
    }
  }, [externalVideoSettings?.videoDeviceId, videoSettings.videoDeviceId, isStreaming, isScreenSharing]);

  // Update stored camera video track (for when we return from screen share)
  const updateStoredCameraVideo = async (newDeviceId: string) => {
    try {
      console.log('📹 Updating stored camera video for later...');

      const getResolutionConstraints = () => resolutionConstraints(videoSettings.resolution);

      const videoConstraints: any = {
        deviceId: { exact: newDeviceId },
        ...getResolutionConstraints(),
        frameRate: { ideal: videoSettings.frameRate },
        aspectRatio: { ideal: 16/9 }
      };

      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });

      if (cameraStreamRef.current) {
        const oldVideoTrack = cameraStreamRef.current.getVideoTracks()[0];
        if (oldVideoTrack) {
          cameraStreamRef.current.removeTrack(oldVideoTrack);
          oldVideoTrack.stop();
        }
        const newVideoTrack = newVideoStream.getVideoTracks()[0];
        if (newVideoTrack) {
          cameraStreamRef.current.addTrack(newVideoTrack);
        }
      }

      console.log('📹 ✅ Stored camera video updated');
    } catch (error) {
      console.error('📹 ❌ Failed to update stored camera video:', error);
    }
  };

  // Update camera track for PiP during screen share
  const updateCameraForPiP = async (newDeviceId: string) => {
    try {
      console.log('📹 Getting new camera stream for PiP...');

      // Build video constraints based on current settings
      const getResolutionConstraints = () => resolutionConstraints(videoSettings.resolution);

      const videoConstraints: any = {
        deviceId: { exact: newDeviceId },
        ...getResolutionConstraints(),
        frameRate: { ideal: videoSettings.frameRate },
        aspectRatio: { ideal: 16/9 }
      };

      // Get new camera stream
      const newCameraStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: true // Also get audio for the camera stream
      });

      // Stop old camera stream tracks
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach(track => track.stop());
      }

      // Update camera stream ref
      cameraStreamRef.current = newCameraStream;

      // Update the VideoCompositor with new webcam track
      const newWebcamTrack = newCameraStream.getVideoTracks()[0];
      if (newWebcamTrack) {
        await videoCompositorRef.current.updateWebcamTrack(newWebcamTrack);
        console.log('📹 ✅ PiP webcam updated successfully');
      }

    } catch (error) {
      console.error('📹 ❌ Failed to update camera for PiP:', error);
    }
  };

  // Initialize StreamerViewManager for automatic view switching
  const { viewState } = useStreamerViewManager(videoRef, socket, isStreaming);

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
    mixWithMic: true,
    micGain: 100,
    systemGain: 100,
    displaySurface: 'monitor',
    // PiP defaults
    pipEnabled: false,  // Disabled by default
    pipPosition: 'bottom-right',
    pipSize: 25
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
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      const screenAudioTrack = screenStream.getAudioTracks()[0];

      console.log('🖥️ Screen stream obtained:', {
        videoTracks: screenStream.getVideoTracks().length,
        audioTracks: screenStream.getAudioTracks().length,
        hasScreenAudio: !!screenAudioTrack,
        audioEnabled: screenAudioTrack?.enabled,
        audioState: screenAudioTrack?.readyState,
        audioLabel: screenAudioTrack?.label,
        audioMixerWasActive: audioMixerRef.current.getIsActive()
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

      // Prepare the final stream to send
      let finalStream = screenStream;
      let finalVideoTrack: MediaStreamTrack = screenVideoTrack;
      let finalAudioTrack: MediaStreamTrack | null = screenAudioTrack;

      // Check if PiP (webcam overlay) is enabled and we have a camera stream
      const shouldUsePip = effectiveScreenShareSettings.pipEnabled !== false; // Default to true
      console.log('🎬 PiP check:', {
        pipEnabledSetting: effectiveScreenShareSettings.pipEnabled,
        shouldUsePip,
        hasCameraStream: !!cameraStreamRef.current,
        pipPosition: effectiveScreenShareSettings.pipPosition,
        pipSize: effectiveScreenShareSettings.pipSize
      });

      if (shouldUsePip && cameraStreamRef.current) {
        const webcamTrack = cameraStreamRef.current.getVideoTracks()[0];

        if (webcamTrack && webcamTrack.readyState === 'live') {
          console.log('🎬 Compositing screen share with webcam overlay...');

          // Use VideoCompositor to overlay webcam on screen
          const compositedStream = await videoCompositorRef.current.composite(
            screenVideoTrack,
            webcamTrack,
            {
              pipEnabled: true,
              pipPosition: effectiveScreenShareSettings.pipPosition || 'bottom-right',
              pipSize: effectiveScreenShareSettings.pipSize || 25,
              pipBorderRadius: 8,
              pipPadding: 20,
              frameRate: 30
            }
          );

          if (compositedStream) {
            finalVideoTrack = compositedStream.getVideoTracks()[0];
            console.log('🎬 ✅ Video composition active with PiP overlay');
          } else {
            console.warn('🎬 ⚠️ Video composition failed, using screen video only');
          }
        } else {
          console.log('🎬 Webcam track not available for PiP, using screen video only');
        }
      }

      // If mixWithMic is enabled (default: true) and we have both system audio and mic, mix them
      const shouldMixWithMic = effectiveScreenShareSettings.mixWithMic !== false; // Default to true
      const micTrackForMix = cameraStreamRef.current?.getAudioTracks()[0];
      console.log('🎚️ Mix with mic check:', {
        mixWithMicSetting: effectiveScreenShareSettings.mixWithMic,
        shouldMixWithMic,
        hasScreenAudio: !!screenAudioTrack,
        screenAudioState: screenAudioTrack?.readyState,
        hasCameraStream: !!cameraStreamRef.current,
        hasMicTrack: !!micTrackForMix,
        micTrackState: micTrackForMix?.readyState,
        micTrackLabel: micTrackForMix?.label
      });

      if (shouldMixWithMic && screenAudioTrack && cameraStreamRef.current) {
        const micTrack = cameraStreamRef.current.getAudioTracks()[0];

        if (micTrack && micTrack.readyState === 'live') {
          // Convert 0-100 to 0-1 for gain values
          const micGain = (effectiveScreenShareSettings.micGain ?? 100) / 100;
          const systemGain = (effectiveScreenShareSettings.systemGain ?? 100) / 100;

          console.log('🎚️ Mixing system audio with microphone...', { micGain, systemGain });

          // Use AudioMixer to combine mic + system audio
          const mixedAudioTrack = await audioMixerRef.current.mix(micTrack, screenAudioTrack, {
            micGain,
            systemGain
          });

          if (mixedAudioTrack) {
            finalAudioTrack = mixedAudioTrack;
            console.log('🎚️ ✅ Audio mixing active');
          } else {
            console.warn('🎚️ ⚠️ Audio mixing failed, using system audio only');
          }
        } else {
          console.log('🎚️ Mic track not available for mixing, using system audio only');
        }
      }

      // Build the final stream with composited video and mixed audio
      finalStream = new MediaStream();
      finalStream.addTrack(finalVideoTrack);
      if (finalAudioTrack) {
        finalStream.addTrack(finalAudioTrack);
      }

      console.log('🖥️ Final stream created:', {
        videoTracks: finalStream.getVideoTracks().length,
        audioTracks: finalStream.getAudioTracks().length,
        finalAudioTrackId: finalAudioTrack?.id,
        finalAudioTrackState: finalAudioTrack?.readyState,
        finalAudioTrackLabel: finalAudioTrack?.label,
        hasPiP: videoCompositorRef.current.getIsActive(),
        hasAudioMix: audioMixerRef.current.getIsActive(),
        originalScreenAudioId: screenAudioTrack?.id
      });

      // Switch to screen share in WebRTC
      console.log('🖥️ Switching main video to screen share');
      await mediasoupClientRef.current.switchToScreenShare(finalStream);

      // Update local preview to show screen
      if (videoRef.current) {
        videoRef.current.srcObject = finalStream;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          console.warn('Video play after screen share failed:', playErr);
        }
      }

      streamRef.current = finalStream;
      onScreenShareChange?.(true);
      console.log('✅ Screen share started successfully');

    } catch (error: any) {
      console.error('❌ Failed to start screen share:', error);

      // Clean up on failure - use cleanup() to clear callback too
      screenCaptureRef.current.cleanup();
      videoCompositorRef.current.cleanup();
      audioMixerRef.current.cleanup();

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
      // Stop screen capture first (this stops the source)
      screenCaptureRef.current.stopScreenShare();

      // If we have a stored camera stream, switch back to it BEFORE cleaning up mixers
      // This ensures seamless audio transition for viewers
      if (cameraStreamRef.current && mediasoupClientRef.current) {
        // Check if camera stream is still active
        const videoTrack = cameraStreamRef.current.getVideoTracks()[0];
        const audioTrack = cameraStreamRef.current.getAudioTracks()[0];

        console.log('🖥️ Camera stream state:', {
          hasVideo: !!videoTrack,
          videoState: videoTrack?.readyState,
          hasAudio: !!audioTrack,
          audioState: audioTrack?.readyState
        });

        if (videoTrack && videoTrack.readyState === 'live') {
          console.log('🖥️ Switching back to camera...');

          // Switch to camera FIRST - this replaces the tracks in LiveKit
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
        }
      }

      // Clean up video compositor AFTER switching (so PiP doesn't cut out early)
      videoCompositorRef.current.cleanup();

      // Clean up audio mixer AFTER switching (so mixed audio doesn't cut out early)
      audioMixerRef.current.cleanup();

      onScreenShareChange?.(false);
      console.log('✅ Screen share stopped');

    } catch (error: any) {
      console.error('❌ Failed to stop screen share:', error);
      // Use cleanup() to ensure callback is cleared on error
      screenCaptureRef.current.cleanup();
      videoCompositorRef.current.cleanup();
      audioMixerRef.current.cleanup();
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

  // Update audio mixer gains in real-time when settings change during screen share
  useEffect(() => {
    if (isScreenSharing && audioMixerRef.current.getIsActive()) {
      const micGain = (effectiveScreenShareSettings.micGain ?? 100) / 100;
      const systemGain = (effectiveScreenShareSettings.systemGain ?? 100) / 100;

      console.log('🎚️ Updating mixer gains:', { micGain, systemGain });
      audioMixerRef.current.setMicGain(micGain);
      audioMixerRef.current.setSystemGain(systemGain);
    }
  }, [isScreenSharing, effectiveScreenShareSettings.micGain, effectiveScreenShareSettings.systemGain]);

  // Update PiP options (position, size) in real-time when settings change during screen share
  useEffect(() => {
    if (isScreenSharing && videoCompositorRef.current.getIsActive()) {
      console.log('🎬 Updating PiP options:', {
        position: effectiveScreenShareSettings.pipPosition,
        size: effectiveScreenShareSettings.pipSize
      });
      videoCompositorRef.current.updateOptions({
        pipPosition: effectiveScreenShareSettings.pipPosition || 'bottom-right',
        pipSize: effectiveScreenShareSettings.pipSize || 25
      });
    }
  }, [isScreenSharing, effectiveScreenShareSettings.pipPosition, effectiveScreenShareSettings.pipSize]);

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
      const getResolutionConstraints = (resolution: string) => resolutionConstraints(resolution);
      
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

      // Track the current video device ID
      currentVideoDeviceRef.current = videoSettings.videoDeviceId;

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

    // Always clean up screen sharing resources - use cleanup() to clear callback too
    // Don't just check isActive() - the stream may have died but callback still registered
    screenCaptureRef.current.cleanup();
    videoCompositorRef.current.cleanup();
    audioMixerRef.current.cleanup();

    // Reset device tracking ref
    currentVideoDeviceRef.current = undefined;

    // Notify parent if screen sharing was active
    onScreenShareChange?.(false);

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
      
      <StreamLoadingOverlay isLoading={isLoading} />

      <StreamErrorOverlay error={error} />

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
        style={webrtcVideoStyle}
      />

      {/* View Mode Indicator */}
      <ViewModeIndicator
        visible={isStreaming && viewState.mode === 'self-stream'}
        activeEffectsCount={viewState.activeEffects.length}
      />

      <StreamIdlePreview show={!isStreaming && !isLoading && !error} />
      
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