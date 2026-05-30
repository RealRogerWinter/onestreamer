import React from 'react';
import { VisionBotStatus } from './types';

interface PromptSectionProps {
  status: VisionBotStatus | null;
  promptDraft: string;
  promptEditing: boolean;
  onPromptDraftChange: (value: string) => void;
  onBeginEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}

const PromptSection: React.FC<PromptSectionProps> = ({
  status,
  promptDraft,
  promptEditing,
  onPromptDraftChange,
  onBeginEdit,
  onSave,
  onCancel,
}) => (
  <div className="vb-section">
    <h3>Vision prompt template</h3>
    <p className="vb-help">
      Sent to the vision model alongside the captured frame and the last
      transcription chunk. The token <code>[TRANSCRIPTION_DATA]</code> is
      replaced with the audio context at cycle time.
    </p>
    {!promptEditing ? (
      <div className="vb-prompt-display">
        <pre className="vb-prompt-text">
          {status?.config?.vision_prompt_template || '(no prompt configured)'}
        </pre>
        <button
          className="vb-btn vb-btn-secondary"
          onClick={onBeginEdit}
        >
          ✏️ Edit prompt
        </button>
      </div>
    ) : (
      <div className="vb-prompt-edit">
        <textarea
          className="vb-textarea"
          value={promptDraft}
          onChange={e => onPromptDraftChange(e.target.value)}
          rows={8}
        />
        <div className="vb-edit-actions">
          <button className="vb-btn vb-btn-primary" onClick={onSave}>
            Save
          </button>
          <button className="vb-btn vb-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    )}
  </div>
);

export default PromptSection;
