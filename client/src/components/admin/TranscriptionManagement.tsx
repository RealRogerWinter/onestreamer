import React from 'react';
import './TranscriptionManagement.css';
import { TranscriptionManagementProps } from './transcriptionManagement/types';
import { useTranscriptionManagement } from './transcriptionManagement/useTranscriptionManagement';
import StatsHeader from './transcriptionManagement/StatsHeader';
import ControlPanel from './transcriptionManagement/ControlPanel';
import LiveTranscription from './transcriptionManagement/LiveTranscription';
import HistoryTable from './transcriptionManagement/HistoryTable';
import TranscriptModal from './transcriptionManagement/TranscriptModal';

const TranscriptionManagement: React.FC<TranscriptionManagementProps> = ({ addLog }) => {
  const h = useTranscriptionManagement(addLog);

  return (
    <div className="transcription-management">
      <StatsHeader stats={h.stats} />

      <div className="transcription-grid">
        {/* Control Panel */}
        <ControlPanel
          config={h.config}
          setConfig={h.setConfig}
          hasActiveStream={h.hasActiveStream}
          isLoading={h.isLoading}
          isRecording={h.isRecording}
          recordingTimeLeft={h.recordingTimeLeft}
          currentSessionId={h.currentSessionId}
          applySettings={h.applySettings}
          startTranscription={h.startTranscription}
          stopTranscription={h.stopTranscription}
        />

        {/* Live Transcription */}
        <LiveTranscription
          liveTranscription={h.liveTranscription}
          isRecording={h.isRecording}
          recordingTimeLeft={h.recordingTimeLeft}
          liveTranscriptionRef={h.liveTranscriptionRef}
          onClear={() => h.setLiveTranscription([])}
          exportLiveTranscription={h.exportLiveTranscription}
          copyLiveTranscription={h.copyLiveTranscription}
        />
      </div>

      {/* History Table */}
      <HistoryTable
        history={h.history}
        formatDuration={h.formatDuration}
        viewTranscript={h.viewTranscript}
      />

      {/* Transcript Modal */}
      {h.showTranscriptModal && h.selectedTranscript && (
        <TranscriptModal
          selectedTranscript={h.selectedTranscript}
          onClose={() => h.setShowTranscriptModal(false)}
          addLog={addLog}
        />
      )}
    </div>
  );
};

export default TranscriptionManagement;
