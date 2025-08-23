/**
 * Socket Debugger - Track all socket creation attempts
 */

class SocketDebugger {
  private static instance: SocketDebugger;
  private creationAttempts: any[] = [];
  private activeConnections = new Map<string, any>();

  private constructor() {
    // console.log('🔍 SocketDebugger initialized');
    (window as any).__SOCKET_DEBUGGER__ = this;
  }

  public static getInstance(): SocketDebugger {
    if (!SocketDebugger.instance) {
      SocketDebugger.instance = new SocketDebugger();
    }
    return SocketDebugger.instance;
  }

  public logCreationAttempt(type: string, url: string, stackTrace?: string) {
    const attempt = {
      type,
      url,
      timestamp: new Date().toISOString(),
      stackTrace: stackTrace || new Error().stack
    };
    
    this.creationAttempts.push(attempt);
    // console.log(`🚨 SOCKET CREATION ATTEMPT #${this.creationAttempts.length}:`, type, url);
    console.trace('Creation stack trace');
    
    // Log to window for debugging
    (window as any).__SOCKET_ATTEMPTS__ = this.creationAttempts;
  }

  public registerConnection(id: string, socket: any) {
    this.activeConnections.set(id, {
      socket,
      created: new Date().toISOString(),
      connected: socket.connected
    });
    
    // console.log(`📌 Registered connection: ${id}, Total active: ${this.activeConnections.size}`);
    (window as any).__ACTIVE_SOCKETS__ = Array.from(this.activeConnections.entries());
  }

  public getStats() {
    return {
      totalAttempts: this.creationAttempts.length,
      activeConnections: this.activeConnections.size,
      attempts: this.creationAttempts,
      connections: Array.from(this.activeConnections.entries())
    };
  }

  public reset() {
    this.creationAttempts = [];
    this.activeConnections.clear();
    // console.log('🔄 SocketDebugger reset');
  }
}

export default SocketDebugger.getInstance();