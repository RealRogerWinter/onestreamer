import { useState, useEffect, useRef } from 'react';
import { useMainSocket } from '../../../contexts/SocketContext';
import authService from '../../../services/AuthService';
import {
  TranscriptionConfig,
  TranscriptionSession,
  TranscriptionHistory,
  TranscriptionStats,
} from './types';

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';

export function useTranscriptionManagement(addLog: (message: string) => void) {
  const { socket, connected } = useMainSocket();
  const [config, setConfig] = useState<TranscriptionConfig>({
    enableTranscription: false,
    autoStart: false,
    model: 'base', // Fixed to base model
    language: 'en',
    chunkDuration: 5000,
    bufferDuration: 60,
  });
  const [activeSessions, setActiveSessions] = useState<TranscriptionSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [liveTranscription, setLiveTranscription] = useState<string[]>([]);
  const [history, setHistory] = useState<TranscriptionHistory[]>([]);
  const [selectedTranscript, setSelectedTranscript] = useState<TranscriptionHistory | null>(null);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [hasActiveStream, setHasActiveStream] = useState(false);
  const [currentStreamerId, setCurrentStreamerId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTimeLeft, setRecordingTimeLeft] = useState(0);
  const [recordingTimerId, setRecordingTimerId] = useState<NodeJS.Timeout | null>(null);
  const [stats, setStats] = useState<TranscriptionStats>({
    totalWords: 0,
    activeCount: 0,
    bufferHealth: 'unknown',
  });

  const liveTranscriptionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket || !connected) return;

    // Socket is already connected via context
    addLog('Connected to transcription service');

    socket.on('transcription-started', (data: any) => {
      addLog(`Transcription started: ${data.sessionId}`);
      setCurrentSessionId(data.sessionId);
      setLiveTranscription([]);
      loadStatus();
    });

    socket.on('transcription-update', (data: any) => {
      if (data.sessionId === currentSessionId) {
        // Filter out common hallucinations
        if (data.text && data.text.trim() !== 'you' && data.text.trim() !== '') {
          // For timed recordings, show complete transcription
          if (data.complete) {
            setLiveTranscription([data.text]);
          } else {
            // For continuous transcription, show chunks
            setLiveTranscription(prev => [...prev, `[Chunk ${data.chunkNumber}] ${data.text}`]);
          }
          setStats(prev => ({
            ...prev,
            totalWords: prev.totalWords + (data.text?.split(' ').length || 0)
          }));

          // Auto-scroll to bottom
          if (liveTranscriptionRef.current) {
            liveTranscriptionRef.current.scrollTop = liveTranscriptionRef.current.scrollHeight;
          }
        }
      }
    });

    // Listen for buffer status updates
    socket.on('buffer-status', (data: any) => {
      if (data.sessionId === currentSessionId) {
        // Update buffer health based on status
        const bufferHealth = data.duration > 10 ? 'good' : data.duration > 5 ? 'warning' : 'error';
        setStats(prev => ({ ...prev, bufferHealth }));

        // Update active session buffer status
        setActiveSessions(prev => prev.map(session =>
          session.id === data.sessionId
            ? { ...session, bufferStatus: { size: data.size, duration: data.duration, isActive: true } }
            : session
        ));
      }
    });

    socket.on('transcription-stopped', (data: any) => {
      addLog(`Transcription completed: ${data.wordCount} words`);
      if (data.sessionId === currentSessionId) {
        setCurrentSessionId(null);
        setIsRecording(false);
        setRecordingTimeLeft(0);
        if (recordingTimerId) {
          clearInterval(recordingTimerId);
          setRecordingTimerId(null);
        }
      }
      loadStatus();
      loadHistory();
    });

    socket.on('stream-started', (data: any) => {
      addLog('Stream started');
      checkActiveStream();
    });

    socket.on('stream-ended', () => {
      addLog('Stream ended');
      setHasActiveStream(false);
      setCurrentStreamerId(null);
      if (currentSessionId) {
        stopTranscription();
      }
    });

    // Load initial data
    loadStatus();
    loadHistory();
    checkActiveStream();

    return () => {
      // Clean up event listeners
      socket.off('transcription-started');
      socket.off('transcription-update');
      socket.off('buffer-status');
      socket.off('transcription-stopped');
      socket.off('stream-started');
      socket.off('stream-ended');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, connected, currentSessionId]);

  const loadStatus = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/status`, {
        headers: {
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setConfig({
          enableTranscription: data.status.enabled,
          autoStart: data.status.autoStart || false,
          model: data.status.model,
          language: data.status.language,
          chunkDuration: data.status.chunkDuration || 5000,
          bufferDuration: data.status.bufferDuration || 60
        });
        setActiveSessions(data.status.activeSessions || []);
        setStats(prev => ({
          ...prev,
          activeCount: data.status.activeCount
        }));

        if (data.status.activeSessions?.length > 0) {
          setCurrentSessionId(data.status.activeSessions[0].id);
        }
      }
    } catch (error) {
      addLog(`Failed to load status: ${error}`);
    }
  };

  const loadHistory = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/transcriptions/history?limit=20`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setHistory(data.transcriptions || []);
      }
    } catch (error) {
      addLog(`Failed to load history: ${error}`);
    }
  };

  const checkActiveStream = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/stream/active`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setHasActiveStream(data.isActive);
        setCurrentStreamerId(data.streamerId);
      }
    } catch (error) {
      addLog(`Failed to check active stream: ${error}`);
    }
  };

  const applySettings = async () => {
    setIsLoading(true);
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
          enable: config.enableTranscription,
          autoStart: config.autoStart,
          model: config.model,
          language: config.language,
          chunkDuration: config.chunkDuration,
          bufferDuration: config.bufferDuration
        })
      });

      if (response.ok) {
        addLog('Transcription settings updated successfully');
        loadStatus();
      } else {
        throw new Error('Failed to update settings');
      }
    } catch (error) {
      addLog(`Failed to apply settings: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const startTranscription = async () => {
    if (!currentStreamerId) {
      addLog('No active stream to transcribe');
      return;
    }

    setIsLoading(true);
    setLiveTranscription([]);

    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/timed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
          streamerId: currentStreamerId,
          duration: config.bufferDuration,
          options: {
            model: config.model,
            language: config.language,
            chunkDuration: config.chunkDuration
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          addLog(`Recording ${config.bufferDuration}s of audio for transcription`);
          setCurrentSessionId(data.sessionId);
          setIsRecording(true);
          setRecordingTimeLeft(config.bufferDuration);

          // Start countdown timer
          const timer = setInterval(() => {
            setRecordingTimeLeft(prev => {
              if (prev <= 1) {
                clearInterval(timer);
                setIsRecording(false);
                setRecordingTimerId(null);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);

          setRecordingTimerId(timer);
        }
      } else {
        throw new Error('Failed to start transcription');
      }
    } catch (error) {
      addLog(`Failed to start transcription: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const stopTranscription = async () => {
    if (!currentSessionId) return;

    // Clear timer if running
    if (recordingTimerId) {
      clearInterval(recordingTimerId);
      setRecordingTimerId(null);
    }

    setIsLoading(true);
    setIsRecording(false);
    setRecordingTimeLeft(0);

    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/stop/${currentSessionId}`, {
        method: 'POST',
        headers: {
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        addLog('Transcription stopped');
        setCurrentSessionId(null);
        loadHistory();
      } else {
        throw new Error('Failed to stop transcription');
      }
    } catch (error) {
      addLog(`Failed to stop transcription: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const viewTranscript = async (sessionId: string) => {
    try {
      const response = await fetch(`${SERVER_URL}/api/transcription/${sessionId}`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedTranscript(data);
        setShowTranscriptModal(true);
      }
    } catch (error) {
      addLog(`Failed to load transcript: ${error}`);
    }
  };

  const exportLiveTranscription = () => {
    const text = liveTranscription.join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcription_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    addLog('Live transcription exported');
  };

  const copyLiveTranscription = () => {
    const text = liveTranscription.join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      addLog('Transcription copied to clipboard');
    });
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerId) {
        clearInterval(recordingTimerId);
      }
    };
  }, [recordingTimerId]);

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return {
    config,
    setConfig,
    currentSessionId,
    liveTranscription,
    setLiveTranscription,
    history,
    selectedTranscript,
    showTranscriptModal,
    setShowTranscriptModal,
    hasActiveStream,
    isLoading,
    isRecording,
    recordingTimeLeft,
    stats,
    liveTranscriptionRef,
    applySettings,
    startTranscription,
    stopTranscription,
    viewTranscript,
    exportLiveTranscription,
    copyLiveTranscription,
    formatDuration,
    addLog,
  };
}
