import React from 'react';
import { TabType } from './types';

interface TutorialEditorTabsProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
}

const TutorialEditorTabs: React.FC<TutorialEditorTabsProps> = ({
  activeTab,
  onSelectTab,
}) => (
  <div className="tutorial-editor-tabs">
    <button
      className={`tutorial-editor-tab ${activeTab === 'about' ? 'active' : ''}`}
      onClick={() => onSelectTab('about')}
    >
      About
    </button>
    <button
      className={`tutorial-editor-tab ${activeTab === 'support' ? 'active' : ''}`}
      onClick={() => onSelectTab('support')}
    >
      Support
    </button>
    <button
      className={`tutorial-editor-tab ${activeTab === 'tutorial' ? 'active' : ''}`}
      onClick={() => onSelectTab('tutorial')}
    >
      Tutorial
    </button>
    <button
      className={`tutorial-editor-tab ${activeTab === 'terms' ? 'active' : ''}`}
      onClick={() => onSelectTab('terms')}
    >
      Terms
    </button>
    <button
      className={`tutorial-editor-tab ${activeTab === 'privacy' ? 'active' : ''}`}
      onClick={() => onSelectTab('privacy')}
    >
      Privacy
    </button>
  </div>
);

export default TutorialEditorTabs;
