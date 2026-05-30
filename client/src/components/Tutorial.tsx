import React, { useState, useEffect } from 'react';
import './Tutorial.css';
import { TabType, TutorialProps } from './tutorial/types';
import { useTutorialContent } from './tutorial/useTutorialContent';
import TutorialTabs from './tutorial/TutorialTabs';
import TutorialContent from './tutorial/TutorialContent';

const Tutorial: React.FC<TutorialProps> = ({ isOpen, onClose, defaultTab = 'tutorial' }) => {
  const [activeTab, setActiveTab] = useState<TabType>(defaultTab);
  const { content, loading, error } = useTutorialContent(isOpen);

  useEffect(() => {
    if (defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [defaultTab]);

  if (!isOpen) return null;

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-header">
          <h2>Help & Information</h2>
          <button className="tutorial-close" onClick={onClose}>×</button>
        </div>

        <TutorialTabs activeTab={activeTab} onSelect={setActiveTab} />

        <TutorialContent loading={loading} error={error} markdown={content[activeTab]} />
      </div>
    </div>
  );
};

export default Tutorial;
