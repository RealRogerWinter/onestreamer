import React from 'react';
import { parseMarkdown } from './markdown';

interface TutorialContentProps {
  loading: boolean;
  error: string | null;
  markdown: string;
}

const TutorialContent: React.FC<TutorialContentProps> = ({ loading, error, markdown }) => (
  <div className="tutorial-content">
    {loading ? (
      <div className="tutorial-loading">Loading content...</div>
    ) : error ? (
      <div className="tutorial-error">{error}</div>
    ) : (
      <div className="tutorial-markdown">{parseMarkdown(markdown)}</div>
    )}
  </div>
);

export default TutorialContent;
