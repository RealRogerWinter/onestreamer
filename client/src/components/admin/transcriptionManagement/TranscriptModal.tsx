import React from 'react';
import { TranscriptionHistory } from './types';

interface TranscriptModalProps {
  selectedTranscript: TranscriptionHistory | null;
  onClose: () => void;
  addLog: (message: string) => void;
}

const TranscriptModal: React.FC<TranscriptModalProps> = ({
  selectedTranscript,
  onClose,
  addLog,
}) => {
  if (!selectedTranscript) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>View Transcript</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <pre className="transcript-text">
            {selectedTranscript.full_text || 'No transcript available'}
          </pre>
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={() => {
              navigator.clipboard.writeText(selectedTranscript.full_text || '');
              addLog('Transcript copied to clipboard');
            }}
          >
            Copy
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              const blob = new Blob([selectedTranscript.full_text || ''], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `transcript_${selectedTranscript.id}.txt`;
              a.click();
              URL.revokeObjectURL(url);
              addLog('Transcript downloaded');
            }}
          >
            Download
          </button>
          <button
            className="btn btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default TranscriptModal;
