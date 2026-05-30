import React from 'react';
import { TabType } from './types';
import { parseMarkdown } from './markdown';

interface TutorialEditorContentProps {
  activeTab: TabType;
  value: string;
  isPreview: boolean;
  onChange: (value: string) => void;
}

const TutorialEditorContent: React.FC<TutorialEditorContentProps> = ({
  activeTab,
  value,
  isPreview,
  onChange,
}) => (
  <div className="tutorial-editor-content">
    {isPreview ? (
      <div className="tutorial-preview">
        {parseMarkdown(value)}
      </div>
    ) : (
      <textarea
        className="tutorial-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Write your ${activeTab} content in Markdown format...`}
      />
    )}
  </div>
);

export default TutorialEditorContent;
