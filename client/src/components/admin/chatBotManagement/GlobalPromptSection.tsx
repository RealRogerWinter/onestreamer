import React from 'react';

interface GlobalPromptSectionProps {
  globalPrompt: string;
  showGlobalPromptEdit: boolean;
  editedGlobalPrompt: string;
  setShowGlobalPromptEdit: (show: boolean) => void;
  setEditedGlobalPrompt: (value: string) => void;
  saveGlobalPrompt: () => void;
}

const GlobalPromptSection: React.FC<GlobalPromptSectionProps> = ({
  globalPrompt,
  showGlobalPromptEdit,
  editedGlobalPrompt,
  setShowGlobalPromptEdit,
  setEditedGlobalPrompt,
  saveGlobalPrompt,
}) => {
  return (
    <div className="global-prompt-section">
      <h3>Global Prompt (Applied to All Bots)</h3>
      {!showGlobalPromptEdit ? (
        <div className="global-prompt-display">
          <div className="prompt-text">{globalPrompt || 'No global prompt set'}</div>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditedGlobalPrompt(globalPrompt);
              setShowGlobalPromptEdit(true);
            }}
          >
            Edit Global Prompt
          </button>
        </div>
      ) : (
        <div className="global-prompt-edit">
          <textarea
            value={editedGlobalPrompt}
            onChange={(e) => setEditedGlobalPrompt(e.target.value)}
            placeholder="Enter the global prompt that will be prepended to all bot prompts..."
            rows={6}
            className="global-prompt-textarea"
          />
          <div className="edit-actions">
            <button
              className="btn btn-primary"
              onClick={saveGlobalPrompt}
            >
              Save
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowGlobalPromptEdit(false);
                setEditedGlobalPrompt(globalPrompt);
              }}
            >
              Cancel
            </button>
          </div>
          <div className="prompt-help">
            <small>
              This prompt is added to ALL bots before their individual prompts.
              Include general instructions about behavior, formatting, and chat context.
            </small>
          </div>
        </div>
      )}
    </div>
  );
};

export default GlobalPromptSection;
