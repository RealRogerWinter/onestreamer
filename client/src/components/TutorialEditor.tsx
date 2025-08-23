import React, { useState, useEffect } from 'react';
import './TutorialEditor.css';

interface TutorialEditorProps {
  addLog: (message: string) => void;
}

type TabType = 'about' | 'support' | 'tutorial';

interface TabContent {
  about: string;
  support: string;
  tutorial: string;
}

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

// Simple markdown parser for basic formatting (same as Tutorial component)
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

const TutorialEditor: React.FC<TutorialEditorProps> = ({ addLog }) => {
  const [activeTab, setActiveTab] = useState<TabType>('tutorial');
  const [content, setContent] = useState<TabContent>({
    about: '',
    support: '',
    tutorial: ''
  });
  const [isPreview, setIsPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  useEffect(() => {
    loadTutorialContent();
  }, []);

  const loadTutorialContent = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/tutorial`);
      if (response.ok) {
        const data = await response.json();
        // Check if the data has the new structure with tabs
        if (data.tabs) {
          setContent({
            about: data.tabs.about || getDefaultAboutContent(),
            support: data.tabs.support || getDefaultSupportContent(),
            tutorial: data.tabs.tutorial || getDefaultTutorialContent()
          });
        } else {
          // Fallback to old single content format
          setContent({
            about: getDefaultAboutContent(),
            support: getDefaultSupportContent(),
            tutorial: data.content || getDefaultTutorialContent()
          });
        }
        addLog('Tutorial content loaded successfully');
      } else {
        setContent({
          about: getDefaultAboutContent(),
          support: getDefaultSupportContent(),
          tutorial: getDefaultTutorialContent()
        });
        addLog('Using default tutorial content (no saved content found)');
      }
    } catch (error) {
      console.error('Failed to load tutorial:', error);
      setContent({
        about: getDefaultAboutContent(),
        support: getDefaultSupportContent(),
        tutorial: getDefaultTutorialContent()
      });
      addLog('Failed to load tutorial content - using defaults');
    } finally {
      setLoading(false);
    }
  };

  const saveTutorialContent = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`${API_URL}/api/tutorial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tabs: content })
      });

      if (response.ok) {
        const now = new Date().toLocaleString();
        setLastSaved(now);
        addLog('Tutorial content saved successfully');
      } else {
        const errorData = await response.json();
        addLog(`Failed to save tutorial: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Failed to save tutorial:', error);
      addLog('Failed to save tutorial content');
    } finally {
      setSaving(false);
    }
  };

  const updateTabContent = (tab: TabType, value: string) => {
    setContent(prev => ({
      ...prev,
      [tab]: value
    }));
  };

  const getDefaultAboutContent = () => {
    return `# About OneStreamer

## Our Platform

OneStreamer is a cutting-edge live streaming platform that brings creators and viewers together in real-time. Built with modern web technologies, we provide a seamless streaming experience across all devices.

## Our Mission

To create an inclusive, interactive streaming community where content creators can share their passions and viewers can discover amazing content while earning rewards for participation.

## Key Features

- **Ultra-Low Latency Streaming**: Experience real-time interaction with minimal delay
- **Cross-Platform Support**: Stream from any device with a modern browser
- **Interactive Chat**: Engage with streamers and viewers in real-time
- **Rewards System**: Earn points for streaming, viewing, and participating
- **Virtual Economy**: Purchase items and effects with earned points
- **Mobile-First Design**: Optimized for both desktop and mobile experiences

## Technology Stack

- **WebRTC**: For peer-to-peer real-time communication
- **React**: Modern, responsive user interface
- **Node.js**: Scalable backend infrastructure
- **SQLite**: Reliable data persistence

## Community Guidelines

1. Be respectful to all users
2. No harassment or hate speech
3. Keep content appropriate for all audiences
4. Report violations to administrators
5. Support fellow streamers and viewers

## Version Information

- Platform Version: 2.0
- Last Updated: ${new Date().toLocaleDateString()}
- Status: Active Development

---

*Building the future of live streaming, one stream at a time.*`;
  };

  const getDefaultSupportContent = () => {
    return `# Support & Help

## Getting Help

### Contact Methods

- **In-App Support**: Contact admins through the admin panel
- **Live Chat**: Ask questions in any active stream chat
- **Email**: support@onestreamer.live
- **Discord**: Join our community server (link in profile)

## Common Issues & Solutions

### Streaming Issues

#### Camera/Microphone Not Working
1. Check browser permissions (click the lock icon in address bar)
2. Ensure no other applications are using your camera/mic
3. Try refreshing the page
4. Test with a different browser

#### Poor Stream Quality
- Check your internet connection speed
- Lower streaming quality in settings
- Close other bandwidth-intensive applications
- Try wired connection instead of WiFi

#### Stream Keeps Disconnecting
- Verify stable internet connection
- Check firewall settings
- Disable VPN if using one
- Contact your ISP if issues persist

### Viewing Issues

#### Can't See Any Streams
- Refresh the page
- Clear browser cache
- Check if JavaScript is enabled
- Try incognito/private mode

#### Audio/Video Out of Sync
- Refresh the stream
- Check your internet speed
- Try lowering quality settings

### Account Issues

#### Forgot Password
- Use the "Forgot Password" link on login page
- Check your email for reset instructions
- Contact admin if email not received

#### Points Not Updating
- Points update every 30 seconds
- Refresh page to see latest balance
- Ensure you're logged in
- Report to admin if issue persists

## System Requirements

### Minimum Requirements
- **Browser**: Chrome 80+, Firefox 75+, Safari 13+, Edge 80+
- **Internet**: 5 Mbps download, 2 Mbps upload
- **RAM**: 4GB
- **Processor**: Dual-core 2.0 GHz

### Recommended Requirements
- **Browser**: Latest version of Chrome or Firefox
- **Internet**: 25 Mbps download, 10 Mbps upload
- **RAM**: 8GB or more
- **Processor**: Quad-core 2.5 GHz or better

## Troubleshooting Steps

1. **First Steps**
   - Refresh the page (Ctrl+F5 / Cmd+Shift+R)
   - Clear browser cache and cookies
   - Try a different browser
   - Restart your device

2. **Advanced Steps**
   - Check browser console for errors (F12)
   - Disable browser extensions
   - Update graphics drivers
   - Check Windows/Mac audio settings

## Report a Bug

When reporting issues, please include:
- Browser name and version
- Operating system
- Description of the issue
- Steps to reproduce
- Screenshots if applicable
- Time when issue occurred

## Privacy & Security

- All streams are encrypted
- Personal data is protected
- No recording without permission
- Report security issues immediately

---

*Need immediate help? Contact an admin in chat!*`;
  };

  const getDefaultTutorialContent = () => {
    return `# Tutorial Guide

## Getting Started

Welcome to OneStreamer! This guide will help you get started with streaming and viewing.

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

  if (loading) {
    return (
      <div className="tutorial-editor">
        <div className="tutorial-editor-loading">Loading tutorial content...</div>
      </div>
    );
  }

  return (
    <div className="tutorial-editor">
      <div className="tutorial-editor-header">
        <h3>📚 Tutorial & Help Editor</h3>
        <div className="tutorial-editor-controls">
          <button
            className={`mode-toggle ${!isPreview ? 'active' : ''}`}
            onClick={() => setIsPreview(false)}
          >
            ✏️ Edit
          </button>
          <button
            className={`mode-toggle ${isPreview ? 'active' : ''}`}
            onClick={() => setIsPreview(true)}
          >
            👁️ Preview
          </button>
          <button
            className="save-button"
            onClick={saveTutorialContent}
            disabled={saving}
          >
            {saving ? '💾 Saving...' : '💾 Save All'}
          </button>
        </div>
      </div>

      {lastSaved && (
        <div className="last-saved">
          Last saved: {lastSaved}
        </div>
      )}

      <div className="tutorial-editor-tabs">
        <button 
          className={`tutorial-editor-tab ${activeTab === 'about' ? 'active' : ''}`}
          onClick={() => setActiveTab('about')}
        >
          About
        </button>
        <button 
          className={`tutorial-editor-tab ${activeTab === 'support' ? 'active' : ''}`}
          onClick={() => setActiveTab('support')}
        >
          Support
        </button>
        <button 
          className={`tutorial-editor-tab ${activeTab === 'tutorial' ? 'active' : ''}`}
          onClick={() => setActiveTab('tutorial')}
        >
          Tutorial
        </button>
      </div>

      <div className="tutorial-editor-content">
        {isPreview ? (
          <div className="tutorial-preview">
            {parseMarkdown(content[activeTab])}
          </div>
        ) : (
          <textarea
            className="tutorial-textarea"
            value={content[activeTab]}
            onChange={(e) => updateTabContent(activeTab, e.target.value)}
            placeholder={`Write your ${activeTab} content in Markdown format...`}
          />
        )}
      </div>

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
    </div>
  );
};

export default TutorialEditor;