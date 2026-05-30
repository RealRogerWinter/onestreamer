import React from 'react';

interface TutorialEditorHeaderProps {
  isPreview: boolean;
  saving: boolean;
  onSelectEdit: () => void;
  onSelectPreview: () => void;
  onSave: () => void;
}

const TutorialEditorHeader: React.FC<TutorialEditorHeaderProps> = ({
  isPreview,
  saving,
  onSelectEdit,
  onSelectPreview,
  onSave,
}) => (
  <div className="tutorial-editor-header">
    <h3>📚 Tutorial & Help Editor</h3>
    <div className="tutorial-editor-controls">
      <button
        className={`mode-toggle ${!isPreview ? 'active' : ''}`}
        onClick={onSelectEdit}
      >
        ✏️ Edit
      </button>
      <button
        className={`mode-toggle ${isPreview ? 'active' : ''}`}
        onClick={onSelectPreview}
      >
        👁️ Preview
      </button>
      <button
        className="save-button"
        onClick={onSave}
        disabled={saving}
      >
        {saving ? '💾 Saving...' : '💾 Save All'}
      </button>
    </div>
  </div>
);

export default TutorialEditorHeader;
