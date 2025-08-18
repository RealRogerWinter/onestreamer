import React, { useState, useEffect } from 'react';
import './Tutorial.css';

interface TutorialProps {
  isOpen: boolean;
  onClose: () => void;
}

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

// Simple markdown parser for basic formatting
const parseMarkdown = (text: string): React.ReactElement => {
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

// Format inline text with bold and code formatting
const formatInlineText = (text: string): React.ReactNode => {
  // Handle bold text **text**
  const boldFormatted = text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`bold-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
  
  // Handle code `code` - need to process each part
  const finalElements: React.ReactNode[] = [];
  boldFormatted.forEach((part, partIndex) => {
    if (typeof part === 'string') {
      const codeFormatted = part.split(/(`[^`]+`)/g).map((codePart, codeIndex) => {
        if (codePart.startsWith('`') && codePart.endsWith('`')) {
          return <code key={`code-${partIndex}-${codeIndex}`}>{codePart.slice(1, -1)}</code>;
        }
        return codePart;
      });
      finalElements.push(...codeFormatted);
    } else {
      finalElements.push(part);
    }
  });
  
  return <>{finalElements}</>;
};

const Tutorial: React.FC<TutorialProps> = ({ isOpen, onClose }) => {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadTutorialContent();
    }
  }, [isOpen]);

  const loadTutorialContent = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${API_URL}/api/tutorial`);
      if (response.ok) {
        const data = await response.json();
        setContent(data.content || getDefaultContent());
      } else {
        setContent(getDefaultContent());
      }
    } catch (err) {
      console.error('Failed to load tutorial:', err);
      setContent(getDefaultContent());
    } finally {
      setLoading(false);
    }
  };

  const getDefaultContent = () => {
    return `# Welcome to OneStreamer

## Getting Started

Welcome to OneStreamer! This platform allows you to stream, chat, and interact with other users in real-time.

### For Viewers

1. **Watching Streams**: Click on any active stream to start watching
2. **Chat**: Use the chat panel to interact with streamers and other viewers
3. **Points System**: Earn points by watching streams and participating in chat
4. **Shop**: Use your points to purchase items and effects from the shop

### For Streamers

1. **Starting a Stream**: 
   - Click the "Start Streaming" button
   - Configure your audio and video settings
   - Choose your streaming quality preferences

2. **Stream Settings**:
   - Access the Streamer Settings menu to adjust your stream
   - Test your microphone and camera before going live
   - Select from preset profiles for different streaming scenarios

3. **Managing Your Stream**:
   - Monitor viewer count in real-time
   - Interact with viewers through chat
   - Use stream controls to pause or stop streaming

### Features

#### Points & Rewards
- Earn points for streaming and viewing
- Bonus points for chat participation
- Use points in the shop for special effects and items

#### Inventory System
- Access your inventory to view purchased items
- Apply effects and buffs during streams
- Trade items with other users (coming soon)

#### Admin Tools
- Admins can access the Admin Panel for stream management
- Monitor all active streams
- Manage user accounts and permissions

### Tips & Tricks

- **Best Streaming Quality**: Use the "High Quality" preset for best results
- **Audio Issues**: Make sure to grant microphone permissions in your browser
- **Connection Problems**: Check your internet connection and try refreshing
- **Mobile Streaming**: For best results on mobile, use landscape orientation

### Need Help?

If you encounter any issues or have questions:
- Check the FAQ section below
- Contact support through the admin panel
- Report bugs in the chat

## FAQ

**Q: How do I earn points?**
A: Points are earned automatically while streaming or viewing streams. You also get bonus points for chat activity.

**Q: Can I stream from my phone?**
A: Yes! OneStreamer supports mobile streaming. Just make sure to grant camera and microphone permissions.

**Q: What are the system requirements?**
A: OneStreamer works on any modern browser with WebRTC support. Chrome, Firefox, Safari, and Edge are all supported.

**Q: How do I become an admin?**
A: Admin privileges are granted by existing administrators. Contact an admin if you need elevated permissions.

---

*Last updated: ${new Date().toLocaleDateString()}*`;
  };

  if (!isOpen) return null;

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-header">
          <h2>Tutorial & Help</h2>
          <button className="tutorial-close" onClick={onClose}>×</button>
        </div>
        
        <div className="tutorial-content">
          {loading ? (
            <div className="tutorial-loading">Loading tutorial...</div>
          ) : error ? (
            <div className="tutorial-error">{error}</div>
          ) : (
            <div className="tutorial-markdown">
              {parseMarkdown(content)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Tutorial;