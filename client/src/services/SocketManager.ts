/**
 * Singleton Socket Manager
 * Ensures only ONE instance of each socket connection exists
 */

import { io, Socket } from 'socket.io-client';
import SocketDebugger from './SocketDebugger';

// Store singleton in window to survive HMR
declare global {
  interface Window {
    __SOCKET_MANAGER_INSTANCE__?: SocketManager;
  }
}

class SocketManager {
  private static instance: SocketManager;
  private mainSocket: Socket | null = null;
  private chatSocket: Socket | null = null;
  private initialized = false;
  private creationCount = { main: 0, chat: 0 };

  private constructor() {
    console.log('🔧 SocketManager: Singleton instance created at', new Date().toISOString());
    console.trace('SocketManager constructor called from:');
    // Make it accessible globally for debugging
    (window as any).__SOCKET_MANAGER__ = this;
    (window as any).__SOCKET_CONNECTIONS__ = [];
  }

  public static getInstance(): SocketManager {
    // Check window first (survives HMR)
    if (window.__SOCKET_MANAGER_INSTANCE__) {
      console.log('♻️ SocketManager: Returning existing instance from window');
      return window.__SOCKET_MANAGER_INSTANCE__;
    }
    
    if (!SocketManager.instance) {
      console.log('🆕 SocketManager: Creating new instance');
      SocketManager.instance = new SocketManager();
      window.__SOCKET_MANAGER_INSTANCE__ = SocketManager.instance;
    }
    return SocketManager.instance;
  }

  public getMainSocket(): Socket {
    if (!this.mainSocket) {
      this.creationCount.main++;
      console.log(`🔌 SocketManager: Creating main socket connection... (Attempt #${this.creationCount.main})`);
      
      const authToken = localStorage.getItem('auth_token');
      const serverUrl = process.env.REACT_APP_SERVER_URL || 'https://onestreamer.live';
      
      SocketDebugger.logCreationAttempt('main', serverUrl);
      
      this.mainSocket = io(serverUrl, {
        timeout: 5000,
        forceNew: false,
        transports: ['websocket', 'polling'],
        auth: {
          token: authToken
        },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      this.mainSocket.on('connect', () => {
        console.log('✅ SocketManager: Main socket connected:', this.mainSocket?.id);
        SocketDebugger.registerConnection(`main-${this.mainSocket?.id}`, this.mainSocket);
        // Track connection globally
        (window as any).__SOCKET_CONNECTIONS__.push({
          type: 'main',
          id: this.mainSocket?.id,
          time: new Date().toISOString()
        });
      });

      this.mainSocket.on('disconnect', (reason) => {
        console.log('❌ SocketManager: Main socket disconnected:', reason);
      });
    } else {
      console.log('♻️ SocketManager: Reusing existing main socket:', this.mainSocket.id);
    }

    return this.mainSocket;
  }

  public getChatSocket(): Socket {
    if (!this.chatSocket) {
      this.creationCount.chat++;
      console.log(`💬 SocketManager: Creating chat socket connection... (Attempt #${this.creationCount.chat})`);
      
      const authToken = localStorage.getItem('auth_token');
      const chatServerUrl = process.env.REACT_APP_CHAT_SERVER_URL || 'https://onestreamer.live';
      
      SocketDebugger.logCreationAttempt('chat', chatServerUrl);
      console.log('🔵 CHAT: Creating socket with URL:', chatServerUrl, 'and path:', '/chat/socket.io/');
      
      this.chatSocket = io(chatServerUrl, {
        path: '/chat/socket.io/',
        timeout: 5000,
        forceNew: false,
        transports: ['websocket', 'polling'],
        auth: {
          token: authToken
        },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      this.chatSocket.on('connect', () => {
        console.log('✅ SocketManager: Chat socket connected:', this.chatSocket?.id);
        SocketDebugger.registerConnection(`chat-${this.chatSocket?.id}`, this.chatSocket);
        // Track connection globally
        (window as any).__SOCKET_CONNECTIONS__.push({
          type: 'chat',
          id: this.chatSocket?.id,
          time: new Date().toISOString()
        });
      });

      this.chatSocket.on('disconnect', (reason) => {
        console.log('❌ SocketManager: Chat socket disconnected:', reason);
      });

      this.chatSocket.on('connect_error', (error: any) => {
        console.error('❌ SocketManager: Chat socket connection error:', error.message);
        console.error('Error details:', error);
      });

      // Ensure connection is initiated
      if (!this.chatSocket.connected) {
        console.log('🔌 SocketManager: Initiating chat socket connection...');
        this.chatSocket.connect();
      }
    } else {
      console.log('♻️ SocketManager: Reusing existing chat socket:', this.chatSocket.id);
      if (!this.chatSocket.connected) {
        console.log('🔌 SocketManager: Reconnecting chat socket...');
        this.chatSocket.connect();
      }
    }

    return this.chatSocket;
  }

  public updateAuth(token: string | null): void {
    console.log('🔑 SocketManager: Updating authentication...');
    
    if (this.mainSocket) {
      this.mainSocket.disconnect();
      this.mainSocket.auth = { token };
      this.mainSocket.connect();
    }

    if (this.chatSocket) {
      this.chatSocket.disconnect();
      this.chatSocket.auth = { token };
      this.chatSocket.connect();
    }
  }

  public cleanup(): void {
    console.log('🧹 SocketManager: Cleaning up connections...');
    
    if (this.mainSocket) {
      this.mainSocket.disconnect();
      this.mainSocket = null;
    }

    if (this.chatSocket) {
      this.chatSocket.disconnect();
      this.chatSocket = null;
    }
  }
}

// Export singleton instance
export default SocketManager.getInstance();