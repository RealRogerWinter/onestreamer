import React, { useState, useEffect } from 'react';
import './Tutorial.css';

interface TutorialProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'about' | 'support' | 'tutorial';

interface TabContent {
  about: string;
  support: string;
  tutorial: string;
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
  const [activeTab, setActiveTab] = useState<TabType>('tutorial');
  const [content, setContent] = useState<TabContent>({
    about: '',
    support: '',
    tutorial: ''
  });
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
      } else {
        setContent({
          about: getDefaultAboutContent(),
          support: getDefaultSupportContent(),
          tutorial: getDefaultTutorialContent()
        });
      }
    } catch (err) {
      console.error('Failed to load tutorial:', err);
      setContent({
        about: getDefaultAboutContent(),
        support: getDefaultSupportContent(),
        tutorial: getDefaultTutorialContent()
      });
    } finally {
      setLoading(false);
    }
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

### Quick Start for Viewers

1. **Join a Stream**
   - Browse active streams on the homepage
   - Click any stream thumbnail to start watching
   - Use fullscreen button for immersive experience

2. **Interact in Chat**
   - Type messages in the chat box
   - Use @username to mention someone
   - Earn points for active participation

3. **Earn & Spend Points**
   - Gain points every 30 seconds while viewing
   - Bonus points for chat activity
   - Visit the shop to purchase items

### Quick Start for Streamers

1. **Setup Your Stream**
   - Click "Start Streaming" button
   - Allow camera/microphone permissions
   - Select quality preset (recommended: High)

2. **Configure Settings**
   - Test audio levels before going live
   - Choose appropriate video quality
   - Set stream title and description

3. **Go Live**
   - Click "Start" to begin streaming
   - Monitor viewer count and chat
   - Use controls to pause/stop as needed

## Advanced Features

### Stream Quality Presets

- **Low Quality**: 480p, 15fps (low bandwidth)
- **Medium Quality**: 720p, 24fps (balanced)
- **High Quality**: 1080p, 30fps (recommended)
- **Ultra Quality**: 1080p, 60fps (high bandwidth)

### Points System Explained

#### Earning Points
- **Viewing**: 10 points/minute
- **Streaming**: 20 points/minute
- **Chat Activity**: 5 points/message (max 50/day)
- **Daily Bonus**: 100 points for first login

#### Spending Points
- **Shop Items**: 100-5000 points
- **Stream Effects**: 50-500 points
- **Username Colors**: 1000 points
- **Special Badges**: 2500 points

### Keyboard Shortcuts

- **Space**: Play/Pause stream
- **F**: Toggle fullscreen
- **M**: Mute/Unmute
- **↑/↓**: Volume control
- **C**: Toggle chat
- **S**: Screenshot (viewers only)

### Mobile Streaming Tips

1. **Orientation**: Use landscape for best quality
2. **Network**: Connect to WiFi when possible
3. **Battery**: Keep device plugged in while streaming
4. **Performance**: Close other apps for smooth streaming

### Admin Features

Admins have access to additional tools:
- User management dashboard
- Stream moderation controls
- Global announcements
- Points adjustment
- Ban/timeout users
- Tutorial content editing

## Best Practices

### For Quality Streams
1. Good lighting (face a window or light source)
2. Stable internet connection (wired preferred)
3. Clear audio (use headphones to prevent echo)
4. Engaging content and interaction

### For Growing Your Audience
1. Stream consistently
2. Interact with chat regularly
3. Create a streaming schedule
4. Collaborate with other streamers
5. Promote streams on social media

## Frequently Used Features

### Screen Sharing
1. Click "Share Screen" button
2. Select window or entire screen
3. Click "Share" to begin
4. Click "Stop Sharing" when done

### Stream Recording
- Recordings saved locally
- Click record button during stream
- Maximum 2 hours per recording
- Export as MP4 format

### Custom Overlays
- Upload PNG images for overlays
- Position and resize as needed
- Maximum 3 overlays per stream
- Transparency supported

---

*Pro Tip: Join our Discord for advanced tutorials and community events!*`;
  };

  if (!isOpen) return null;

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-header">
          <h2>Help & Information</h2>
          <button className="tutorial-close" onClick={onClose}>×</button>
        </div>
        
        <div className="tutorial-tabs">
          <button 
            className={`tutorial-tab ${activeTab === 'about' ? 'active' : ''}`}
            onClick={() => setActiveTab('about')}
          >
            About
          </button>
          <button 
            className={`tutorial-tab ${activeTab === 'support' ? 'active' : ''}`}
            onClick={() => setActiveTab('support')}
          >
            Support
          </button>
          <button 
            className={`tutorial-tab ${activeTab === 'tutorial' ? 'active' : ''}`}
            onClick={() => setActiveTab('tutorial')}
          >
            Tutorial
          </button>
        </div>
        
        <div className="tutorial-content">
          {loading ? (
            <div className="tutorial-loading">Loading content...</div>
          ) : error ? (
            <div className="tutorial-error">{error}</div>
          ) : (
            <div className="tutorial-markdown">
              {parseMarkdown(content[activeTab])}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Tutorial;