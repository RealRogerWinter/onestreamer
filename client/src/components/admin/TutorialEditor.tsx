import React, { useState } from 'react';
import './TutorialEditor.css';
import { TabType, TutorialEditorProps } from './tutorialEditor/types';
import { useTutorialContent } from './tutorialEditor/useTutorialContent';
import TutorialEditorHeader from './tutorialEditor/TutorialEditorHeader';
import TutorialEditorTabs from './tutorialEditor/TutorialEditorTabs';
import TutorialEditorContent from './tutorialEditor/TutorialEditorContent';
import TutorialEditorFooter from './tutorialEditor/TutorialEditorFooter';

const TutorialEditor: React.FC<TutorialEditorProps> = ({ addLog }) => {
  const [activeTab, setActiveTab] = useState<TabType>('tutorial');
  const [isPreview, setIsPreview] = useState(false);
  const {
    content,
    loading,
    saving,
    lastSaved,
    updateTabContent,
    saveTutorialContent,
  } = useTutorialContent(addLog);

  if (loading) {
    return (
      <div className="tutorial-editor">
        <div className="tutorial-editor-loading">Loading tutorial content...</div>
      </div>
    );
  }

  return (
    <div className="tutorial-editor">
      <TutorialEditorHeader
        isPreview={isPreview}
        saving={saving}
        onSelectEdit={() => setIsPreview(false)}
        onSelectPreview={() => setIsPreview(true)}
        onSave={saveTutorialContent}
      />

      {lastSaved && (
        <div className="last-saved">
          Last saved: {lastSaved}
        </div>
      )}

      <TutorialEditorTabs activeTab={activeTab} onSelectTab={setActiveTab} />

      <TutorialEditorContent
        activeTab={activeTab}
        value={content[activeTab]}
        isPreview={isPreview}
        onChange={(value) => updateTabContent(activeTab, value)}
      />

      <TutorialEditorFooter />
    </div>
  );
};

export default TutorialEditor;
