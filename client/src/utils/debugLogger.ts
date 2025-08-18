// Centralized debug logging system with category-based filtering
interface DebugConfig {
  enabled: boolean;
  categories: {
    [key: string]: boolean;
  };
  levels: {
    [key: string]: 'verbose' | 'normal' | 'minimal' | 'off';
  };
}

// Default configuration - can be overridden via localStorage or window object
const defaultConfig: DebugConfig = {
  enabled: true, // Master switch - DEBUGGING CLICK ISSUE
  categories: {
    canvas: true, // DEBUGGING CLICK ISSUE
    effects: false,
    mediasoup: true, // Keep MediaSoup logs
    websocket: false,
    inventory: false,
    chat: false,
    auth: false,
    stream: false,
    time: false,
    session: false
  },
  levels: {
    canvas: 'verbose', // DEBUGGING CLICK ISSUE
    effects: 'off',
    mediasoup: 'normal',
    websocket: 'minimal',
    inventory: 'minimal',
    chat: 'minimal',
    auth: 'minimal',
    stream: 'normal',
    time: 'off',
    session: 'off'
  }
};

class DebugLogger {
  private config: DebugConfig;
  
  constructor() {
    this.config = this.loadConfig();
    this.exposeToWindow();
  }
  
  private loadConfig(): DebugConfig {
    try {
      const stored = localStorage.getItem('debugConfig');
      if (stored) {
        return { ...defaultConfig, ...JSON.parse(stored) };
      }
    } catch (e) {
      // Ignore localStorage errors
    }
    return defaultConfig;
  }
  
  private saveConfig() {
    try {
      localStorage.setItem('debugConfig', JSON.stringify(this.config));
    } catch (e) {
      // Ignore localStorage errors
    }
  }
  
  private exposeToWindow() {
    // Expose debug control to window for runtime configuration
    (window as any).debug = {
      enable: (category?: string) => {
        if (category) {
          this.config.categories[category] = true;
          this.config.levels[category] = 'normal';
        } else {
          this.config.enabled = true;
        }
        this.saveConfig();
        console.log(`🔧 Debug ${category ? `'${category}'` : 'all'} enabled`);
      },
      disable: (category?: string) => {
        if (category) {
          this.config.categories[category] = false;
          this.config.levels[category] = 'off';
        } else {
          this.config.enabled = false;
        }
        this.saveConfig();
        console.log(`🔧 Debug ${category ? `'${category}'` : 'all'} disabled`);
      },
      setLevel: (category: string, level: 'verbose' | 'normal' | 'minimal' | 'off') => {
        this.config.levels[category] = level;
        this.config.categories[category] = level !== 'off';
        this.saveConfig();
        console.log(`🔧 Debug '${category}' set to ${level}`);
      },
      status: () => {
        console.table(this.config.categories);
        console.table(this.config.levels);
      },
      reset: () => {
        this.config = defaultConfig;
        this.saveConfig();
        console.log('🔧 Debug config reset to defaults');
      }
    };
  }
  
  private shouldLog(category: string, level: 'verbose' | 'normal' | 'minimal' = 'normal'): boolean {
    if (!this.config.enabled && !this.config.categories[category]) {
      return false;
    }
    
    const categoryLevel = this.config.levels[category] || 'off';
    
    if (categoryLevel === 'off') return false;
    if (categoryLevel === 'verbose') return true;
    
    // For 'normal' category level, show normal and minimal messages
    if (categoryLevel === 'normal') {
      return level === 'normal' || level === 'minimal';
    }
    
    // For 'minimal' category level, only show minimal messages
    if (categoryLevel === 'minimal') {
      return level === 'minimal';
    }
    
    return false;
  }
  
  log(category: string, message: string, data?: any, level: 'verbose' | 'normal' | 'minimal' = 'normal') {
    if (this.shouldLog(category, level)) {
      const prefix = this.getPrefix(category);
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  }
  
  error(category: string, message: string, error?: any) {
    // Always log errors
    const prefix = this.getPrefix(category);
    if (error !== undefined) {
      console.error(`❌ ${prefix} ${message}`, error);
    } else {
      console.error(`❌ ${prefix} ${message}`);
    }
  }
  
  warn(category: string, message: string, data?: any) {
    if (this.shouldLog(category, 'minimal')) {
      const prefix = this.getPrefix(category);
      if (data !== undefined) {
        console.warn(`⚠️ ${prefix} ${message}`, data);
      } else {
        console.warn(`⚠️ ${prefix} ${message}`);
      }
    }
  }
  
  private getPrefix(category: string): string {
    const prefixes: { [key: string]: string } = {
      canvas: '🎨 CANVAS:',
      effects: '✨ EFFECTS:',
      mediasoup: '📡 MEDIASOUP:',
      websocket: '🔌 SOCKET:',
      inventory: '📦 INVENTORY:',
      chat: '💬 CHAT:',
      auth: '🔑 AUTH:',
      stream: '📺 STREAM:',
      time: '⏱️ TIME:',
      session: '🔗 SESSION:'
    };
    
    return prefixes[category] || `[${category.toUpperCase()}]:`;
  }
}

// Create singleton instance
const logger = new DebugLogger();

// Export convenience functions
export const debug = {
  canvas: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('canvas', message, data, level),
  effects: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('effects', message, data, level),
  mediasoup: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('mediasoup', message, data, level),
  websocket: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('websocket', message, data, level),
  inventory: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('inventory', message, data, level),
  chat: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('chat', message, data, level),
  auth: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('auth', message, data, level),
  stream: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('stream', message, data, level),
  time: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('time', message, data, level),
  session: (message: string, data?: any, level?: 'verbose' | 'normal' | 'minimal') => 
    logger.log('session', message, data, level),
  error: (category: string, message: string, error?: any) => 
    logger.error(category, message, error),
  warn: (category: string, message: string, data?: any) => 
    logger.warn(category, message, data)
};

export default logger;