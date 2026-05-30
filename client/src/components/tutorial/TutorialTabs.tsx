import React from 'react';
import { TabType } from './types';

interface TutorialTabsProps {
  activeTab: TabType;
  onSelect: (tab: TabType) => void;
}

const TABS: Array<{ id: TabType; label: string }> = [
  { id: 'about', label: 'About' },
  { id: 'support', label: 'Support' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'terms', label: 'Terms' },
  { id: 'privacy', label: 'Privacy' },
];

const TutorialTabs: React.FC<TutorialTabsProps> = ({ activeTab, onSelect }) => (
  <div className="tutorial-tabs">
    {TABS.map(tab => (
      <button
        key={tab.id}
        className={`tutorial-tab ${activeTab === tab.id ? 'active' : ''}`}
        onClick={() => onSelect(tab.id)}
      >
        {tab.label}
      </button>
    ))}
  </div>
);

export default TutorialTabs;
