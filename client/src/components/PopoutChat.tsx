import React, { useEffect, useState } from 'react';
import Chat from './Chat';
import '../index.css';
import './Chat.css';
import './PopoutChat.css';

// Component for the popout window content
const PopoutChatContent: React.FC = () => {
  const [chatReady, setChatReady] = useState(false);
  
  useEffect(() => {
    // Set the title of the popout window
    document.title = 'OneStreamer Chat';
    
    // Ensure body takes full viewport
    document.documentElement.style.height = '100%';
    document.documentElement.style.width = '100%';
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.body.style.height = '100%';
    document.body.style.width = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    
    // Force initialize SocketManager for the popout window
    // This ensures the singleton is created in this window context
    const initializeSockets = async () => {
      try {
        // Small delay to ensure everything is loaded
        await new Promise(resolve => setTimeout(resolve, 100));
        setChatReady(true);
      } catch (error) {
        console.error('Error initializing popout sockets:', error);
      }
    };
    
    initializeSockets();
    
    // Handle window resize
    const handleResize = () => {
      // Force a re-render on resize to ensure proper sizing
      const container = document.querySelector('.popout-chat-container') as HTMLElement;
      if (container) {
        container.style.height = `${window.innerHeight}px`;
        container.style.width = `${window.innerWidth}px`;
      }
    };
    
    // Listen for window close to notify parent
    const handleBeforeUnload = () => {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'POPOUT_CLOSED' }, '*');
      }
    };
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    // Initial size set
    handleResize();
    
    // Notify parent that popout is ready
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'POPOUT_READY' }, '*');
    }
    
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);
  
  return (
    <div className="popout-chat-container">
      {!chatReady ? (
        <div style={{ 
          color: 'white', 
          padding: '20px', 
          fontSize: '18px', 
          textAlign: 'center',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%'
        }}>
          Loading chat...
        </div>
      ) : (
        <div className="popout-chat-wrapper" style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative'
        }}>
          <style>{`
            /* Emergency override for popout chat visibility */
            .popout-chat .chat-messages {
              overflow-x: hidden !important;
              overflow-y: auto !important;
            }
            .popout-chat .chat-message {
              max-width: 100% !important;
              overflow-wrap: anywhere !important;
              word-break: break-word !important;
            }
            .popout-chat .message-text,
            .popout-chat .message-username {
              max-width: 100% !important;
              overflow-wrap: anywhere !important;
            }
          `}</style>
          <Chat className="popout-chat" />
        </div>
      )}
    </div>
  );
};


// Function to open chat in a new window
export const openPopoutChat = () => {
  // Calculate window dimensions and position
  const width = 350; // Slightly smaller default width
  const height = 600;
  const left = window.screen.width - width - 50;
  const top = 50;
  
  // Open the popout window with the current URL plus popout parameter
  const popoutUrl = `${window.location.origin}${window.location.pathname}?popout=true`;
  const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,directories=no,status=no`;
  
  const popoutWindow = window.open(popoutUrl, 'OneStreamerChat', features);
  
  // Store reference to popout window
  if (popoutWindow) {
    // Save to session storage that chat is popped out
    sessionStorage.setItem('chatPoppedOut', 'true');
    
    // Listen for messages from popout window
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'POPOUT_CLOSED') {
        sessionStorage.removeItem('chatPoppedOut');
        window.removeEventListener('message', handleMessage);
      }
    };
    
    window.addEventListener('message', handleMessage);
    
    // Focus the popout window
    popoutWindow.focus();
  }
  
  return popoutWindow;
};

export default PopoutChatContent;