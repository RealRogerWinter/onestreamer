export interface TranscriptionManagementProps {
  addLog: (message: string) => void;
}

export interface TranscriptionSession {
  id: string;
  streamerId: string;
  startTime: string;
  status: string;
  wordCount: number;
  chunkCount: number;
  bufferStatus?: {
    size: number;
    duration: number;
    isActive: boolean;
  };
}

export interface TranscriptionConfig {
  enableTranscription: boolean;
  autoStart: boolean;
  model: string;
  language: string;
  chunkDuration: number;
  bufferDuration: number;
}

export interface TranscriptionHistory {
  id: string;
  streamer_id: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  word_count: number;
  language: string;
  status: string;
  full_text?: string;
}

export interface TranscriptionStats {
  totalWords: number;
  activeCount: number;
  bufferHealth: 'good' | 'warning' | 'error' | 'unknown';
}
