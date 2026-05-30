import React from 'react';

// Format inline text with markdown formatting
export const formatInlineText = (text: string): React.ReactNode => {
  const elements: React.ReactNode[] = [];
  let remaining = text;
  let keyCounter = 0;

  // Process the text sequentially to handle all markdown elements
  while (remaining.length > 0) {
    let matched = false;

    // Check for links [text](url) - check this first before bold
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const [fullMatch, linkText, url] = linkMatch;
      elements.push(
        <a key={`link-${keyCounter++}`} href={url} target="_blank" rel="noopener noreferrer">
          {linkText}
        </a>
      );
      remaining = remaining.slice(fullMatch.length);
      matched = true;
    }

    // Check for bold **text** - now properly handle nested content
    if (!matched) {
      const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
      if (boldMatch) {
        const [fullMatch, boldText] = boldMatch;
        // Recursively parse the content inside bold markers
        elements.push(<strong key={`bold-${keyCounter++}`}>{formatInlineText(boldText)}</strong>);
        remaining = remaining.slice(fullMatch.length);
        matched = true;
      }
    }

    // Check for italics *text* or _text_
    if (!matched) {
      // Check for asterisk italics (but not if it's part of bold **)
      const italicMatch = remaining.match(/^(?!\*\*)\*([^*]+?)\*(?!\*)/);
      if (italicMatch) {
        const [fullMatch, italicText] = italicMatch;
        // Recursively parse the content inside italic markers
        elements.push(<em key={`italic-${keyCounter++}`}>{formatInlineText(italicText)}</em>);
        remaining = remaining.slice(fullMatch.length);
        matched = true;
      }
    }

    // Check for underscore italics _text_
    if (!matched) {
      const underscoreMatch = remaining.match(/^_([^_]+?)_/);
      if (underscoreMatch) {
        const [fullMatch, italicText] = underscoreMatch;
        // Recursively parse the content inside italic markers
        elements.push(<em key={`italic-${keyCounter++}`}>{formatInlineText(italicText)}</em>);
        remaining = remaining.slice(fullMatch.length);
        matched = true;
      }
    }

    // Check for code `code`
    if (!matched) {
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        const [fullMatch, codeText] = codeMatch;
        // Code blocks should not have nested formatting
        elements.push(<code key={`code-${keyCounter++}`}>{codeText}</code>);
        remaining = remaining.slice(fullMatch.length);
        matched = true;
      }
    }

    // If no markdown matched, take the next character as plain text
    if (!matched) {
      // Find the next potential markdown character
      const nextSpecial = remaining.search(/[\[*_`]/);
      if (nextSpecial > 0) {
        elements.push(remaining.slice(0, nextSpecial));
        remaining = remaining.slice(nextSpecial);
      } else {
        elements.push(remaining);
        remaining = '';
      }
    }
  }

  return <>{elements}</>;
};

// Simple markdown parser for basic formatting
export const parseMarkdown = (text: string): React.ReactElement => {
  const lines = text.split('\n');
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i}>{formatInlineText(line.substring(2))}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i}>{formatInlineText(line.substring(3))}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i}>{formatInlineText(line.substring(4))}</h3>);
    } else if (line.startsWith('#### ')) {
      elements.push(<h4 key={i}>{formatInlineText(line.substring(5))}</h4>);
    }
    // List items
    else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={i}>{formatInlineText(line.substring(2))}</li>);
    }
    // Numbered list items
    else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^\d+\.\s(.*)$/);
      if (match) {
        elements.push(<li key={i}>{formatInlineText(match[1])}</li>);
      }
    }
    // Horizontal rule
    else if (line.trim() === '---') {
      elements.push(<hr key={i} />);
    }
    // Empty lines
    else if (line.trim() === '') {
      elements.push(<br key={i} />);
    }
    // Regular paragraphs
    else if (line.trim()) {
      elements.push(<p key={i}>{formatInlineText(line)}</p>);
    }
  }

  return <div>{elements}</div>;
};
