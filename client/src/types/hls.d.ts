declare module 'hls.js' {
  export default class Hls {
    static isSupported(): boolean;
    static version: string;
    static Events: {
      MEDIA_ATTACHED: string;
      MEDIA_DETACHED: string;
      MANIFEST_PARSED: string;
      BUFFER_APPENDING: string;
      BUFFER_APPENDED: string;
      BUFFER_EOS: string;
      BUFFER_FLUSHING: string;
      BUFFER_FLUSHED: string;
      MANIFEST_LOADING: string;
      MANIFEST_LOADED: string;
      LEVEL_LOADED: string;
      ERROR: string;
      DESTROYING: string;
    };
    static ErrorTypes: {
      NETWORK_ERROR: string;
      MEDIA_ERROR: string;
      KEY_SYSTEM_ERROR: string;
      OTHER_ERROR: string;
    };
    static ErrorDetails: {
      MANIFEST_LOAD_ERROR: string;
      MANIFEST_LOAD_TIMEOUT: string;
      MANIFEST_PARSING_ERROR: string;
      LEVEL_LOAD_ERROR: string;
      LEVEL_LOAD_TIMEOUT: string;
      LEVEL_SWITCH_ERROR: string;
      FRAG_LOAD_ERROR: string;
      FRAG_LOAD_TIMEOUT: string;
      FRAG_PARSING_ERROR: string;
      FRAG_DECRYPT_ERROR: string;
      BUFFER_APPEND_ERROR: string;
      BUFFER_APPENDING_ERROR: string;
      BUFFER_STALLED_ERROR: string;
      BUFFER_FULL_ERROR: string;
      BUFFER_SEEK_OVER_HOLE: string;
      INTERNAL_EXCEPTION: string;
    };

    constructor(config?: any);
    
    loadSource(src: string): void;
    attachMedia(media: HTMLMediaElement): void;
    detachMedia(): void;
    destroy(): void;
    startLoad(startPosition?: number): void;
    stopLoad(): void;
    recoverMediaError(): void;
    swapAudioCodec(): void;
    
    on(event: string, handler: Function): void;
    off(event: string, handler: Function): void;
    once(event: string, handler: Function): void;
    
    readonly levels: any[];
    readonly currentLevel: number;
    readonly nextLevel: number;
    readonly loadLevel: number;
    readonly nextLoadLevel: number;
    readonly firstLevel: number;
    readonly startLevel: number;
    readonly autoLevelEnabled: boolean;
    readonly autoLevelCapping: number;
    readonly maxAutoLevel: number;
    readonly minAutoLevel: number;
    
    readonly audioTracks: any[];
    readonly audioTrack: number;
    readonly subtitleTracks: any[];
    readonly subtitleTrack: number;
    readonly media: HTMLMediaElement | null;
    readonly subtitleDisplay: boolean;
    readonly lowLatencyMode: boolean;
    readonly maxBufferLength: number;
    readonly targetLatency: number | null;
    readonly drift: number | null;
    readonly forceStartLoad: boolean;
  }
}