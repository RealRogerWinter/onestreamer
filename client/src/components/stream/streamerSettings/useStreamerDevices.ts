import { useEffect, useRef, useState } from 'react';
import { resolutionConstraints } from '../../../utils/resolutionConstraints';
import { StreamerSettingsConfig } from './types';

// Encapsulates the media-device + preview/test side of StreamerSettings:
//   - device enumeration (audio in/out, video in) with permission handling
//   - microphone test (AudioContext level metering)
//   - camera preview (getUserMedia + <video> wiring)
// Extracted verbatim from StreamerSettings.tsx; identical effects/handlers,
// no behavior change.

interface UseStreamerDevicesArgs {
  settings: StreamerSettingsConfig;
  handleSettingsChange: (newSettings: StreamerSettingsConfig) => void;
  expanded: boolean;
  compact: boolean;
}

export function useStreamerDevices({
  settings,
  handleSettingsChange,
  expanded,
  compact,
}: UseStreamerDevicesArgs) {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);

  // Preview and test states
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [peakLevel, setPeakLevel] = useState<number>(0);
  const [isMicTesting, setIsMicTesting] = useState(false);
  const [isCameraPreview, setIsCameraPreview] = useState(false);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const peakHoldTimeRef = useRef<number>(0);

  // Cleanup function for media streams
  const cleanupStreams = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      setMicStream(null);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsMicTesting(false);
    setIsCameraPreview(false);
    setAudioLevel(0);
    setPeakLevel(0);
  };

  // Function to request permissions and get devices when user opens settings
  const requestPermissionsAndGetDevices = async () => {
    // Check if mediaDevices is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('Media devices not available. HTTPS or localhost required for WebRTC.');
      return;
    }

    try {
      // Request permissions first if needed
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          // Stop the stream immediately, we just needed permissions
          stream.getTracks().forEach(track => track.stop());
        });

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioIns = devices.filter(device => device.kind === 'audioinput');
      const audioOuts = devices.filter(device => device.kind === 'audiooutput');
      const videoIns = devices.filter(device => device.kind === 'videoinput');

      setAudioInputs(audioIns);
      setAudioOutputs(audioOuts);
      setVideoInputs(videoIns);

      // Set default devices if not already set
      let updatedSettings = { ...settings };
      let needsUpdate = false;

      if (!settings.audio.inputDeviceId && audioIns.length > 0) {
        updatedSettings.audio = { ...updatedSettings.audio, inputDeviceId: audioIns[0].deviceId };
        needsUpdate = true;
      }
      if (!settings.audio.outputDeviceId && audioOuts.length > 0) {
        updatedSettings.audio = { ...updatedSettings.audio, outputDeviceId: audioOuts[0].deviceId };
        needsUpdate = true;
      }
      if (!settings.video.videoDeviceId && videoIns.length > 0) {
        updatedSettings.video = { ...updatedSettings.video, videoDeviceId: videoIns[0].deviceId };
        needsUpdate = true;
      }

      if (needsUpdate) {
        handleSettingsChange(updatedSettings);
      }
    } catch (error) {
      console.error('Failed to enumerate devices:', error);
    }
  };

  useEffect(() => {
    // Get available devices without requesting permissions
    const getDevices = async () => {
      // Check if mediaDevices is available (requires HTTPS or localhost)
      if (!navigator.mediaDevices) {
        console.warn('Media devices not available. HTTPS or localhost required for WebRTC.');
        return;
      }

      try {
        // Try to get devices without permissions first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioIns = devices.filter(device => device.kind === 'audioinput');
        const audioOuts = devices.filter(device => device.kind === 'audiooutput');
        const videoIns = devices.filter(device => device.kind === 'videoinput');

        // Only update if we have actual device labels (means we have permissions)
        if (audioIns.length > 0 && audioIns[0].label) {
          setAudioInputs(audioIns);
          setAudioOutputs(audioOuts);
          setVideoInputs(videoIns);
        }
      } catch (error) {
        console.error('Failed to enumerate devices:', error);
      }
    };

    // Only get devices if the settings panel is expanded
    if (expanded || !compact) {
      // If we're expanded, request permissions and get devices
      requestPermissionsAndGetDevices();
    } else {
      // If not expanded, just try to get devices without permissions
      getDevices();
    }

    // Listen for device changes (only if mediaDevices is available)
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', getDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', getDevices);
        cleanupStreams();
      };
    } else {
      return () => {
        cleanupStreams();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, compact]);

  // Cleanup streams when panel closes
  useEffect(() => {
    if (!expanded && compact) {
      cleanupStreams();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, compact]);

  // Camera preview functionality
  const toggleCameraPreview = async () => {
    // console.log('📹 toggleCameraPreview called, current state:', isCameraPreview);

    if (isCameraPreview) {
      // Stop preview
      // console.log('📹 Stopping camera preview...');
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => {
          // console.log('📹 Stopping track:', track.kind, track.label);
          track.stop();
        });
        setCameraStream(null);
      }
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = null;
      }
      setIsCameraPreview(false);
    } else {
      // Start preview
      // console.log('📹 Starting camera preview...');
      try {
        // Build video constraints based on settings
        const getResolutionConstraints = () => resolutionConstraints(settings.video.resolution);

        const videoConstraints: any = {
          ...getResolutionConstraints(),
          frameRate: { ideal: settings.video.frameRate }
        };

        // Add device ID if specified, otherwise use facingMode
        if (settings.video.videoDeviceId) {
          videoConstraints.deviceId = { exact: settings.video.videoDeviceId };
        } else {
          videoConstraints.facingMode = settings.video.facingMode;
        }

        const constraints = {
          video: videoConstraints,
          audio: false
        };

        // console.log('📹 Requesting user media with constraints:', constraints);
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        // console.log('📹 Got stream:', stream);
        // console.log('📹 Video tracks:', stream.getVideoTracks());

        setCameraStream(stream);

        // Set stream to video element immediately
        if (videoPreviewRef.current) {
          // console.log('📹 Setting srcObject on video element');
          videoPreviewRef.current.srcObject = stream;

          // Apply mirror effect if enabled
          if (settings.video.mirror) {
            videoPreviewRef.current.style.transform = 'scaleX(-1)';
          } else {
            videoPreviewRef.current.style.transform = 'scaleX(1)';
          }

          // Try to play
          try {
            await videoPreviewRef.current.play();
            // console.log('📹 Video playing successfully');
          } catch (playErr) {
            console.error('📹 Error playing video:', playErr);
          }
        }

        setIsCameraPreview(true);
      } catch (error) {
        console.error('📹 Failed to start camera preview:', error);
        alert('Failed to access camera. Please check permissions.');
        setIsCameraPreview(false);
      }
    }
  };

  // Microphone test functionality
  const toggleMicTest = async () => {
    if (isMicTesting) {
      // Stop test
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        setMicStream(null);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setIsMicTesting(false);
      setAudioLevel(0);
      setPeakLevel(0);
    } else {
      // Start test
      try {
        const constraints = {
          audio: {
            deviceId: settings.audio.inputDeviceId ? { exact: settings.audio.inputDeviceId } : undefined,
            echoCancellation: settings.audio.echoCancellation,
            noiseSuppression: settings.audio.noiseSuppression,
            autoGainControl: settings.audio.autoGainControl,
            sampleRate: { ideal: settings.audio.sampleRate }
          }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setMicStream(stream);
        setIsMicTesting(true);

        // Set up audio analysis
        audioContextRef.current = new AudioContext();
        const source = audioContextRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
        source.connect(analyserRef.current);

        // Start monitoring audio levels
        const updateLevel = () => {
          if (analyserRef.current) {
            // Use time domain data for accurate level measurement
            const bufferLength = analyserRef.current.fftSize;
            const dataArray = new Float32Array(bufferLength);
            analyserRef.current.getFloatTimeDomainData(dataArray);

            // Calculate RMS (Root Mean Square) for accurate level
            let sum = 0;
            let peak = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const value = Math.abs(dataArray[i]);
              sum += value * value;
              peak = Math.max(peak, value);
            }
            const rms = Math.sqrt(sum / dataArray.length);

            // Convert to 0-1 range with appropriate scaling
            // RMS values typically range from 0 to ~0.7 for normal speech
            // Use peak for better visual feedback
            const scaledLevel = Math.min(1, Math.max(rms * 5, peak * 2));

            // Update peak hold
            const currentTime = Date.now();
            if (scaledLevel > peakLevel || currentTime - peakHoldTimeRef.current > 2000) {
              setPeakLevel(scaledLevel);
              peakHoldTimeRef.current = currentTime;
            }

            // Debug logging to check if audio is being detected
            if (scaledLevel > 0.01) {
              console.log('🎤 Audio detected - RMS:', rms.toFixed(4), 'Peak:', peak.toFixed(4), 'Level:', scaledLevel.toFixed(2));
            }

            setAudioLevel(scaledLevel);
            animationFrameRef.current = requestAnimationFrame(updateLevel);
          }
        };
        updateLevel();
      } catch (error) {
        console.error('Failed to start microphone test:', error);
        alert('Failed to access microphone. Please check permissions.');
      }
    }
  };

  return {
    audioInputs,
    audioOutputs,
    videoInputs,
    cameraStream,
    setCameraStream,
    audioLevel,
    peakLevel,
    isMicTesting,
    isCameraPreview,
    setIsCameraPreview,
    videoPreviewRef,
    toggleCameraPreview,
    toggleMicTest,
  };
}
