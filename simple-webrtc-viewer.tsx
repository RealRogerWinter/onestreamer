// SIMPLE WebRTCViewer - just the essential event handling
import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface SimpleWebRTCViewerProps {
  socket: Socket;
  isActive: boolean;
  className?: string;
}

const SimpleWebRTCViewer: React.FC<SimpleWebRTCViewerProps> = ({ socket, isActive, className = '' }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Simple event handling - just handle new streams
  useEffect(() => {
    if (!socket || !isActive) return;

    console.log('🔧 SIMPLE WEBRTC: Setting up simple event listener');

    const handleNewStreamer = async (data: { streamerId: string; newStreamId: string; streamType?: string; isWebRTC?: boolean }) => {
      console.log('🎬 SIMPLE WEBRTC: New streamer detected:', data);
      
      if (data.streamerId === socket.id) {
        console.log('⚠️ SIMPLE WEBRTC: Ignoring own stream');
        return;
      }

      console.log('📺 SIMPLE WEBRTC: Attempting to connect to new stream...');
      setIsLoading(true);
      setError('Connecting to stream...');

      // Simple connection attempt - try MediaSoup, if it fails, show error
      try {
        // TODO: Simple MediaSoup connection logic here
        console.log('📺 SIMPLE WEBRTC: Would attempt MediaSoup connection here');
        
        // For now, just simulate connection
        setTimeout(() => {
          setError('Stream connected (placeholder)');
          setIsLoading(false);
        }, 2000);
      } catch (error) {
        console.error('❌ SIMPLE WEBRTC: Connection failed:', error);
        setError(`Connection failed: ${error}`);
        setIsLoading(false);
      }
    };

    socket.on('new-streamer', handleNewStreamer);

    return () => {
      socket.off('new-streamer', handleNewStreamer);
    };
  }, [socket, isActive]);

  if (!isActive) {
    return <div className={`simple-webrtc-viewer ${className}`}>Viewer inactive</div>;
  }

  return (
    <div className={`simple-webrtc-viewer ${className}`}>
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%' }} />
      
      {isLoading && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
          <div>Loading stream...</div>
        </div>
      )}
      
      {error && (
        <div style={{ position: 'absolute', bottom: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: 'white', padding: '10px' }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default SimpleWebRTCViewer;