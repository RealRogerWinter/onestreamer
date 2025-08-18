import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface HLSViewerProps {
  hlsUrl: string | null;
  isActive: boolean;
  className?: string;
}

const HLSViewer: React.FC<HLSViewerProps> = ({ hlsUrl, isActive, className = '' }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hlsSupported, setHlsSupported] = useState(false);

  useEffect(() => {
    // Check HLS support
    if (Hls.isSupported()) {
      setHlsSupported(true);
      console.log('✅ HLS: HLS.js is supported');
    } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
      setHlsSupported(true);
      console.log('✅ HLS: Native HLS support detected');
    } else {
      setHlsSupported(false);
      console.error('❌ HLS: No HLS support detected');
    }
  }, []);

  useEffect(() => {
    if (!hlsUrl || !isActive || !videoRef.current || !hlsSupported) {
      cleanup();
      return;
    }

    console.log('📺 HLS: Starting HLS playback for URL:', hlsUrl);
    setIsLoading(true);
    setError(null);

    // First, try direct video playback for problematic streams
    if (hlsUrl.includes('apple.com') || hlsUrl.includes('bitmovin')) {
      console.log('📺 HLS: Using direct video playback for external stream');
      if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = `${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}${hlsUrl}`;
        videoRef.current.play().catch(e => {
          console.warn('⚠️ HLS: Direct playback failed, trying HLS.js:', e);
          tryHlsJs();
        });
        setIsLoading(false);
        return;
      } else {
        tryHlsJs();
        return;
      }
    }

    if (Hls.isSupported()) {
      tryHlsJs();
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      console.log('📺 HLS: Using native HLS support');
      videoRef.current.src = `${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}${hlsUrl}`;
      
      videoRef.current.addEventListener('loadedmetadata', () => {
        console.log('📺 HLS: Native HLS metadata loaded');
        setIsLoading(false);
      });

      videoRef.current.addEventListener('error', (e) => {
        console.error('❌ HLS: Native HLS error:', e);
        setError('Stream playback failed');
        setIsLoading(false);
      });

      videoRef.current.play().catch(e => {
        console.warn('⚠️ HLS: Native HLS autoplay failed:', e);
        setError('Click to play stream');
        setIsLoading(false);
      });
    }

    return cleanup;
  }, [hlsUrl, isActive, hlsSupported]);

  const tryHlsJs = () => {
    if (!videoRef.current) return;
    
    // Use HLS.js for browsers that support it
    const hls = new Hls({
      debug: process.env.NODE_ENV === 'development',
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      // Updated configuration using modern HLS.js options
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 20000,
          maxLoadTimeMs: 20000,
          timeoutRetry: {
            maxNumRetry: 4,
            retryDelayMs: 0,
            maxRetryDelayMs: 0
          },
          errorRetry: {
            maxNumRetry: 4,
            retryDelayMs: 1000,
            maxRetryDelayMs: 8000
          }
        }
      },
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 10000,
          timeoutRetry: {
            maxNumRetry: 2,
            retryDelayMs: 0,
            maxRetryDelayMs: 0
          },
          errorRetry: {
            maxNumRetry: 2,
            retryDelayMs: 1000,
            maxRetryDelayMs: 4000
          }
        }
      },
      // Transmuxer configuration for better format support
      forceKeyFrameOnDiscontinuity: true,
      // Stream recovery options
      startFragPrefetch: true,
      testBandwidth: false
    });

    hlsRef.current = hls;

    hls.loadSource(`${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}${hlsUrl}`);
    hls.attachMedia(videoRef.current);

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      console.log('📺 HLS: Media attached');
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('📺 HLS: Manifest parsed, starting playback');
      setIsLoading(false);
      videoRef.current?.play().catch(e => {
        console.warn('⚠️ HLS: Autoplay failed:', e);
        setError('Click to play stream');
      });
    });

    hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
      console.error('❌ HLS: Error occurred:', data);
      
      // Handle specific demuxing errors
      if (data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR) {
        console.warn('⚠️ HLS: Fragment parsing error - segment may be corrupted, skipping...');
        // Don't treat parsing errors as fatal, let HLS.js handle recovery
        return;
      }
      
      if (data.fatal) {
        setError(`Stream error: ${data.details}`);
        setIsLoading(false);
        
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.log('🔄 HLS: Fatal network error, attempting recovery...');
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log('🔄 HLS: Fatal media error, attempting recovery...');
            hls.recoverMediaError();
            break;
          default:
            console.log('❌ HLS: Unrecoverable error, destroying HLS instance');
            cleanup();
            break;
        }
      } else {
        // Non-fatal errors - log but continue
        console.warn('⚠️ HLS: Non-fatal error:', data.details);
      }
    });

    hls.on(Hls.Events.BUFFER_APPENDING, () => {
      console.log('📊 HLS: Buffer appending');
    });

    hls.on(Hls.Events.BUFFER_APPENDED, () => {
      console.log('📦 HLS: Buffer appended successfully');
    });
  }

  const cleanup = () => {
    console.log('🧹 HLS: Cleaning up HLS viewer');
    
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.src = '';
      videoRef.current.load();
    }
    
    setIsLoading(false);
    setError(null);
  };

  const handleVideoClick = () => {
    if (videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(e => {
        console.error('❌ HLS: Manual play failed:', e);
        setError('Unable to play stream');
      });
    }
  };

  if (!hlsSupported) {
    return (
      <div className={`hls-viewer ${className}`}>
        <div className="hls-error">
          <p>❌ HLS streaming is not supported in this browser</p>
          <p>Please use a modern browser with HLS support</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`hls-viewer ${className}`}>
      {isLoading && (
        <div className="hls-loading">
          <div className="loading-spinner"></div>
          <p>Loading stream...</p>
        </div>
      )}
      
      {error && (
        <div className="hls-error">
          <p>⚠️ {error}</p>
        </div>
      )}
      
      <video
        ref={videoRef}
        className="hls-video"
        controls={false}
        autoPlay
        muted
        playsInline
        onClick={handleVideoClick}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000',
          objectFit: 'cover'
        }}
      />
    </div>
  );
};

export default HLSViewer;