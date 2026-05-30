import React from 'react';

const TutorialEditorFooter: React.FC = () => (
  <div className="tutorial-editor-footer">
    <div className="markdown-help">
      <strong>Markdown Quick Reference:</strong>
      <span># Heading 1</span>
      <span>## Heading 2</span>
      <span>**Bold**</span>
      <span>*Italic*</span>
      <span>[Link](url)</span>
      <span>`Code`</span>
      <span>- List item</span>
    </div>
  </div>
);

export default TutorialEditorFooter;
