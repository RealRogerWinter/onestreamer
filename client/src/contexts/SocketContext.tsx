import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import SocketManager from '../services/SocketManager';

interface SocketContextType {
  mainSocket: Socket | null;
  chatSocket: Socket | null;
  connected: boolean;
  chatConnected: boolean;
  error: string | null;
  reconnectMain: () => void;
  reconnectChat: () => void;
}

const SocketContext = createContext<SocketContextType>({
  mainSocket: null,
  chatSocket: null,
  connected: false,
  chatConnected: false,
  error: null,
  reconnectMain: () => {},
  reconnectChat: () => {}
});

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

// Convenience hooks for specific socket connections
export const useMainSocket = () => {
  const { mainSocket, connected, error } = useSocket();
  return { socket: mainSocket, connected, error };
};

export const useChatSocket = () => {
  const { chatSocket, chatConnected, error } = useSocket();
  return { socket: chatSocket, connected: chatConnected, error };
};

interface SocketProviderProps {
  children: React.ReactNode;
}

let providerInstanceCount = 0;

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [mainSocket, setMainSocket] = useState<Socket | null>(null);
  const [chatSocket, setChatSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [chatConnected, setChatConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const instanceId = React.useRef(++providerInstanceCount);
  
  React.useEffect(() => {
    console.log(`🔴 SocketProvider Instance #${instanceId.current} created`);
    return () => {
      console.log(`🟢 SocketProvider Instance #${instanceId.current} destroyed`);
    };
  }, []);

  useEffect(() => {
    console.log(`🔌 SocketContext Instance #${instanceId.current}: Initializing with SocketManager...`);
    
    // Get sockets from singleton manager
    const main = SocketManager.getMainSocket();
    const chat = SocketManager.getChatSocket();
    
    setMainSocket(main);
    setChatSocket(chat);
    
    // Setup event listeners for connection state
    const handleMainConnect = () => {
      console.log('✅ SocketContext: Main socket connected');
      setConnected(true);
      setError(null);
    };
    
    const handleMainDisconnect = () => {
      console.log('❌ SocketContext: Main socket disconnected');
      setConnected(false);
    };
    
    const handleMainError = (err: Error) => {
      console.error('❌ SocketContext: Main socket error:', err);
      setError(err.message);
    };
    
    const handleChatConnect = () => {
      console.log('✅ SocketContext: Chat socket connected');
      setChatConnected(true);
    };
    
    const handleChatDisconnect = () => {
      console.log('❌ SocketContext: Chat socket disconnected');
      setChatConnected(false);
    };
    
    // Add listeners
    main.on('connect', handleMainConnect);
    main.on('disconnect', handleMainDisconnect);
    main.on('connect_error', handleMainError);
    
    chat.on('connect', handleChatConnect);
    chat.on('disconnect', handleChatDisconnect);
    
    // Set initial connection state
    setConnected(main.connected);
    setChatConnected(chat.connected);
    
    // Cleanup listeners on unmount
    return () => {
      console.log('🔌 SocketContext: Cleaning up listeners...');
      main.off('connect', handleMainConnect);
      main.off('disconnect', handleMainDisconnect);
      main.off('connect_error', handleMainError);
      chat.off('connect', handleChatConnect);
      chat.off('disconnect', handleChatDisconnect);
      // Note: We don't disconnect sockets here - they persist via SocketManager
    };
  }, []); // Only run once on mount

  // Re-authenticate when auth token changes
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'auth_token') {
        const newToken = e.newValue;
        console.log('🔑 SocketContext: Auth token changed, updating socket auth');
        SocketManager.updateAuth(newToken);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Reconnection functions
  const reconnectMain = useCallback(() => {
    console.log('🔄 SocketContext: Manually reconnecting main socket...');
    if (mainSocket) {
      mainSocket.disconnect();
      mainSocket.connect();
    }
  }, [mainSocket]);

  const reconnectChat = useCallback(() => {
    console.log('🔄 SocketContext: Manually reconnecting chat socket...');
    if (chatSocket) {
      chatSocket.disconnect();
      chatSocket.connect();
    }
  }, [chatSocket]);

  return (
    <SocketContext.Provider value={{ 
      mainSocket, 
      chatSocket, 
      connected, 
      chatConnected, 
      error,
      reconnectMain,
      reconnectChat
    }}>
      {children}
    </SocketContext.Provider>
  );
};

export default SocketContext;