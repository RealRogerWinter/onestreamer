import React from 'react';

interface LiveTranscriptionProps {
  liveTranscription: string[];
  isRecording: boolean;
  recordingTimeLeft: number;
  liveTranscriptionRef: React.RefObject<HTMLDivElement | null>;
  onClear: () => void;
  exportLiveTranscription: () => void;
  copyLiveTranscription: () => void;
}

const LiveTranscription: React.FC<LiveTranscriptionProps> = ({
  liveTranscription,
  isRecording,
  recordingTimeLeft,
  liveTranscriptionRef,
  onClear,
  exportLiveTranscription,
  copyLiveTranscription,
}) => {
  return (
    <div className="live-transcription">
      <h4>
        Live Transcription
        {isRecording && <span className="live-indicator">● Recording ({recordingTimeLeft}s)</span>}
      </h4>
      <div className="transcription-display" ref={liveTranscriptionRef}>
        {liveTranscription.length > 0 ? (
          liveTranscription.map((chunk, index) => (
            <div key={index} className="transcription-chunk">
              {chunk}
            </div>
          ))
        ) : (
          <div className="empty-state">
            No active transcription. Start a transcription to see live text here.
          </div>
        )}
      </div>
      <div className="transcription-actions">
        <button
          className="btn btn-secondary"
          onClick={onClear}
          disabled={liveTranscription.length === 0}
        >
          Clear
        </button>
        <button
          className="btn btn-secondary"
          onClick={exportLiveTranscription}
          disabled={liveTranscription.length === 0}
        >
          Export
        </button>
        <button
          className="btn btn-secondary"
          onClick={copyLiveTranscription}
          disabled={liveTranscription.length === 0}
        >
          Copy
        </button>
      </div>
    </div>
  );
};

export default LiveTranscription;
